// The only code that holds the wallet key and sends transactions.
import { keccak256, type Address, type Hex, type PrivateKeyAccount } from "viem";
import type { Chain } from "./chain.ts";

// A transfer with 32 bytes of data costs about 22,300 gas. Unused gas is refunded.
const GAS = 30_000n;

export type Signed = { nonce: number; hash: Hex; raw: Hex };

export function createSequencer(chain: Chain, account: PrivateKeyAccount) {
  let nonce: number | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  // Transactions are signed and broadcast one at a time, so two payments can never take the
  // same nonce and a failed one never leaves a gap. Broadcasting takes a fraction of a second.
  // The slow part, waiting for the block, happens outside this queue, so payments overlap.
  function send(tx: { to: Address; value: bigint; data: Hex }, onSigned: (signed: Signed) => void): Promise<Hex> {
    const run = async () => {
      nonce ??= await chain.nonce(account.address);
      const raw = await account.signTransaction({
        chainId: chain.chainId,
        type: "eip1559",
        nonce,
        gas: GAS,
        ...(await chain.fees()),
        ...tx,
      });
      const hash = keccak256(raw);
      // The hash is known before anything is sent. Storing it first is what lets a restarted
      // gateway check the chain instead of paying again.
      onSigned({ nonce, hash, raw });
      try {
        await chain.broadcast(raw);
        nonce++;
      } catch (e) {
        nonce = undefined; // read it from the chain again next time
        // The error may have come after the node accepted the transaction. Only treat the
        // payment as not sent if the node has never heard of it.
        if (!(await chain.transaction(hash).catch(() => null))) throw e;
      }
      return hash;
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }

  return { address: account.address, send };
}

export type Sequencer = ReturnType<typeof createSequencer>;
