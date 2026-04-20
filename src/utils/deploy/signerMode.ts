/**
 * Resolves *which* signer is used for each on-chain step of a deploy. This
 * is the only module that knows the full matrix; everywhere else receives
 * already-composed objects so a future mainnet profile can swap in without
 * rewriting callers.
 *
 * Today (testnet):
 *   - Dev mode: bulletin-deploy uses its built-in default mnemonic for
 *     storage AND DotNS. Playground publish (if enabled) still uses the
 *     user's phone signer so myApps ownership lands on the correct address.
 *   - Phone mode: bulletin-deploy uses the user's phone signer for DotNS
 *     (3 taps). Storage always uses the bulletin-deploy pool mnemonic.
 *     Playground publish uses the user's phone signer (1 more tap).
 */

import type { DeployOptions } from "bulletin-deploy";
import type { ResolvedSigner } from "../signer.js";
import type { DeployPlan } from "./availability.js";

export type SignerMode = "dev" | "phone";

export interface DeploySignerSetup {
    /**
     * Options to pass to bulletin-deploy's `deploy()`. For dev mode this is
     * empty (bulletin-deploy falls back to its env / DEFAULT_MNEMONIC); for
     * phone mode we inject the user's signer so DotNS registration is paid
     * for by — and recorded against — their account.
     */
    bulletinDeployAuthOptions: Pick<DeployOptions, "signer" | "signerAddress" | "mnemonic">;

    /**
     * Signer used to call `registry.publish()` for the playground step. This
     * is always the user's phone signer (when available) because the contract
     * records `env::caller()` as the owner — that's what drives the myApps
     * view. `null` means we cannot publish (dev mode without a phone session).
     */
    publishSigner: ResolvedSigner | null;

    /**
     * Count of phone approvals the user should expect under this setup,
     * broken down by phase. Used to render the summary card.
     */
    approvals: DeployApproval[];
}

export interface DeployApproval {
    phase: "contracts" | "dotns" | "playground";
    label: string;
}

export interface ResolveOptions {
    mode: SignerMode;
    /** The user's phone (or --suri) signer, or null if not logged in. */
    userSigner: ResolvedSigner | null;
    /** Whether `--playground` / the prompt enabled playground publish. */
    publishToPlayground: boolean;
    /**
     * Known DotNS plan from the availability check. Shapes the approvals list
     * to match what bulletin-deploy will actually submit. Absent = we haven't
     * run the check yet, so assume the most common path (new register, no
     * PoP upgrade, 3 DotNS taps). The signing counter clamps up at runtime if
     * we under-estimated, so users never see "step 5 of 4" even on this path.
     */
    plan?: DeployPlan;
    /**
     * Dependency-sorted layers of ink! contract crates that will be deployed
     * before the frontend upload. Each layer corresponds to two phone taps —
     * one combined deploy+register batch on AssetHub and one publish batch on
     * Bulletin — plus an optional Bulletin-side metadata upload. Omit when the
     * project has no contracts.
     */
    contractLayers?: string[][];
}

/**
 * DotNS approvals in the exact order bulletin-deploy will fire them. Order
 * matters because `maybeWrapAuthForSigning` in run.ts labels each incoming
 * `signTx` call by its index in this list — the Nth `signTx` is labelled
 * with the Nth entry here, so a mismatch ends up showing "Finalize domain"
 * on the phone when the app is actually asking for commitment.
 */
function dotnsApprovals(plan: DeployPlan | undefined): DeployApproval[] {
    // Default to the most common path when the caller hasn't told us the
    // plan yet. Counter will self-correct if we under-estimated.
    const effective: DeployPlan = plan ?? { action: "register", needsPopUpgrade: false };

    if (effective.action === "update") {
        // Domain already owned by the signer — bulletin-deploy skips
        // `register()` entirely (no commitment, no finalize, no PoP grant)
        // and jumps straight to `setContenthash`. So only one tap.
        return [{ phase: "dotns", label: "Link content (DotNS setContenthash)" }];
    }

    const approvals: DeployApproval[] = [];
    if (effective.needsPopUpgrade) {
        // `register()` submits `setUserPopStatus` first whenever the predicted
        // post-grant status differs from the user's current one. Without this
        // entry the counter previously ran one past total ("step 5 of 4") for
        // any PoP-gated name.
        approvals.push({ phase: "dotns", label: "Grant Proof of Personhood" });
    }
    approvals.push(
        { phase: "dotns", label: "Reserve domain (DotNS commitment)" },
        { phase: "dotns", label: "Finalize domain (DotNS register)" },
        { phase: "dotns", label: "Link content (DotNS setContenthash)" },
    );
    return approvals;
}

/**
 * Per-layer contract approvals in cdm's firing order. Each layer is one
 * deploy+register batch on AssetHub (combined via `Utility.batch_all`) and one
 * publish batch on Bulletin — two taps per layer regardless of contract count,
 * which is exactly what keeps mobile-signed deploys tractable for apps with
 * more than a couple of contracts.
 */
function contractsApprovals(layers: string[][] | undefined): DeployApproval[] {
    if (!layers || layers.length === 0) return [];
    const approvals: DeployApproval[] = [];
    layers.forEach((layer, idx) => {
        const layerLabel = layers.length > 1 ? ` (layer ${idx + 1}/${layers.length})` : "";
        const preview = summarizeCrates(layer);
        approvals.push(
            {
                phase: "contracts",
                label: `Deploy + register contracts${layerLabel}: ${preview}`,
            },
            {
                phase: "contracts",
                label: `Publish metadata${layerLabel}: ${preview}`,
            },
        );
    });
    return approvals;
}

function summarizeCrates(crates: string[]): string {
    if (crates.length <= 3) return crates.join(", ");
    return `${crates.slice(0, 3).join(", ")} +${crates.length - 3} more`;
}

export function resolveSignerSetup(opts: ResolveOptions): DeploySignerSetup {
    const approvals: DeployApproval[] = [];

    let bulletinDeployAuthOptions: DeploySignerSetup["bulletinDeployAuthOptions"] = {};

    // FIXME(mobile-signer-contracts): contract deploys currently use a local
    // Alice dev signer (see runDeploy in run.ts) because the host-terminal
    // transport caps message size below the PVM bytecode payload. Once that
    // limit is lifted, restore `approvals.push(...contractsApprovals(...))`
    // here and thread the phone signer back through runContractDeploy.
    void opts.contractLayers;
    void contractsApprovals;

    if (opts.mode === "phone") {
        if (!opts.userSigner) {
            throw new Error(
                'Phone signer requested but no session found. Run "dot init" to log in, or pass --signer dev.',
            );
        }
        bulletinDeployAuthOptions = {
            signer: opts.userSigner.signer,
            signerAddress: opts.userSigner.address,
        };
        approvals.push(...dotnsApprovals(opts.plan));
    }

    // Playground publish always uses the user's signer so ownership ties to
    // their address — otherwise the registry would record a shared dev key
    // and the myApps view would be useless.
    let publishSigner: ResolvedSigner | null = null;
    if (opts.publishToPlayground) {
        if (!opts.userSigner) {
            throw new Error(
                'Publishing to Playground requires a logged-in account. Run "dot init" first, or drop --playground.',
            );
        }
        publishSigner = opts.userSigner;
        approvals.push({ phase: "playground", label: "Publish to Playground registry" });
    }

    return { bulletinDeployAuthOptions, publishSigner, approvals };
}
