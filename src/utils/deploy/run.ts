/**
 * Orchestrator for the full `dot deploy` flow.
 *
 * The function is deliberately pure-ish: it takes an already-resolved signer,
 * emits a typed event stream, and leaves UI concerns (Ink, spinners) to the
 * caller. RevX can import this module in a WebContainer and drive its own UI
 * off the same events.
 */

import { runBuild, loadDetectInput, detectBuildConfig, type BuildConfig } from "../build/index.js";
import { runStorageDeploy } from "./storage.js";
import { publishToPlayground, normalizeDomain } from "./playground.js";
import { resolveSignerSetup, type SignerMode, type DeployApproval } from "./signerMode.js";
import {
    wrapSignerWithEvents,
    createSigningCounter,
    type SigningCounter,
    type SigningEvent,
} from "./signingProxy.js";
import {
    planContracts,
    runContractDeploy,
    runCdmInstall,
    freshlyDeployedPackages,
    type CdmDeployEvent,
    type ContractsPlan,
} from "./contracts.js";
import { createDevSigner } from "@polkadot-apps/tx";
import { ss58Encode } from "@polkadot-apps/address";
import type { DeployLogEvent } from "./progress.js";
import type { ResolvedSigner } from "../signer.js";
import type { Env } from "../../config.js";
import type { DeployPlan } from "./availability.js";
import { getConnection } from "../connection.js";

// ── Events ───────────────────────────────────────────────────────────────────

export type DeployPhase =
    | "contracts"
    | "cdm-install"
    | "build"
    | "storage-and-dotns"
    | "playground"
    | "done";

export type DeployEvent =
    | { kind: "plan"; approvals: DeployApproval[]; contractLayers: string[][] }
    | { kind: "phase-start"; phase: DeployPhase }
    | { kind: "phase-complete"; phase: DeployPhase }
    | { kind: "phase-skipped"; phase: DeployPhase; reason: string }
    | { kind: "contracts-event"; event: CdmDeployEvent }
    | { kind: "cdm-install-log"; line: string }
    | { kind: "build-log"; line: string }
    | { kind: "build-detected"; config: BuildConfig }
    | { kind: "storage-event"; event: DeployLogEvent }
    | { kind: "signing"; event: SigningEvent }
    | { kind: "error"; phase: DeployPhase; message: string };

// ── Inputs & outputs ─────────────────────────────────────────────────────────

export interface RunDeployOptions {
    /** Project root — where the build runs. */
    projectDir: string;
    /** Relative path inside `projectDir` that holds the built artifacts. */
    buildDir: string;
    /** Skip the build step (e.g. if the caller already built). */
    skipBuild?: boolean;
    /** DotNS label (with or without `.dot`). */
    domain: string;
    /** Signer mode — `dev` uses bulletin-deploy defaults, `phone` uses the user's session. */
    mode: SignerMode;
    /** Whether to publish to the playground registry after DotNS succeeds. */
    publishToPlayground: boolean;
    /** The logged-in phone signer. Required for `mode === "phone"` or `publishToPlayground`. */
    userSigner: ResolvedSigner | null;
    /** Event sink — consumed by the TUI / RevX. */
    onEvent: (event: DeployEvent) => void;
    /** Target environment. Defaults to `testnet`. */
    env?: Env;
    /**
     * DotNS plan from the availability check — shapes the approvals list.
     * Optional; the signing counter falls back to "register, no PoP upgrade"
     * (3 DotNS taps) if absent and auto-corrects at runtime.
     */
    plan?: DeployPlan;
}

export interface DeployOutcome {
    /** Canonical `<label>.dot` string. */
    fullDomain: string;
    /** Bulletin storage CID of the app bundle. */
    appCid: string;
    /** IPFS CID of the directory root, if bulletin-deploy computed one. */
    ipfsCid?: string;
    /** Metadata CID when `publishToPlayground` was true. */
    metadataCid?: string;
    /** Approvals the user actually went through, useful for final summary. */
    approvalsRequested: DeployApproval[];
    /** URL the user can visit to view their deployed app. */
    appUrl: string;
    /**
     * cdm packages that were freshly deployed this run (i.e. not cached from a
     * prior deploy). Consumers can use this for summary UI; runDeploy has
     * already refreshed the project's `cdm.json` via `cdm i` for them.
     */
    freshContractPackages?: string[];
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function runDeploy(options: RunDeployOptions): Promise<DeployOutcome> {
    const { label, fullDomain } = normalizeDomain(options.domain);

    // Scan for contracts up-front so the approvals list can include them in
    // the right slot before we render the summary card / phone counter.
    const contractsPlan: ContractsPlan | null = planContracts(options.projectDir);

    const setup = resolveSignerSetup({
        mode: options.mode,
        userSigner: options.userSigner,
        publishToPlayground: options.publishToPlayground,
        plan: options.plan,
        contractLayers: contractsPlan?.layers,
    });

    options.onEvent({
        kind: "plan",
        approvals: setup.approvals,
        contractLayers: contractsPlan?.layers ?? [],
    });

    const counter = createSigningCounter(setup.approvals.length);

    // ── Contracts ────────────────────────────────────────────────────────
    // Runs BEFORE the frontend build so the build can read fresh addresses
    // from `cdm.json` (updated by `cdm i` further down). No-op when the
    // project has no ink! contracts.
    //
    // FIXME(mobile-signer-contracts): Revive.instantiate_with_code ships the
    // PVM bytecode inline (~100 KB), which exceeds the host-terminal session
    // transport's message-size limit ("message too big" from the mobile app).
    // Until @polkadot-apps/terminal lifts that cap, we sign contract deploys
    // with a local Alice dev signer. The phone signer is still used for
    // DotNS + playground publish below, so app ownership still records under
    // the user's address — only the on-chain contract addresses / registry
    // entries will record Alice as the deployer.
    //
    // To revert: (1) gate this block on `options.mode === "phone" &&
    // options.userSigner`, (2) swap `createDevSigner("Alice")` for the
    // user's signer wrapped via `wrapSignerWithLabeledSteps(...)` from
    // signingProxy.ts — pass `setup.approvals.filter(a => a.phase ===
    // "contracts").map(a => a.label)` as labels, and (3) re-enable the
    // matching `approvals.push(...contractsApprovals(...))` in signerMode.ts.
    let freshContractPackages: string[] | undefined;
    if (contractsPlan) {
        options.onEvent({ kind: "phase-start", phase: "contracts" });
        try {
            const client = await getConnection();
            const aliceSigner = createDevSigner("Alice");
            const aliceAddress = ss58Encode(aliceSigner.publicKey);
            const summary = await runContractDeploy({
                rootDir: options.projectDir,
                client,
                signer: aliceSigner,
                origin: aliceAddress,
                onEvent: (event) => options.onEvent({ kind: "contracts-event", event }),
            });
            freshContractPackages = freshlyDeployedPackages(summary);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            options.onEvent({ kind: "error", phase: "contracts", message });
            throw err;
        }
        options.onEvent({ kind: "phase-complete", phase: "contracts" });

        // ── cdm install (refresh cdm.json with fresh addresses) ──────
        if (freshContractPackages && freshContractPackages.length > 0) {
            options.onEvent({ kind: "phase-start", phase: "cdm-install" });
            try {
                await runCdmInstall({
                    cwd: options.projectDir,
                    packages: freshContractPackages,
                    onLine: (line) => options.onEvent({ kind: "cdm-install-log", line }),
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                options.onEvent({ kind: "error", phase: "cdm-install", message });
                throw err;
            }
            options.onEvent({ kind: "phase-complete", phase: "cdm-install" });
        } else {
            options.onEvent({
                kind: "phase-skipped",
                phase: "cdm-install",
                reason: "all contracts already up-to-date",
            });
        }
    }

    // ── Build ────────────────────────────────────────────────────────────
    const buildAbs = options.buildDir;
    if (!options.skipBuild) {
        options.onEvent({ kind: "phase-start", phase: "build" });
        try {
            const config = detectBuildConfig(loadDetectInput(options.projectDir));
            options.onEvent({ kind: "build-detected", config });
            await runBuild({
                cwd: options.projectDir,
                config,
                onData: (line) => options.onEvent({ kind: "build-log", line }),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            options.onEvent({ kind: "error", phase: "build", message });
            throw err;
        }
        options.onEvent({ kind: "phase-complete", phase: "build" });
    }

    // ── Storage + DotNS via bulletin-deploy ──────────────────────────────
    options.onEvent({ kind: "phase-start", phase: "storage-and-dotns" });

    const storageAuth = maybeWrapAuthForSigning(
        setup.bulletinDeployAuthOptions,
        options,
        counter,
        setup.approvals,
    );

    let storageResult;
    try {
        storageResult = await runStorageDeploy({
            content: buildAbs,
            domainName: label,
            auth: storageAuth,
            onLogEvent: (event) => options.onEvent({ kind: "storage-event", event }),
            env: options.env,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.onEvent({ kind: "error", phase: "storage-and-dotns", message });
        throw err;
    }
    options.onEvent({ kind: "phase-complete", phase: "storage-and-dotns" });

    // ── Playground publish ───────────────────────────────────────────────
    let metadataCid: string | undefined;
    if (setup.publishSigner) {
        options.onEvent({ kind: "phase-start", phase: "playground" });
        const wrappedPublishSigner = wrapResolvedSigner(
            setup.publishSigner,
            "Publish to Playground registry",
            counter,
            (event) => options.onEvent({ kind: "signing", event }),
        );

        try {
            const pub = await publishToPlayground({
                domain: fullDomain,
                publishSigner: wrappedPublishSigner,
                cwd: options.projectDir,
                onLogEvent: (event) => options.onEvent({ kind: "storage-event", event }),
                env: options.env,
            });
            metadataCid = pub.metadataCid;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            options.onEvent({ kind: "error", phase: "playground", message });
            throw err;
        }
        options.onEvent({ kind: "phase-complete", phase: "playground" });
    }

    const appUrl = buildAppUrl(fullDomain, options.env);
    const outcome: DeployOutcome = {
        fullDomain,
        appCid: storageResult.cid,
        ipfsCid: storageResult.ipfsCid,
        metadataCid,
        approvalsRequested: setup.approvals,
        appUrl,
        freshContractPackages,
    };
    options.onEvent({ kind: "phase-complete", phase: "done" });
    return outcome;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * When bulletin-deploy is about to use the user's phone signer for DotNS, wrap
 * it so each `signTx` call surfaces a lifecycle event with the right label.
 *
 * Labels are pulled from the DotNS-phase entries of `setup.approvals`, in
 * order. `resolveSignerSetup` built that list to match bulletin-deploy's
 * actual on-chain call sequence (including the optional `setUserPopStatus`
 * at the start when a PoP upgrade is needed), so `seen === N` → phone shows
 * the Nth entry. If bulletin-deploy ever fires *more* sigs than approvals
 * anticipated, we fall back to the last known label — better than emitting
 * a bogus index — and `createSigningCounter` simultaneously extends `total`
 * so the TUI shows "step N of N" instead of "N of N-1".
 */
function maybeWrapAuthForSigning(
    auth: ReturnType<typeof resolveSignerSetup>["bulletinDeployAuthOptions"],
    options: RunDeployOptions,
    counter: SigningCounter,
    approvals: DeployApproval[],
) {
    if (!auth.signer || !auth.signerAddress) return auth;

    const labels = approvals.filter((a) => a.phase === "dotns").map((a) => a.label);
    const fallbackLabel = labels[labels.length - 1] ?? "DotNS step";
    let seen = 0;
    const wrapped = {
        publicKey: auth.signer.publicKey,
        signTx: (...args: Parameters<typeof auth.signer.signTx>) => {
            const label = labels[seen] ?? fallbackLabel;
            seen += 1;
            const proxy = wrapSignerWithEvents(auth.signer!, {
                label,
                counter,
                onEvent: (event) => options.onEvent({ kind: "signing", event }),
            });
            return proxy.signTx(...args);
        },
        signBytes: (...args: Parameters<typeof auth.signer.signBytes>) => {
            const proxy = wrapSignerWithEvents(auth.signer!, {
                label: "DotNS signBytes",
                counter,
                onEvent: (event) => options.onEvent({ kind: "signing", event }),
            });
            return proxy.signBytes(...args);
        },
    };

    return { ...auth, signer: wrapped };
}

function wrapResolvedSigner(
    resolved: ResolvedSigner,
    label: string,
    counter: SigningCounter,
    onEvent: (event: SigningEvent) => void,
): ResolvedSigner {
    return {
        ...resolved,
        signer: wrapSignerWithEvents(resolved.signer, { label, counter, onEvent }),
    };
}

function buildAppUrl(fullDomain: string, _env: Env | undefined): string {
    // Today's dot.li viewer handles both testnet and mainnet; revisit once a
    // dedicated mainnet viewer domain is announced.
    return `https://${fullDomain}.li`;
}
