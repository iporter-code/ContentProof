import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import {
  dataDir,
  wallet,
  publicClient,
  demoAccount,
} from "../packages/chain/index.js";
import { hashBytes } from "../packages/protocol/index.js";
import { demoMode, chainId } from "../packages/config/index.js";
import { loadConfiguredSecrets } from "../packages/config/secrets.js";
await loadConfiguredSecrets();
const require = createRequire(import.meta.url);
const solc = require("solc");
const sources = Object.fromEntries(
  ["IdentityRegistry", "ProvenanceRegistry"].map((name) => [
    `${name}.sol`,
    { content: readFileSync(`packages/contracts/${name}.sol`, "utf8") },
  ]),
);
const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: process.env.EVM_VERSION ?? "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};
const output = JSON.parse(
  solc.compile(JSON.stringify(input), {
    import: (path: string) => {
      try {
        return {
          contents: readFileSync(resolve("node_modules", path), "utf8"),
        };
      } catch {
        return { error: `Missing import: ${path}` };
      }
    },
  }),
);
const errors = (output.errors ?? []).filter(
  (e: { severity: string }) => e.severity === "error",
);
if (errors.length) throw new Error(JSON.stringify(errors));
if ((await publicClient.getChainId()) !== chainId)
  throw Error("CHAIN_ID_MISMATCH");
async function deploy(name: string, args: unknown[] = []) {
  const c = output.contracts[`${name}.sol`][name];
  const hash = await wallet(0).deployContract({
    abi: c.abi,
    bytecode: `0x${c.evm.bytecode.object}`,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("DEPLOY_FAILED");
  return {
    address: receipt.contractAddress,
    abi: c.abi,
    block: receipt.blockNumber,
  };
}
const identity = await deploy("IdentityRegistry");
const provenance = await deploy("ProvenanceRegistry", [identity.address]);
for (let i = 1; demoMode && i <= 3; i++) {
  const issuer = demoAccount(i).address;
  const tx = await wallet(0).writeContract({
    address: identity.address,
    abi: identity.abi,
    functionName: "authorizeKey",
    args: [issuer, 1n, issuer],
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
}
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  resolve(dataDir, "deployment.json"),
  JSON.stringify(
    {
      chainId,
      identity: identity.address,
      provenance: provenance.address,
      identityAbi: identity.abi,
      provenanceAbi: provenance.abi,
      blockNumber: String(identity.block),
      codeHash: hashBytes(
        Buffer.from(
          (await publicClient.getCode({ address: provenance.address }))!.slice(
            2,
          ),
          "hex",
        ),
      ),
      identityCodeHash: hashBytes(
        Buffer.from(
          (await publicClient.getCode({ address: identity.address }))!.slice(2),
          "hex",
        ),
      ),
    },
    null,
    2,
  ),
);
console.log(
  `Deployed IdentityRegistry ${identity.address}\nDeployed ProvenanceRegistry ${provenance.address}\nMode: ${demoMode ? "isolated demonstration" : "user-signed business"}. Deployment metadata saved.`,
);
