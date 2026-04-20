/**
 * Tests for the host-papp SDK adapters + hex helpers in `signer.ts`.
 *
 * We avoid going through `getPolkadotSignerFromPjs` directly — that lives in
 * `polkadot-api` and already has its own test suite. Instead we exercise the
 * adapters (`adaptSignPayload`, `adaptSignRaw`) that sit between the polkadot
 * .js SignerPayloadJSON contract and our `UserSession.signPayload/signRaw`
 * ResultAsync contracts — that's where our bugs historically lived.
 */

import { describe, it, expect } from "vitest";
import type { SignerPayloadJSON } from "polkadot-api/pjs-signer";
import { adaptSignPayload, adaptSignRaw, fromHex, toHex } from "./session-signer-patch.js";

// Duck-typed Result builders. Our session.signPayload returns neverthrow's
// ResultAsync, but our adapter only touches `isErr()`, `.value`, `.error`.
// Building the full ResultAsync in a test would drag neverthrow into the
// deps tree for no added coverage, so we shape-match and cast at the call
// site.
function ok<T>(value: T) {
    return {
        isErr: () => false as const,
        isOk: () => true as const,
        value,
        error: undefined as never,
    };
}

function err(error: Error) {
    return {
        isErr: () => true as const,
        isOk: () => false as const,
        value: undefined as never,
        error,
    };
}

function basePayload(): SignerPayloadJSON {
    return {
        address: "0x01",
        blockHash: "0xaa",
        blockNumber: "0x00000001",
        era: "0x00",
        genesisHash: "0xbb",
        method: "0xcc",
        nonce: "0x00000000",
        specVersion: "0x01",
        tip: "0x00000000000000000000000000000000",
        transactionVersion: "0x0f",
        signedExtensions: ["CheckGenesis"],
        version: 4,
    };
}

/**
 * Build an `adaptSignPayload` over a fake session whose `signPayload`
 * returns the given Result. Records the last request the adapter made.
 */
function payloadAdapter(resultFactory: () => ReturnType<typeof ok> | ReturnType<typeof err>): {
    run: (payload: SignerPayloadJSON) => Promise<unknown>;
    seen(): Record<string, unknown> | undefined;
} {
    let seen: Record<string, unknown> | undefined;
    const fakeSession = {
        signPayload: async (req: Record<string, unknown>) => {
            seen = req;
            return resultFactory();
        },
    };
    // biome-ignore lint/suspicious/noExplicitAny: duck-typed fake session
    const adapter = adaptSignPayload(fakeSession as any);
    return { run: adapter, seen: () => seen };
}

describe("toHex / fromHex", () => {
    it("round-trips arbitrary byte sequences", () => {
        const bytes = new Uint8Array([0, 1, 16, 255, 128]);
        const hex = toHex(bytes);
        expect(hex).toBe("0x000110ff80");
        expect(Array.from(fromHex(hex))).toEqual(Array.from(bytes));
    });

    it("handles empty input in both directions", () => {
        expect(toHex(new Uint8Array())).toBe("0x");
        expect(fromHex("0x")).toEqual(new Uint8Array());
        expect(fromHex("")).toEqual(new Uint8Array());
    });

    it("fromHex accepts both prefixed and unprefixed hex", () => {
        // pjs-signer always gives us 0x-prefixed, but defensive decoding
        // matters — Buffer.from('0xab', 'hex') silently returns <Buffer >.
        expect(Array.from(fromHex("0xabcd"))).toEqual([0xab, 0xcd]);
        expect(Array.from(fromHex("abcd"))).toEqual([0xab, 0xcd]);
    });

    it("toHex produces lowercase hex", () => {
        const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        expect(toHex(bytes)).toBe("0xdeadbeef");
    });
});

describe("adaptSignPayload", () => {
    it("returns hex-encoded signature + signedTransaction on success", async () => {
        const { run } = payloadAdapter(() =>
            ok({
                signature: new Uint8Array([0x11, 0x22]),
                signedTransaction: new Uint8Array([0x33, 0x44]),
            }),
        );
        const result = (await run(basePayload())) as {
            signature: string;
            signedTransaction: string;
        };
        expect(result.signature).toBe("0x1122");
        expect(result.signedTransaction).toBe("0x3344");
    });

    it("throws a readable error when the session returns Err", async () => {
        const { run } = payloadAdapter(() => err(new Error("user rejected")));
        await expect(run(basePayload())).rejects.toThrow(/Mobile signing failed.*user rejected/);
    });

    it("throws an upgrade-guidance error when signedTransaction is missing", async () => {
        const { run } = payloadAdapter(() =>
            ok({
                signature: new Uint8Array([0x11, 0x22]),
                signedTransaction: undefined,
            }),
        );
        await expect(run(basePayload())).rejects.toThrow(/update your Polkadot mobile app/);
    });

    it("forwards optional fields as explicit undefined (not missing keys)", async () => {
        // Why this matters: the mobile's scale-ts Option codec trips if the
        // key is absent — it expects `assetId: undefined`, not omitted.
        const { run, seen } = payloadAdapter(() =>
            ok({
                signature: new Uint8Array(),
                signedTransaction: new Uint8Array(),
            }),
        );
        await run(basePayload());
        const req = seen();
        expect(req).toBeDefined();
        if (!req) throw new Error("unreachable");
        expect("assetId" in req).toBe(true);
        expect("metadataHash" in req).toBe(true);
        expect("mode" in req).toBe(true);
        expect(req.assetId).toBeUndefined();
        expect(req.metadataHash).toBeUndefined();
        expect(req.mode).toBeUndefined();
    });

    it("defaults withSignedTransaction to true when caller omits it", async () => {
        const { run, seen } = payloadAdapter(() =>
            ok({
                signature: new Uint8Array(),
                signedTransaction: new Uint8Array(),
            }),
        );
        await run(basePayload());
        expect(seen()?.withSignedTransaction).toBe(true);
    });

    it("passes through CheckMetadataHash fields when enabled", async () => {
        // Regression guard for the historical bug where metadataHash was
        // silently dropped — when `mode: 1`, the 0x… hash must reach the phone.
        const { run, seen } = payloadAdapter(() =>
            ok({
                signature: new Uint8Array(),
                signedTransaction: new Uint8Array(),
            }),
        );
        const payload = {
            ...basePayload(),
            mode: 1,
            metadataHash:
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
        };
        await run(payload);
        expect(seen()?.mode).toBe(1);
        expect(seen()?.metadataHash).toBe(payload.metadataHash);
    });
});

describe("adaptSignRaw", () => {
    it("hex-decodes the data payload before handing it to signRaw", async () => {
        let seen: Uint8Array | undefined;
        const fakeSession = {
            signRaw: async (req: {
                address: string;
                data: { tag: "Bytes"; value: Uint8Array };
            }) => {
                seen = req.data.value;
                return ok({
                    signature: new Uint8Array([0x99]),
                    signedTransaction: undefined,
                });
            },
        };
        // biome-ignore lint/suspicious/noExplicitAny: duck-typed fake session
        const adapter = adaptSignRaw(fakeSession as any);
        const result = await adapter({ address: "5F...", data: "0xdeadbeef", type: "bytes" });
        expect(Array.from(seen ?? [])).toEqual([0xde, 0xad, 0xbe, 0xef]);
        expect(result.signature).toBe("0x99");
        expect(result.id).toBe(0);
    });

    it("throws readable error when session returns Err", async () => {
        const fakeSession = {
            signRaw: async () => err(new Error("session closed")),
        };
        // biome-ignore lint/suspicious/noExplicitAny: duck-typed fake session
        const adapter = adaptSignRaw(fakeSession as any);
        await expect(adapter({ address: "5F...", data: "0x00", type: "bytes" })).rejects.toThrow(
            /Mobile signing failed.*session closed/,
        );
    });
});
