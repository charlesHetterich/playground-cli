/**
 * Thin SDK wrapper around `@dotdm/contracts` for the `dot deploy` / `dot build`
 * flows. Must not import React or Ink — RevX consumes this from a WebContainer.
 *
 * Responsibilities:
 *   - Detect whether the project contains ink! contract crates at all; if not,
 *     every function here is a graceful no-op so the caller can invoke them
 *     unconditionally.
 *   - Wrap cdm's `buildContracts` / `deployContracts` so their event streams
 *     fold into our `DeployEvent` union (CDM events pass through verbatim).
 *   - Shell out to `cdm i` to refresh local `cdm.json` after fresh deploys.
 *     We intentionally shell rather than call a programmatic install — at the
 *     time of writing `@dotdm/cdm` does not expose an install() entry point.
 */

import { spawn } from "node:child_process";
import {
    buildContracts,
    deployContracts,
    detectDeploymentOrderLayered,
    REGISTRY_ADDRESS,
    type BuildEvent as CdmBuildEvent,
    type BuildSummary,
    type DeployEvent as CdmDeployEvent,
    type DeploySummary,
    type PipelineChainClient,
} from "@dotdm/contracts";
import type { PolkadotSigner } from "polkadot-api";
import type { HexString, SS58String } from "polkadot-api";

export type { CdmBuildEvent, CdmDeployEvent, BuildSummary, DeploySummary };

// ── Detection ────────────────────────────────────────────────────────────────

export interface ContractsPlan {
    /** Crate names detected, in topological order (inner arrays = a layer). */
    layers: string[][];
    /** Flat list of crate names. */
    crates: string[];
}

/**
 * Ask cdm whether `rootDir` has any ink! contract crates. Returns null when
 * there are none so callers can cleanly skip the entire contracts phase.
 *
 * cdm's `detectContracts` is synchronous file-system walking and quick enough
 * to call twice (here for gating, and again inside `buildContracts` /
 * `deployContracts` where it also runs) — the duplication costs nothing.
 */
export function planContracts(rootDir: string): ContractsPlan | null {
    try {
        const { layers } = detectDeploymentOrderLayered(rootDir);
        const crates = layers.flat();
        if (crates.length === 0) return null;
        return { layers, crates };
    } catch {
        // Any detection error (missing Cargo.toml, unreadable crate, etc.) is
        // treated as "no contracts here" — the caller skips the phase and we
        // don't block an otherwise-fine frontend deploy.
        return null;
    }
}

// ── Build ────────────────────────────────────────────────────────────────────

export interface RunContractBuildOptions {
    rootDir: string;
    /** Optional crate filter; undefined = build every detected contract. */
    contracts?: string[];
    onEvent: (event: CdmBuildEvent) => void;
}

export async function runContractBuild(opts: RunContractBuildOptions): Promise<BuildSummary> {
    return buildContracts({
        rootDir: opts.rootDir,
        contracts: opts.contracts,
        onEvent: opts.onEvent,
    });
}

// ── Deploy ───────────────────────────────────────────────────────────────────

export interface RunContractDeployOptions {
    rootDir: string;
    contracts?: string[];
    client: PipelineChainClient;
    signer: PolkadotSigner;
    origin: SS58String;
    /**
     * Address of the on-chain `ContractRegistry` cdm writes package metadata
     * into. Defaults to the canonical deployment in `@dotdm/utils` — no one
     * outside the cdm maintainers should need to override this.
     */
    registryAddress?: HexString;
    onEvent: (event: CdmDeployEvent) => void;
}

export async function runContractDeploy(opts: RunContractDeployOptions): Promise<DeploySummary> {
    return deployContracts({
        rootDir: opts.rootDir,
        contracts: opts.contracts,
        client: opts.client,
        signer: opts.signer,
        origin: opts.origin,
        registryAddress: (opts.registryAddress ?? REGISTRY_ADDRESS) as HexString,
        onEvent: opts.onEvent,
    });
}

// ── cdm install shell-out ────────────────────────────────────────────────────

export interface RunCdmInstallOptions {
    cwd: string;
    /**
     * cdm package names of contracts that were freshly deployed this run.
     * When empty the install is skipped — nothing changed on-chain so our
     * local `cdm.json` is already current.
     */
    packages: string[];
    onLine: (line: string) => void;
}

/**
 * Refresh a project's `cdm.json` to pin whatever the ContractRegistry now
 * reports for each given package. Runs `cdm i @pkg1 @pkg2 ...` in `cwd`.
 *
 * We shell out because `@dotdm/cdm` does not currently expose an install
 * function. If that changes we swap this for a direct import and drop the
 * `cdm` binary dependency on the host.
 */
export async function runCdmInstall(opts: RunCdmInstallOptions): Promise<void> {
    if (opts.packages.length === 0) return;

    await new Promise<void>((resolve, reject) => {
        const proc = spawn("cdm", ["i", ...opts.packages], {
            cwd: opts.cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const onData = (buf: Buffer) => {
            for (const line of buf.toString("utf8").split(/\r?\n/)) {
                if (line.length > 0) opts.onLine(line);
            }
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);

        proc.on("error", (err) => {
            reject(
                new Error(`Could not run \`cdm\` — is it installed and on PATH? (${err.message})`, {
                    cause: err,
                }),
            );
        });
        proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`\`cdm i\` exited with code ${code}`));
        });
    });
}

// ── Summary helpers ──────────────────────────────────────────────────────────

/**
 * Extract the list of cdm packages that actually touched the chain this run
 * (`status === "done"`). `cached` entries are unchanged so there's nothing to
 * re-install for them.
 */
export function freshlyDeployedPackages(summary: DeploySummary): string[] {
    return summary.contracts
        .filter((c) => c.status === "done" && c.cdmPackage)
        .map((c) => c.cdmPackage as string);
}
