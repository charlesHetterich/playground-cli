/**
 * `dot build` TUI — runs the frontend build and the contracts build in
 * parallel, renders each as a status row with an optional contract-level
 * breakdown, and surfaces the latest line of stdout from whichever track
 * last emitted. Missing toolchains (no contracts detected / build tool not
 * detected) are rendered as skipped rows rather than errors.
 */

import { useEffect, useRef, useState } from "react";
import { Box } from "ink";
import {
    Header,
    Hint,
    LogTail,
    Row,
    Section,
    setWindowTitle,
    type MarkKind,
} from "../../utils/ui/theme/index.js";
import { detectBuildConfig, loadDetectInput, runBuild } from "../../utils/build/index.js";
import {
    planContracts,
    runContractBuild,
    type CdmBuildEvent,
    type ContractsPlan,
} from "../../utils/deploy/contracts.js";
import { ContractRow, applyContractEvent, type ContractRowState } from "../deploy/ContractRow.js";
import { VERSION_LABEL } from "../../utils/version.js";

type TrackStatus = "pending" | "running" | "ok" | "skipped" | "failed";

interface TrackState {
    status: TrackStatus;
    detail?: string;
}

const LOG_LINES = 8;

interface Props {
    projectDir: string;
    onDone: (success: boolean) => void;
}

export function BuildScreen({ projectDir, onDone }: Props) {
    const [frontend, setFrontend] = useState<TrackState>({ status: "pending" });
    const [contracts, setContracts] = useState<TrackState>({ status: "pending" });
    const [contractRows, setContractRows] = useState<Record<string, ContractRowState>>({});
    const [output, setOutput] = useState<string[]>([]);

    // Throttle log updates — cargo/vite can emit hundreds of lines/sec and
    // `setOutput` on each one floods React's reconciler. Same protection as
    // RunningStage in DeployScreen.
    const pendingLinesRef = useRef<string[]>([]);
    const logTimerRef = useRef<NodeJS.Timeout | null>(null);
    const pushLine = (line: string) => {
        const trimmed = line.length > 160 ? `${line.slice(0, 159)}…` : line;
        pendingLinesRef.current.push(trimmed);
        if (logTimerRef.current === null) {
            logTimerRef.current = setTimeout(() => {
                const drained = pendingLinesRef.current;
                pendingLinesRef.current = [];
                logTimerRef.current = null;
                if (drained.length > 0) {
                    setOutput((prev) => [...prev, ...drained].slice(-LOG_LINES));
                }
            }, 100);
        }
    };

    useEffect(() => {
        setWindowTitle("dot build");
        let cancelled = false;

        (async () => {
            const plan: ContractsPlan | null = planContracts(projectDir);

            const contractsTrack = plan
                ? runContractsTrack({
                      projectDir,
                      plan,
                      setContracts,
                      setContractRows,
                      pushLine,
                  }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
                : Promise.resolve<null | Error>(null).then(() => {
                      setContracts({ status: "skipped", detail: "no ink! contracts detected" });
                      return null;
                  });

            const frontendTrack = runFrontendTrack({
                projectDir,
                setFrontend,
                pushLine,
            }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));

            // Run in parallel — Promise.all collects both outcomes so one
            // failing track doesn't abort the other. A failure in either is
            // still an overall failure.
            const [contractsResult, frontendResult] = await Promise.all([
                contractsTrack,
                frontendTrack,
            ]);

            if (cancelled) return;
            const ok = !(contractsResult instanceof Error) && !(frontendResult instanceof Error);
            // Give the log timer one last flush before unmount.
            setTimeout(() => {
                if (!cancelled) onDone(ok);
            }, 120);
        })();

        return () => {
            cancelled = true;
            if (logTimerRef.current !== null) {
                clearTimeout(logTimerRef.current);
                logTimerRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const contractCrates = Object.keys(contractRows);

    return (
        <Box flexDirection="column">
            <Header cmd="dot build" subtitle={projectDir} network="paseo" right={VERSION_LABEL} />

            <Section title="tracks" gapBelow={false}>
                <Row
                    mark={toMark(contracts.status)}
                    label="contracts"
                    value={contracts.detail}
                    tone={contracts.status === "failed" ? "danger" : "muted"}
                />
                <Row
                    mark={toMark(frontend.status)}
                    label="frontend"
                    value={frontend.detail}
                    tone={frontend.status === "failed" ? "danger" : "muted"}
                />
            </Section>

            {contractCrates.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                    <Hint indent={2}>contract crates</Hint>
                    {contractCrates.map((crate) => (
                        <ContractRow key={crate} name={crate} state={contractRows[crate]} />
                    ))}
                </Box>
            )}

            {output.length > 0 && (
                <Box marginTop={1}>
                    <LogTail lines={output} height={LOG_LINES} />
                </Box>
            )}
        </Box>
    );
}

function toMark(status: TrackStatus): MarkKind {
    switch (status) {
        case "pending":
            return "idle";
        case "running":
            return "run";
        case "ok":
            return "ok";
        case "failed":
            return "fail";
        case "skipped":
            return "idle";
    }
}

// ── Track runners ────────────────────────────────────────────────────────────

async function runFrontendTrack(args: {
    projectDir: string;
    setFrontend: React.Dispatch<React.SetStateAction<TrackState>>;
    pushLine: (line: string) => void;
}): Promise<void> {
    const { projectDir, setFrontend, pushLine } = args;
    try {
        const config = detectBuildConfig(loadDetectInput(projectDir));
        pushLine(`> ${config.description}`);
        setFrontend({ status: "running", detail: config.description });
        await runBuild({
            cwd: projectDir,
            config,
            onData: (line) => pushLine(line),
        });
        setFrontend({ status: "ok" });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setFrontend({ status: "failed", detail: message });
        throw err instanceof Error ? err : new Error(message);
    }
}

async function runContractsTrack(args: {
    projectDir: string;
    plan: ContractsPlan;
    setContracts: React.Dispatch<React.SetStateAction<TrackState>>;
    setContractRows: React.Dispatch<React.SetStateAction<Record<string, ContractRowState>>>;
    pushLine: (line: string) => void;
}): Promise<void> {
    const { projectDir, plan, setContracts, setContractRows, pushLine } = args;
    setContracts({ status: "running", detail: `${plan.crates.length} crate(s)` });
    try {
        await runContractBuild({
            rootDir: projectDir,
            onEvent: (event: CdmBuildEvent) => {
                // Feed every cdm event through the same state machine the
                // deploy screen uses so row styling stays identical across
                // the two commands.
                applyContractEvent(setContractRows, event, pushLine);
            },
        });
        setContracts({ status: "ok" });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setContracts({ status: "failed", detail: message });
        throw err instanceof Error ? err : new Error(message);
    }
}
