import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { dataPath, chainId, rpcUrl } from "../packages/config/index.js";
import ganache from "ganache";
import { acquireLock } from "../packages/persistence/locks.js";
acquireLock(dataPath, "chain");
const url = new URL(rpcUrl);
if (!["127.0.0.1", "localhost"].includes(url.hostname))
  throw Error("Use an external node for non-local RPC");
mkdirSync(dataPath, { recursive: true });
const keyFile = resolve(dataPath, "node.key");
if (!existsSync(keyFile))
  writeFileSync(keyFile, generatePrivateKey(), { flag: "wx", mode: 0o600 });
const secretKey = readFileSync(keyFile, "utf8").trim();
const server = ganache.server({
  server: { ws: false },
  database: { dbPath: resolve(dataPath, "chain-db") },
  chain: { chainId, hardfork: "shanghai" },
  wallet: { accounts: [{ secretKey, balance: "0x3635c9adc5dea00000" }] },
  logging: { quiet: true },
});
await server.listen(Number(url.port || 8545), "127.0.0.1");
console.log(
  `Private EVM node ${rpcUrl}; chain state stored on disk. No public test mnemonic.`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
process.on("message", (m) => {
  if (m === "shutdown") void server.close().then(() => process.exit(0));
});
process.on("disconnect", () => {
  void server.close().then(() => process.exit(0));
});
