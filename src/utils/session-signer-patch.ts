/**
 * Custom PolkadotSigner that uses signPayload for transactions.
 *
 * The default createSessionSigner from @polkadot-apps/terminal uses signRaw
 * for all signing. The mobile app wraps signRaw data with <Bytes>...</Bytes>
 * (via MessageSigningContext.generalUntrustedMessage), which produces a
 * signature over different data than what the chain expects → BadProof.
 *
 * This signer delegates to `getPolkadotSignerFromPjs`, which formats each
 * signed extension exactly like polkadot.js SignerPayloadJSON. The mobile's
 * SignPayloadJsonInteractor consumes that same shape, so the two sides stay
 * in lockstep — no hand-rolled per-extension encoding on our end.
 *
 * Once @polkadot-apps/terminal is updated to default to signPayload, this
 * file can be removed.
 */

import { getPolkadotSignerFromPjs, type SignerPayloadJSON } from "polkadot-api/pjs-signer";
import type { PolkadotSigner } from "polkadot-api";
import type { UserSession } from "@polkadot-apps/terminal";

/** Format bytes as `0x`-prefixed lowercase hex. */
export function toHex(bytes: Uint8Array): `0x${string}` {
    return `0x${Buffer.from(bytes).toString("hex")}` as `0x${string}`;
}

/** Decode hex with or without `0x` prefix. Empty input → empty Uint8Array. */
export function fromHex(hex: string): Uint8Array {
    const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
    return new Uint8Array(Buffer.from(stripped, "hex"));
}

/**
 * Signature-shape payload we hand to the host-papp SDK. Mirrors polkadot.js'
 * `SignerPayloadJSON` but narrowed so every optional field is explicitly
 * `undefined` — the scale-ts codec on the other side needs that, missing
 * keys would blow up inside its Option encoder.
 */
export function adaptSignPayload(session: Pick<UserSession, "signPayload">): (
    payload: SignerPayloadJSON,
) => Promise<{
    signature: `0x${string}`;
    signedTransaction: `0x${string}`;
}> {
    return async (payload: SignerPayloadJSON) => {
        const result = await session.signPayload({
            address: payload.address,
            blockHash: payload.blockHash as `0x${string}`,
            blockNumber: payload.blockNumber as `0x${string}`,
            era: payload.era as `0x${string}`,
            genesisHash: payload.genesisHash as `0x${string}`,
            method: payload.method as `0x${string}`,
            nonce: payload.nonce as `0x${string}`,
            specVersion: payload.specVersion as `0x${string}`,
            tip: payload.tip as `0x${string}`,
            transactionVersion: payload.transactionVersion as `0x${string}`,
            signedExtensions: payload.signedExtensions,
            version: payload.version,
            assetId: payload.assetId as `0x${string}` | undefined,
            metadataHash: payload.metadataHash as `0x${string}` | undefined,
            mode: payload.mode,
            withSignedTransaction: payload.withSignedTransaction ?? true,
        });

        if (result.isErr()) {
            throw new Error(
                `Mobile signing failed (${result.error.name ?? "error"}): ${result.error.message}`,
            );
        }

        if (!result.value.signedTransaction) {
            throw new Error(
                "Mobile did not return a signed transaction — update your Polkadot mobile app",
            );
        }

        return {
            signature: toHex(result.value.signature),
            signedTransaction: toHex(result.value.signedTransaction),
        };
    };
}

export function adaptSignRaw(session: Pick<UserSession, "signRaw">): (payload: {
    address: string;
    data: string;
    type: "bytes";
}) => Promise<{
    id: number;
    signature: `0x${string}`;
}> {
    return async (payload: { address: string; data: string; type: "bytes" }) => {
        const bytes = fromHex(payload.data);
        const result = await session.signRaw({
            address: payload.address,
            data: { tag: "Bytes" as const, value: bytes },
        });

        if (result.isErr()) {
            const name = result.error.name ?? "error";
            throw new Error(`Mobile signing failed (${name}): ${result.error.message}`);
        }

        return { id: 0, signature: toHex(result.value.signature) };
    };
}

export function createTxSigner(session: UserSession): PolkadotSigner {
    const accountId = new Uint8Array(session.remoteAccount.accountId);
    const address = toHex(accountId);

    return getPolkadotSignerFromPjs(address, adaptSignPayload(session), adaptSignRaw(session));
}
