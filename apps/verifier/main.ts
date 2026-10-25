import { readFileSync, writeFileSync } from "node:fs";
import { importBundle } from "../../packages/bundle/index.js";
import {
  verify,
  hashBytes,
  type Manifest,
  type Observation,
} from "../../packages/protocol/index.js";
import { reproduce } from "../../packages/media/index.js";
import type { Address } from "viem";
import { policySchema } from "../../packages/protocol/policy.js";
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
async function main() {
  const command = args[0],
    file = args[1];
  if (
    !file ||
    !["verify", "verify-c2pa", "inspect", "hash"].includes(command)
  ) {
    console.log(
      "Usage: npm run verify -- verify bundle.zip [--asset final.png] [--offline] [--rpc URL] [--policy policy.json] [--json] [--output report.json]\n       npm run verify -- verify-c2pa asset.png [--output report.json]\n       npm run verify -- inspect bundle.zip\n       npm run verify -- hash image.png",
    );
    return 2;
  }
  if (command === "hash") {
    console.log(hashBytes(readFileSync(file)));
    return 0;
  }
  if (command === "verify-c2pa") {
    const { verifyC2pa, C2PA_MAX_BYTES } =
      await import("../../packages/c2pa/index.js");
    const { statSync } = await import("node:fs");
    if (statSync(file).size > C2PA_MAX_BYTES)
      throw Error("C2PA_ASSET_SIZE_LIMIT");
    const report = await verifyC2pa(readFileSync(file)),
      output = JSON.stringify(report, null, 2);
    if (option("--output")) writeFileSync(option("--output")!, output);
    console.log(output);
    return report.outcome === "pass" ? 0 : report.outcome === "fail" ? 1 : 3;
  }
  const bundle = await importBundle(readFileSync(file));
  if (command === "inspect") {
    console.log(
      JSON.stringify(
        {
          target: bundle.target,
          claims: [...bundle.manifests.keys()],
          files: [...bundle.files.keys()],
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const asset = option("--asset");
  if (asset) {
    const root = bundle.manifests.get(bundle.target)!;
    bundle.files.set(root.core.assetDigest, readFileSync(asset));
  }
  if (option("--rpc")) process.env.RPC_URL = option("--rpc");
  const policyPath = option("--policy");
  const policy = policyPath
    ? policySchema.parse(JSON.parse(readFileSync(policyPath, "utf8")))
    : undefined;
  const chain = await import("../../packages/chain/index.js");
  const observer = args.includes("--offline")
    ? undefined
    : async (m: Manifest, address: Address): Promise<Observation> => {
        if (
          policy &&
          ((policy.chainId !== undefined &&
            policy.chainId !== m.domain.chainId) ||
            (policy.verifyingContract &&
              policy.verifyingContract.toLowerCase() !==
                m.domain.verifyingContract.toLowerCase()) ||
            (policy.trustedIssuers &&
              !policy.trustedIssuers.some(
                (a) => a.toLowerCase() === m.core.issuer.toLowerCase(),
              )))
        )
          return { anchor: "mismatch", identity: "unknown" };
        return chain.observe(m, address);
      };
  const report = await verify(bundle.target, {
    ...bundle,
    reproduce,
    policy,
    observe: observer,
  });
  const output = JSON.stringify(report, null, 2);
  if (option("--output")) writeFileSync(option("--output")!, output);
  if (args.includes("--json")) console.log(output);
  else {
    console.log(
      `ContentProof: ${report.outcome.toUpperCase()}\n${report.claimId}`,
    );
    for (const [k, v] of Object.entries(report.checks))
      console.log(`  ${k}: ${v}`);
    for (const reason of report.reasons)
      console.log(`  ${reason.code}: ${reason.message}`);
  }
  return report.outcome === "pass" ? 0 : report.outcome === "fail" ? 1 : 3;
}
try {
  process.exitCode = await main();
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 2;
}
