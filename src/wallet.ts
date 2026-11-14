// The `wallet` script creates the gateway and seller wallets in .env if they're missing,
// then shows their addresses and balances. Run it with `claim` to also get 20 test USDC
// for the gateway wallet from GOAT's token faucet. It never prints a key.
import "./env.ts";
import { appendFileSync } from "node:fs";
import { encodeFunctionData, formatEther, formatUnits, isAddress, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { explorerTx, FAUCET, goatChain } from "./chain.ts";
import { gatewayAccount } from "./gateway.ts";
import { TOKEN_DECIMALS } from "./goatflow.ts";
import { policyFromEnv } from "./policy.ts";
import { createSequencer } from "./sequencer.ts";

const TOKEN_FAUCET = "0x89e7dfd01a86e5393ce6d8A78c9aa6653Ee113A6";

if (!process.env.GATEWAY_PRIVATE_KEY) {
  const gateway = generatePrivateKey();
  const seller = generatePrivateKey();
  appendFileSync(
    ".env",
    `\n# Testnet wallets made by the wallet script. Keep only faucet funds in them.\n` +
      `GATEWAY_PRIVATE_KEY=${gateway}\nSELLER_PRIVATE_KEY=${seller}\nSELLER_ADDRESS=${privateKeyToAccount(seller).address}\n`,
  );
  process.env.GATEWAY_PRIVATE_KEY = gateway;
  process.env.SELLER_ADDRESS = privateKeyToAccount(seller).address;
  console.log("Created two wallets and saved them to .env.\n");
}

const chain = goatChain();
const account = gatewayAccount();
const { token } = policyFromEnv();

if (process.argv[2] === "claim") {
  const data = encodeFunctionData({
    abi: parseAbi(["function claimToken(address token)"]),
    functionName: "claimToken",
    args: [token],
  });
  // The faucet's claim uses more gas than a transfer, so this is sent with its own limit.
  const hash = await createSequencer(chain, account, 300_000n).send({ to: TOKEN_FAUCET, value: 0n, data }, () => {});
  console.log(`Claim sent: ${explorerTx(hash)}`);
  console.log(`Claim ${await chain.receipt(hash)}\n`);
}

const show = async (name: string, address: `0x${string}`) =>
  console.log(
    `${name}  ${address}  ${formatEther(await chain.balance(address))} BTC  ` +
      `${formatUnits(await chain.tokenBalance(token, address), TOKEN_DECIMALS)} USDC`,
  );
await show("Gateway wallet", account.address);
const seller = process.env.SELLER_ADDRESS;
if (seller && isAddress(seller)) await show("Seller wallet ", seller);
console.log(`\nTest BTC for gas: ${FAUCET}`);
console.log("Test USDC: run this script with `claim` once the gateway wallet has gas.");
