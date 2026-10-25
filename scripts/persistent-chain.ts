import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  dataPath,
  chainId,
  rpcUrl,
  demoMode,
} from "../packages/config/index.js";
import ganache from "@ganache/core";
import { acquireLock } from "../packages/persistence/locks.js";
import { referenceWallet } from "../packages/chain/reference-wallet.js";
acquireLock(dataPath, "chain");
const url = new URL(rpcUrl);
if (!["127.0.0.1", "localhost"].includes(url.hostname))
  throw Error("Use an external node for non-local RPC");
mkdirSync(dataPath, { recursive: true });
const server = ganache.server({
  server: { ws: false },
  database: { dbPath: resolve(dataPath, "chain-db") },
  chain: { chainId, hardfork: "shanghai" },
  wallet: referenceWallet(dataPath, demoMode),
  logging: { quiet: true },
});
await server.listen(Number(url.port || 8545), "127.0.0.1");
console.log(
  `${demoMode ? "Explicit demo" : "Private"} EVM node ${rpcUrl}; chain state stored on disk. ${demoMode ? "Public test accounts enabled for demo only." : "No public test mnemonic."}`,
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
