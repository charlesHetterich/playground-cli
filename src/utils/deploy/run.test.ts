import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks for the heavy underlying pieces. Orchestrator tests only care about
// sequencing, event shape, and error propagation. Declare mocks via
// `vi.hoisted()` so they're available when `vi.mock()` (itself hoisted) runs.
const {
    runStorageDeploy,
    publishToPlaygroundMock,
    runBuildMock,
    detectBuildConfigMock,
    loadDetectInputMock,
} = vi.hoisted(() => ({
    runStorageDeploy: vi.fn<
        (arg: any) => Promise<{
            domainName: string;
            fullDomain: string;
            cid: string;
            ipfsCid: string;
        }>
    >(async () => ({
        domainName: "my-app",
        fullDomain: "my-app.dot",
        cid: "bafyapp",
        ipfsCid: "bafyipfs",
    })),
    publishToPlaygroundMock: vi.fn(async () => ({
        metadataCid: "bafymeta",
        fullDomain: "my-app.dot",
        metadata: {},
    })),
    runBuildMock: vi.fn(async () => ({ config: {} as any, outputDir: "/tmp/dist" })),
    detectBuildConfigMock: vi.fn(() => ({
        cmd: "pnpm",
        args: ["run", "build"],
        description: "pnpm run build",
        defaultOutputDir: "dist",
    })),
    loadDetectInputMock: vi.fn(() => ({
        packageJson: { scripts: { build: "vite build" } },
        lockfiles: new Set<string>(),
        configFiles: new Set<string>(),
    })),
}));

vi.mock("./storage.js", () => ({ runStorageDeploy }));
vi.mock("./playground.js", () => ({
    publishToPlayground: publishToPlaygroundMock,
    normalizeDomain: (d: string) => {
        const label = d.replace(/\.dot$/, "");
        return { label, fullDomain: `${label}.dot` };
    },
}));
vi.mock("../build/index.js", () => ({
    runBuild: runBuildMock,
    loadDetectInput: loadDetectInputMock,
    detectBuildConfig: detectBuildConfigMock,
}));

import { runDeploy, type DeployEvent } from "./run.js";
import type { ResolvedSigner } from "../signer.js";

const fakeUserSigner: ResolvedSigner = {
    signer: {
        publicKey: new Uint8Array(32),
        signTx: vi.fn(),
        signBytes: vi.fn(),
    },
    address: "5Fake",
    source: "session",
    destroy: vi.fn(),
};

function collectEvents(): { events: DeployEvent[]; push: (e: DeployEvent) => void } {
    const events: DeployEvent[] = [];
    return { events, push: (e) => events.push(e) };
}

beforeEach(() => {
    runStorageDeploy.mockClear();
    publishToPlaygroundMock.mockClear();
    runBuildMock.mockClear();
});

describe("runDeploy", () => {
    it("dev mode without playground: no phone taps, no publishToPlayground call", async () => {
        const { events, push } = collectEvents();
        const outcome = await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "dev",
            publishToPlayground: false,
            userSigner: null,
            onEvent: push,
        });

        expect(outcome.fullDomain).toBe("my-app.dot");
        expect(outcome.approvalsRequested).toEqual([]);
        expect(publishToPlaygroundMock).not.toHaveBeenCalled();

        const plan = events.find((e) => e.kind === "plan");
        expect(plan).toEqual({ kind: "plan", approvals: [], contractLayers: [] });

        // bulletin-deploy auth must be empty in dev mode.
        expect(runStorageDeploy).toHaveBeenCalledTimes(1);
        const arg = runStorageDeploy.mock.calls[0][0];
        expect(arg.auth).toEqual({});
        expect(arg.domainName).toBe("my-app");
    });

    it("dev mode with playground: 1 planned approval, calls publishToPlayground", async () => {
        const { events, push } = collectEvents();
        const outcome = await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "dev",
            publishToPlayground: true,
            userSigner: fakeUserSigner,
            onEvent: push,
        });

        expect(outcome.approvalsRequested).toEqual([
            { phase: "playground", label: "Publish to Playground registry" },
        ]);
        expect(outcome.metadataCid).toBe("bafymeta");
        expect(publishToPlaygroundMock).toHaveBeenCalledTimes(1);

        const plan = events.find((e) => e.kind === "plan");
        expect(plan?.kind).toBe("plan");
        if (plan?.kind === "plan") expect(plan.approvals).toHaveLength(1);
    });

    it("phone mode with playground: 4 planned approvals, DotNS uses phone signer", async () => {
        const { events, push } = collectEvents();
        const outcome = await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "phone",
            publishToPlayground: true,
            userSigner: fakeUserSigner,
            onEvent: push,
        });

        expect(outcome.approvalsRequested).toHaveLength(4);

        // bulletin-deploy auth must carry a wrapped signer + our address.
        const arg = runStorageDeploy.mock.calls[0][0];
        expect(arg.auth.signerAddress).toBe("5Fake");
        expect(arg.auth.signer).toBeDefined();

        const plan = events.find((e) => e.kind === "plan");
        if (plan?.kind === "plan") {
            expect(plan.approvals.map((a) => a.phase)).toEqual([
                "dotns",
                "dotns",
                "dotns",
                "playground",
            ]);
        }
    });

    it("phone mode + needsPopUpgrade: 5 planned approvals (setPop + commit + finalize + contenthash + playground)", async () => {
        // Regression: this used to be 4 approvals across the board, so a
        // PoP-gated name with a lower-tier signer (which triggers
        // `setUserPopStatus` inside bulletin-deploy.register) printed
        // "approve step 5 of 4" at the playground step.
        const { events, push } = collectEvents();
        const outcome = await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "phone",
            publishToPlayground: true,
            userSigner: fakeUserSigner,
            plan: { action: "register", needsPopUpgrade: true },
            onEvent: push,
        });

        expect(outcome.approvalsRequested).toHaveLength(5);
        expect(outcome.approvalsRequested.map((a) => a.label)).toEqual([
            "Grant Proof of Personhood",
            "Reserve domain (DotNS commitment)",
            "Finalize domain (DotNS register)",
            "Link content (DotNS setContenthash)",
            "Publish to Playground registry",
        ]);

        const plan = events.find((e) => e.kind === "plan");
        if (plan?.kind === "plan") {
            expect(plan.approvals.map((a) => a.phase)).toEqual([
                "dotns",
                "dotns",
                "dotns",
                "dotns",
                "playground",
            ]);
        }
    });

    it("phone mode + re-deploy (plan.action=update): only setContenthash + playground taps", async () => {
        // When the domain is already owned by the signer, bulletin-deploy
        // skips `register()` entirely (no commit, no reveal, no PoP grant)
        // and jumps straight to `setContenthash`. Summary should reflect that.
        const { events, push } = collectEvents();
        const outcome = await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "phone",
            publishToPlayground: true,
            userSigner: fakeUserSigner,
            plan: { action: "update", needsPopUpgrade: false },
            onEvent: push,
        });

        expect(outcome.approvalsRequested).toHaveLength(2);
        expect(outcome.approvalsRequested.map((a) => a.label)).toEqual([
            "Link content (DotNS setContenthash)",
            "Publish to Playground registry",
        ]);

        const plan = events.find((e) => e.kind === "plan");
        if (plan?.kind === "plan") {
            expect(plan.approvals.map((a) => a.phase)).toEqual(["dotns", "playground"]);
        }
    });

    it("phone mode without a logged-in session throws before touching the network", async () => {
        const { push } = collectEvents();
        await expect(
            runDeploy({
                projectDir: "/tmp/proj",
                buildDir: "/tmp/proj/dist",
                domain: "my-app",
                mode: "phone",
                publishToPlayground: false,
                userSigner: null,
                onEvent: push,
            }),
        ).rejects.toThrow(/Phone signer requested/);

        expect(runStorageDeploy).not.toHaveBeenCalled();
    });

    it("skipBuild bypasses detect + runBuild", async () => {
        const { push } = collectEvents();
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            skipBuild: true,
            domain: "my-app",
            mode: "dev",
            publishToPlayground: false,
            userSigner: null,
            onEvent: push,
        });
        expect(runBuildMock).not.toHaveBeenCalled();
    });

    it("emits error event and rethrows when storage fails", async () => {
        runStorageDeploy.mockImplementationOnce(async () => {
            throw new Error("bulletin rpc down");
        });
        const { events, push } = collectEvents();
        await expect(
            runDeploy({
                projectDir: "/tmp/proj",
                buildDir: "/tmp/proj/dist",
                skipBuild: true,
                domain: "my-app",
                mode: "dev",
                publishToPlayground: false,
                userSigner: null,
                onEvent: push,
            }),
        ).rejects.toThrow(/bulletin rpc down/);

        const err = events.find((e) => e.kind === "error");
        expect(err).toMatchObject({ phase: "storage-and-dotns", message: "bulletin rpc down" });
    });
});
