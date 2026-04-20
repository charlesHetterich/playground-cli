/**
 * Renders one ink! contract's progress through the cdm build + deploy +
 * publish pipeline. Derives purely from `ContractRowState` so parent state
 * updates are cheap and the parent can drive several of these in sync.
 *
 * Status machine (left→right through the cdm pipeline):
 *   waiting → building → built → (cached | deploying) → registering → done
 *   at any point → error
 */

import { Row, type MarkKind } from "../../utils/ui/theme/index.js";
import type { CdmBuildEvent, CdmDeployEvent } from "../../utils/deploy/contracts.js";

export type ContractState =
    | "waiting"
    | "building"
    | "built"
    | "deploying"
    | "cached"
    | "registering"
    | "done"
    | "error";

export interface ContractRowState {
    state: ContractState;
    buildProgress?: { compiled: number; total: number };
    address?: string;
    cid?: string;
    errorMessage?: string;
}

export function ContractRow({ name, state }: { name: string; state: ContractRowState }) {
    const value = describe(state);
    const tone = state.state === "error" ? "danger" : "muted";
    return <Row mark={markFor(state.state)} label={name} value={value} tone={tone} />;
}

function markFor(state: ContractState): MarkKind {
    switch (state) {
        case "waiting":
            return "idle";
        case "building":
        case "deploying":
        case "registering":
            return "run";
        case "built":
        case "cached":
        case "done":
            return "ok";
        case "error":
            return "fail";
    }
}

function describe(state: ContractRowState): string {
    switch (state.state) {
        case "waiting":
            return "";
        case "building":
            if (state.buildProgress) {
                return `building ${state.buildProgress.compiled}/${state.buildProgress.total}`;
            }
            return "building";
        case "built":
            return "built";
        case "deploying":
            return "deploying";
        case "cached":
            return state.address ? `cached · ${shortAddress(state.address)}` : "cached";
        case "registering":
            return "registering";
        case "done": {
            const parts: string[] = [];
            if (state.address) parts.push(shortAddress(state.address));
            if (state.cid) parts.push(`CID ${shortCid(state.cid)}`);
            return parts.join(" · ") || "done";
        }
        case "error":
            return state.errorMessage ?? "failed";
    }
}

function shortAddress(addr: string): string {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function shortCid(cid: string): string {
    if (cid.length <= 12) return cid;
    return `${cid.slice(0, 8)}…${cid.slice(-4)}`;
}

// ── Event → state transitions ────────────────────────────────────────────────

/**
 * Fold a cdm `DeployEvent` into `contractRows`. Batched events (e.g. one
 * `deploy-register-done` for several crates) fan out — each crate in the
 * batch gets its own state update — so downstream rendering stays per-crate.
 */
export function applyContractEvent(
    setRows: React.Dispatch<React.SetStateAction<Record<string, ContractRowState>>>,
    event: CdmBuildEvent | CdmDeployEvent,
    queueInfo: (line: string) => void,
): void {
    if (event.type === "detect") {
        // Seed the row map with every crate cdm intends to touch so the UI
        // shows a full table from the start rather than popping rows in one
        // at a time as build/deploy events fire.
        setRows((prev) => {
            const next = { ...prev };
            for (const contract of event.contracts) {
                if (!next[contract.name]) {
                    next[contract.name] = { state: "waiting" };
                }
            }
            return next;
        });
        return;
    }

    if (event.type === "build-start") {
        setRows((p) => ({ ...p, [event.crate]: { ...p[event.crate], state: "building" } }));
        return;
    }
    if (event.type === "build-progress") {
        setRows((p) => ({
            ...p,
            [event.crate]: {
                ...p[event.crate],
                state: "building",
                buildProgress: { compiled: event.compiled, total: event.total },
            },
        }));
        return;
    }
    if (event.type === "build-done") {
        setRows((p) => ({
            ...p,
            [event.crate]: { ...p[event.crate], state: "built", buildProgress: undefined },
        }));
        return;
    }
    if (event.type === "build-error") {
        setRows((p) => ({
            ...p,
            [event.crate]: { ...p[event.crate], state: "error", errorMessage: event.error },
        }));
        queueInfo(`build ${event.crate}: ${event.error}`);
        return;
    }

    if (event.type === "check-cached") {
        setRows((p) => ({
            ...p,
            [event.crate]: { ...p[event.crate], state: "cached", address: event.address },
        }));
        return;
    }

    if (event.type === "deploy-register-start") {
        setRows((p) => {
            const next = { ...p };
            for (const crate of event.crates) {
                next[crate] = { ...next[crate], state: "deploying" };
            }
            return next;
        });
        return;
    }
    if (event.type === "deploy-register-done") {
        setRows((p) => {
            const next = { ...p };
            for (const crate of Object.keys(event.addresses)) {
                next[crate] = {
                    ...next[crate],
                    state: "registering",
                    address: event.addresses[crate],
                };
            }
            return next;
        });
        return;
    }
    if (event.type === "deploy-register-error") {
        setRows((p) => {
            const next = { ...p };
            for (const crate of event.crates) {
                next[crate] = { ...next[crate], state: "error", errorMessage: event.error };
            }
            return next;
        });
        queueInfo(`deploy: ${event.error}`);
        return;
    }

    if (event.type === "publish-start") {
        setRows((p) => {
            const next = { ...p };
            for (const crate of event.crates) {
                // Collapse registering → done once metadata upload starts;
                // finer-grained "publishing" state would show a short-lived
                // blip that adds noise more than signal.
                next[crate] = { ...next[crate], state: "registering" };
            }
            return next;
        });
        return;
    }
    if (event.type === "publish-done") {
        setRows((p) => {
            const next = { ...p };
            for (const crate of Object.keys(event.cids)) {
                next[crate] = {
                    ...next[crate],
                    state: "done",
                    cid: event.cids[crate],
                };
            }
            return next;
        });
        return;
    }

    if (event.type === "phase") {
        // Phase banners are coarse signals from cdm ("connecting-registry",
        // "checking-cache", ...) — surface them as info lines rather than
        // row-level state so the log pane picks up the transitions.
        queueInfo(`contracts: ${event.description}`);
        return;
    }

    if (event.type === "pipeline-error") {
        queueInfo(`contracts: ${event.error}`);
        return;
    }

    // Silence TS exhaustiveness — we intentionally don't react to every
    // variant (e.g. `sign-request` is already handled by our signing proxy,
    // `pipeline-done` is captured by the phase-complete event).
    const _exhaustive: unknown = event;
    void _exhaustive;
}
