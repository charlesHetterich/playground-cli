import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
    Header,
    Row,
    Section,
    Hint,
    Callout,
    Sparkline,
    Select,
    Input,
    setWindowTitle,
    type MarkKind,
} from "../../utils/ui/theme/index.js";
import {
    runDeploy,
    resolveSignerSetup,
    checkDomainAvailability,
    formatAvailability,
    type AvailabilityResult,
    type DeployEvent,
    type DeployOutcome,
    type DeployPhase,
    type DeployPlan,
    type SignerMode,
    type DeployApproval,
    type SigningEvent,
} from "../../utils/deploy/index.js";
import { buildSummaryView } from "./summary.js";
import { ContractRow, applyContractEvent, type ContractRowState } from "./ContractRow.js";
import type { ResolvedSigner } from "../../utils/signer.js";
import { DEFAULT_BUILD_DIR } from "../../config.js";
import { VERSION_LABEL } from "../../utils/version.js";

export interface DeployScreenInputs {
    projectDir: string;
    domain: string | null;
    buildDir: string | null;
    mode: SignerMode | null;
    publishToPlayground: boolean | null;
    userSigner: ResolvedSigner | null;
    onDone: (outcome: DeployOutcome | null) => void;
}

type Stage =
    | { kind: "prompt-signer" }
    | { kind: "prompt-buildDir" }
    | { kind: "prompt-domain" }
    | { kind: "validate-domain"; domain: string }
    | { kind: "prompt-publish" }
    | { kind: "confirm" }
    | { kind: "running" }
    | { kind: "done"; outcome: DeployOutcome }
    | { kind: "error"; message: string };

interface Resolved {
    mode: SignerMode;
    buildDir: string;
    domain: string;
    publishToPlayground: boolean;
}

export function DeployScreen({
    projectDir,
    domain: initialDomain,
    buildDir: initialBuildDir,
    mode: initialMode,
    publishToPlayground: initialPublish,
    userSigner,
    onDone,
}: DeployScreenInputs) {
    const [mode, setMode] = useState<SignerMode | null>(initialMode);
    const [buildDir, setBuildDir] = useState<string | null>(initialBuildDir);
    const [domain, setDomain] = useState<string | null>(initialDomain);
    const [publishToPlayground, setPublishToPlayground] = useState<boolean | null>(initialPublish);
    const [domainError, setDomainError] = useState<string | null>(null);
    // Captured from the availability check; feeds `resolveSignerSetup` so
    // the summary card shows the correct phone-approval count (register +
    // PoP upgrade = 4 DotNS taps, vs register alone = 3, vs update = 1).
    const [plan, setPlan] = useState<DeployPlan | null>(null);
    const [stage, setStage] = useState<Stage>(() =>
        pickInitialStage(initialMode, initialBuildDir, initialDomain, initialPublish),
    );

    // Passed down to RunningStage; read back on completion for the sparkline.
    // Ref instead of state so the high-frequency chunk-progress stream doesn't
    // force re-renders of the whole DeployScreen.
    const finalChunkTimingsRef = useRef<number[]>([]);

    const advance = (
        nextMode: SignerMode | null = mode,
        nextBuildDir: string | null = buildDir,
        nextDomain: string | null = domain,
        nextPublish: boolean | null = publishToPlayground,
    ) => {
        const s = pickNextStage(nextMode, nextBuildDir, nextDomain, nextPublish);
        setStage(s);
    };

    const resolved = useMemo<Resolved | null>(() => {
        if (mode === null || buildDir === null || domain === null || publishToPlayground === null)
            return null;
        return { mode, buildDir, domain, publishToPlayground };
    }, [mode, buildDir, domain, publishToPlayground]);

    // Dynamic terminal tab title: subtitle becomes the domain once we know it.
    const headerSubtitle = resolved?.domain ?? domain ?? undefined;

    return (
        <Box flexDirection="column">
            <Header
                cmd="dot deploy"
                subtitle={headerSubtitle}
                network="paseo"
                right={VERSION_LABEL}
            />

            {stage.kind === "prompt-signer" && (
                <Select<SignerMode>
                    label="signer"
                    options={[
                        {
                            value: "dev",
                            label: "dev signer",
                            hint: "fast, 0 phone taps for upload",
                        },
                        {
                            value: "phone",
                            label: "your phone signer",
                            hint: "signed with your logged-in account",
                        },
                    ]}
                    onSelect={(m) => {
                        setMode(m);
                        advance(m);
                    }}
                />
            )}

            {stage.kind === "prompt-buildDir" && (
                <Input
                    label="build directory"
                    initial={DEFAULT_BUILD_DIR}
                    onSubmit={(v) => {
                        setBuildDir(v);
                        advance(mode, v);
                    }}
                />
            )}

            {stage.kind === "prompt-domain" && (
                <Input
                    label="domain"
                    placeholder="my-app"
                    prefill={domain ?? ""}
                    externalError={domainError}
                    validate={(v) =>
                        /^[a-z0-9][a-z0-9-]*(\.dot)?$/i.test(v.trim())
                            ? null
                            : "use lowercase letters, digits, and dashes"
                    }
                    onSubmit={(v) => {
                        const trimmed = v.trim();
                        setDomain(trimmed);
                        setDomainError(null);
                        setStage({ kind: "validate-domain", domain: trimmed });
                    }}
                />
            )}

            {stage.kind === "validate-domain" && (
                <ValidateDomainStage
                    domain={stage.domain}
                    ownerSs58Address={userSigner?.address}
                    onAvailable={(result) => {
                        setDomain(result.fullDomain);
                        setPlan(result.plan);
                        advance(mode, buildDir, result.fullDomain);
                    }}
                    onUnavailable={(reason) => {
                        setDomainError(reason);
                        setStage({ kind: "prompt-domain" });
                    }}
                />
            )}

            {stage.kind === "prompt-publish" && (
                <Select<boolean>
                    label="publish to the playground?"
                    options={[
                        { value: false, label: "no", hint: "DotNS only" },
                        { value: true, label: "yes", hint: "publish to the playground registry" },
                    ]}
                    initialIndex={0}
                    onSelect={(yes) => {
                        setPublishToPlayground(yes);
                        advance(mode, buildDir, domain, yes);
                    }}
                />
            )}

            {stage.kind === "confirm" && resolved && (
                <ConfirmStage
                    inputs={resolved}
                    userSigner={userSigner}
                    plan={plan}
                    onProceed={() => setStage({ kind: "running" })}
                    onCancel={() => {
                        onDone(null);
                    }}
                />
            )}

            {stage.kind === "running" && resolved && (
                <RunningStage
                    projectDir={projectDir}
                    inputs={resolved}
                    userSigner={userSigner}
                    plan={plan}
                    onFinish={(outcome, chunkTimings) => {
                        setStage({ kind: "done", outcome });
                        // Surface completion on the terminal tab so users can glance over.
                        setWindowTitle(`dot deploy · ${resolved.domain} · ✓`);
                        onDone(outcome);
                        // chunkTimings is threaded via ref below — consumed by FinalResult.
                        finalChunkTimingsRef.current = chunkTimings;
                    }}
                    onError={(message) => {
                        setStage({ kind: "error", message });
                        setWindowTitle(`dot deploy · ${resolved.domain} · ✕`);
                        onDone(null);
                    }}
                />
            )}

            {stage.kind === "done" && (
                <FinalResult outcome={stage.outcome} chunkTimings={finalChunkTimingsRef.current} />
            )}

            {stage.kind === "error" && (
                <Section>
                    <Row mark="fail" label="deploy failed" value={stage.message} tone="danger" />
                </Section>
            )}
        </Box>
    );
}

// ── Stage pickers ────────────────────────────────────────────────────────────

function pickInitialStage(
    mode: SignerMode | null,
    buildDir: string | null,
    domain: string | null,
    publish: boolean | null,
): Stage {
    return pickNextStage(mode, buildDir, domain, publish);
}

function pickNextStage(
    mode: SignerMode | null,
    buildDir: string | null,
    domain: string | null,
    publish: boolean | null,
): Stage {
    if (mode === null) return { kind: "prompt-signer" };
    if (buildDir === null) return { kind: "prompt-buildDir" };
    if (domain === null) return { kind: "prompt-domain" };
    if (publish === null) return { kind: "prompt-publish" };
    return { kind: "confirm" };
}

// ── Domain validation ────────────────────────────────────────────────────────

function ValidateDomainStage({
    domain,
    ownerSs58Address,
    onAvailable,
    onUnavailable,
}: {
    domain: string;
    ownerSs58Address: string | undefined;
    onAvailable: (result: AvailabilityResult & { status: "available" }) => void;
    onUnavailable: (reason: string) => void;
}) {
    const [status, setStatus] = useState<"checking" | "done" | "error">("checking");
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const result = await checkDomainAvailability(domain, { ownerSs58Address });
                if (cancelled) return;
                if (result.status === "available") {
                    setStatus("done");
                    setMessage(formatAvailability(result));
                    // Short hold so users can read any note (e.g. "PoP will
                    // be set up automatically") before the next prompt mounts.
                    setTimeout(
                        () => {
                            if (!cancelled) onAvailable(result);
                        },
                        result.note ? 1200 : 300,
                    );
                } else {
                    const reason = formatAvailability(result);
                    setStatus("error");
                    setMessage(reason);
                    setTimeout(() => {
                        if (!cancelled) onUnavailable(reason);
                    }, 600);
                }
            } catch (err) {
                if (cancelled) return;
                const msg = err instanceof Error ? err.message : String(err);
                setStatus("error");
                setMessage(`availability check failed: ${msg}`);
                setTimeout(() => {
                    if (!cancelled) onUnavailable(msg);
                }, 600);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [domain]);

    const mark: MarkKind = status === "checking" ? "run" : status === "done" ? "ok" : "fail";
    const label = status === "checking" ? `checking ${domain}` : (message ?? "");
    return (
        <Section>
            <Row mark={mark} label={label} tone={status === "error" ? "danger" : "muted"} />
        </Section>
    );
}

// ── Confirm stage ────────────────────────────────────────────────────────────

function ConfirmStage({
    inputs,
    userSigner,
    plan,
    onProceed,
    onCancel,
}: {
    inputs: Resolved;
    userSigner: ResolvedSigner | null;
    plan: DeployPlan | null;
    onProceed: () => void;
    onCancel: () => void;
}) {
    const setup = useMemo(() => {
        try {
            return resolveSignerSetup({
                mode: inputs.mode,
                userSigner,
                publishToPlayground: inputs.publishToPlayground,
                plan: plan ?? undefined,
            });
        } catch (err) {
            return {
                approvals: [] as DeployApproval[],
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }, [inputs, userSigner, plan]);

    const view = buildSummaryView({
        mode: inputs.mode,
        domain: inputs.domain.replace(/\.dot$/, "") + ".dot",
        buildDir: inputs.buildDir,
        publishToPlayground: inputs.publishToPlayground,
        approvals: "approvals" in setup ? setup.approvals : [],
    });

    useInput((_input, key) => {
        if (key.return) onProceed();
        if (key.escape) onCancel();
    });

    return (
        <Box flexDirection="column">
            <Section title={view.headline.toLowerCase()}>
                {view.rows.map((row) => (
                    <Row
                        key={row.label}
                        label={row.label.toLowerCase()}
                        value={row.value}
                        tone="default"
                    />
                ))}
            </Section>

            <Section>
                {view.totalApprovals === 0 ? (
                    <Row label="phone approvals" value="none" tone="muted" />
                ) : (
                    <>
                        <Row
                            label="phone approvals"
                            value={String(view.totalApprovals)}
                            tone="accent"
                        />
                        {view.approvalLines.map((line) => (
                            <Hint key={line} indent={2}>
                                {line}
                            </Hint>
                        ))}
                    </>
                )}
            </Section>

            <Hint>{"enter to deploy  ·  esc to cancel"}</Hint>

            {"error" in setup && setup.error && (
                <Callout tone="warning">
                    <Text>{setup.error}</Text>
                </Callout>
            )}
        </Box>
    );
}

// ── Running stage ────────────────────────────────────────────────────────────

interface PhaseState {
    status: "pending" | "running" | "complete" | "error";
    detail?: string;
}

const PHASE_ORDER: DeployPhase[] = [
    "contracts",
    "cdm-install",
    "build",
    "storage-and-dotns",
    "playground",
    "done",
];
const PHASE_TITLE: Record<DeployPhase, string> = {
    contracts: "contracts",
    "cdm-install": "refresh cdm.json",
    build: "build frontend",
    "storage-and-dotns": "upload + dotns",
    playground: "publish to playground",
    done: "done",
};

function phaseMark(status: PhaseState["status"]): MarkKind {
    switch (status) {
        case "complete":
            return "ok";
        case "running":
            return "run";
        case "error":
            return "fail";
        default:
            return "idle";
    }
}

function RunningStage({
    projectDir,
    inputs,
    userSigner,
    plan,
    onFinish,
    onError,
}: {
    projectDir: string;
    inputs: Resolved;
    userSigner: ResolvedSigner | null;
    plan: DeployPlan | null;
    onFinish: (outcome: DeployOutcome, chunkTimings: number[]) => void;
    onError: (message: string) => void;
}) {
    // Contract and cdm-install phases start "pending" optimistically and get
    // collapsed to "complete" + skipped=true when the orchestrator fires
    // `phase-skipped` (e.g. no ink! crates detected, or nothing to reinstall).
    const initialPhases: Record<DeployPhase, PhaseState> = {
        contracts: { status: "pending" },
        "cdm-install": { status: "pending" },
        build: { status: "pending" },
        "storage-and-dotns": { status: "pending" },
        playground: {
            status: inputs.publishToPlayground ? "pending" : "complete",
            detail: inputs.publishToPlayground ? undefined : "skipped",
        },
        done: { status: "pending" },
    };
    const [phases, setPhases] = useState(initialPhases);
    const [contractRows, setContractRows] = useState<Record<string, ContractRowState>>({});
    const [signingPrompt, setSigningPrompt] = useState<SigningEvent | null>(null);
    const [latestInfo, setLatestInfo] = useState<string | null>(null);

    // Per-chunk timing for the sparkline on completion. Held in refs to avoid
    // re-renders on every chunk tick.
    const chunkTimingsRef = useRef<number[]>([]);
    const lastChunkAtRef = useRef<number | null>(null);

    // ── Throttled info updates ──────────────────────────────────────────
    // Verbose builds (vite / next) and bulletin-deploy's per-chunk logs can
    // fire hundreds of info events per second. Calling setLatestInfo on
    // every one floods React's update queue and on long deploys builds up
    // enough backpressure to spike memory into the gigabytes. Users only
    // ever see the most recent line anyway, so we coalesce updates to ~10
    // per second via a ref-based sink.
    const pendingInfoRef = useRef<string | null>(null);
    const infoTimerRef = useRef<NodeJS.Timeout | null>(null);
    const INFO_THROTTLE_MS = 100;
    const INFO_MAX_LEN = 160;
    const queueInfo = (line: string) => {
        const truncated = line.length > INFO_MAX_LEN ? `${line.slice(0, INFO_MAX_LEN - 1)}…` : line;
        pendingInfoRef.current = truncated;
        if (infoTimerRef.current === null) {
            infoTimerRef.current = setTimeout(() => {
                if (pendingInfoRef.current !== null) {
                    setLatestInfo(pendingInfoRef.current);
                    pendingInfoRef.current = null;
                }
                infoTimerRef.current = null;
            }, INFO_THROTTLE_MS);
        }
    };

    useEffect(() => {
        // Announce the command + target in the terminal tab on mount.
        setWindowTitle(`dot deploy · ${inputs.domain} · building`);

        let cancelled = false;

        (async () => {
            try {
                const outcome = await runDeploy({
                    projectDir,
                    buildDir: inputs.buildDir,
                    domain: inputs.domain,
                    mode: inputs.mode,
                    publishToPlayground: inputs.publishToPlayground,
                    userSigner,
                    plan: plan ?? undefined,
                    onEvent: (event) => handleEvent(event),
                });
                if (!cancelled) onFinish(outcome, chunkTimingsRef.current);
            } catch (err) {
                if (!cancelled) {
                    const message = err instanceof Error ? err.message : String(err);
                    onError(message);
                }
            }
        })();

        function handleEvent(event: DeployEvent) {
            if (event.kind === "phase-start") {
                setPhases((p) => ({ ...p, [event.phase]: { status: "running" } }));
                if (event.phase === "contracts") {
                    setWindowTitle(`dot deploy · ${inputs.domain} · contracts`);
                } else if (event.phase === "cdm-install") {
                    setWindowTitle(`dot deploy · ${inputs.domain} · cdm install`);
                } else if (event.phase === "storage-and-dotns") {
                    setWindowTitle(`dot deploy · ${inputs.domain} · uploading`);
                } else if (event.phase === "playground") {
                    setWindowTitle(`dot deploy · ${inputs.domain} · publishing`);
                } else if (event.phase === "build") {
                    setWindowTitle(`dot deploy · ${inputs.domain} · building`);
                }
            } else if (event.kind === "phase-complete") {
                setPhases((p) => ({ ...p, [event.phase]: { status: "complete" } }));
            } else if (event.kind === "phase-skipped") {
                setPhases((p) => ({
                    ...p,
                    [event.phase]: { status: "complete", detail: "skipped" },
                }));
                queueInfo(event.reason);
            } else if (event.kind === "contracts-event") {
                applyContractEvent(setContractRows, event.event, queueInfo);
            } else if (event.kind === "cdm-install-log") {
                queueInfo(event.line);
            } else if (event.kind === "build-log") {
                queueInfo(event.line);
            } else if (event.kind === "build-detected") {
                queueInfo(`> ${event.config.description}`);
            } else if (event.kind === "storage-event") {
                if (event.event.kind === "chunk-progress") {
                    const now = performance.now();
                    const last = lastChunkAtRef.current;
                    if (last !== null) {
                        chunkTimingsRef.current.push(now - last);
                    }
                    lastChunkAtRef.current = now;
                    queueInfo(`uploading chunk ${event.event.current}/${event.event.total}`);
                } else if (event.event.kind === "info") {
                    queueInfo(event.event.message);
                }
            } else if (event.kind === "signing") {
                if (event.event.kind === "sign-request") {
                    setSigningPrompt(event.event);
                } else if (event.event.kind === "sign-complete") {
                    setSigningPrompt(null);
                } else if (event.event.kind === "sign-error") {
                    setSigningPrompt(null);
                    queueInfo(`signing rejected: ${event.event.message}`);
                }
            } else if (event.kind === "error") {
                setPhases((p) => ({
                    ...p,
                    [event.phase]: { status: "error", detail: event.message },
                }));
            }
        }

        return () => {
            cancelled = true;
            if (infoTimerRef.current !== null) {
                clearTimeout(infoTimerRef.current);
                infoTimerRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const contractCrates = Object.keys(contractRows);
    const contractsPhaseActive =
        phases.contracts.status === "running" ||
        (phases.contracts.status === "complete" && contractCrates.length > 0);

    return (
        <Box flexDirection="column">
            <Section gapBelow={false}>
                {PHASE_ORDER.filter((p) => p !== "done").map((phase) => {
                    const state = phases[phase];
                    return (
                        <Row
                            key={phase}
                            mark={phaseMark(state.status)}
                            label={PHASE_TITLE[phase]}
                            value={state.detail}
                            tone={state.status === "error" ? "danger" : "muted"}
                        />
                    );
                })}
            </Section>

            {contractsPhaseActive && contractCrates.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                    <Hint indent={2}>contracts</Hint>
                    {contractCrates.map((crate) => (
                        <ContractRow key={crate} name={crate} state={contractRows[crate]} />
                    ))}
                </Box>
            )}

            {latestInfo && (
                <Box marginTop={1}>
                    <Hint indent={2}>{truncate(latestInfo, 120)}</Hint>
                </Box>
            )}

            {signingPrompt && signingPrompt.kind === "sign-request" && (
                <Callout tone="warning" title="check your phone">
                    <Text>
                        approve step {signingPrompt.step} of {signingPrompt.total}:{" "}
                        <Text bold>{signingPrompt.label}</Text>
                    </Text>
                </Callout>
            )}
        </Box>
    );
}

// ── Final result ─────────────────────────────────────────────────────────────

function FinalResult({
    outcome,
    chunkTimings,
}: {
    outcome: DeployOutcome;
    chunkTimings: number[];
}) {
    return (
        <Box flexDirection="column" marginTop={1}>
            <Row mark="ok" label="deploy complete" tone="default" />

            <Box marginTop={1}>
                <Section gapBelow={false}>
                    <Row label="url" value={outcome.appUrl} />
                    <Row label="domain" value={outcome.fullDomain} />
                    <Row label="app cid" value={outcome.appCid} />
                    {outcome.ipfsCid && <Row label="ipfs cid" value={outcome.ipfsCid} />}
                    {outcome.metadataCid && (
                        <Row label="metadata cid" value={outcome.metadataCid} />
                    )}
                </Section>
            </Box>

            {chunkTimings.length > 0 && (
                <Box paddingLeft={2} flexDirection="row">
                    <Text>{"chunks".padEnd(14)}</Text>
                    <Sparkline values={chunkTimings} width={16} />
                    <Text dimColor>
                        {`  ${chunkTimings.length + 1} chunks  ·  avg ${(
                            average(chunkTimings) / 1000
                        ).toFixed(2)}s/chunk`}
                    </Text>
                </Box>
            )}
        </Box>
    );
}

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function average(xs: number[]): number {
    if (xs.length === 0) return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}
