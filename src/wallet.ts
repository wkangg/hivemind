// The `wallet` script creates the gateway and seller wallets in .env if they're missing,
// then shows their addresses and balances. It never prints a key.
import "./env.ts";
import { appendFileSync } from "node:fs";
import { formatEther, isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FAUCET, goatChain } from "./chain.ts";
import { gatewayAccount } from "./gateway.ts";

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
const gateway = gatewayAccount().address;
const seller = process.env.SELLER_ADDRESS;
console.log(`Gateway wallet  ${gateway}  ${formatEther(await chain.balance(gateway))} BTC`);
if (seller && isAddress(seller)) console.log(`Seller wallet   ${seller}  ${formatEther(await chain.balance(seller))} BTC`);
console.log(`\nFund the gateway wallet with test BTC at ${FAUCET}`);
