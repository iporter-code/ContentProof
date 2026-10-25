import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { platform, arch } from "node:os";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  prepare,
  claimId,
  disclose,
  typedData,
  verify,
  hashBytes,
  salt,
  ZERO,
  type Manifest,
  type PrivateManifest,
} from "../packages/protocol/index.js";
const account = privateKeyToAccount(generatePrivateKey()),
  domain = {
    name: "ContentProof",
    version: "1",
    chainId: 31337,
    verifyingContract: "0x0000000000000000000000000000000000001234",
  } as const,
  bytes = Buffer.from("protocol-only-scale-fixture");
let sequence = 0;
async function node(parents: PrivateManifest[] = []) {
  const p = prepare(
    {
      protocol: "contentproof/1",
      assetDigest: hashBytes(bytes),
      mediaType: "image/png",
      byteLength: bytes.length,
      operation:
        parents.length === 2 ? "compose" : parents.length ? "crop" : "import",
      engineDigest: parents.length
        ? hashBytes(Buffer.from("benchmark-engine"))
        : ZERO,
      issuer: account.address,
      keyEpoch: "1",
      nonce: String(sequence++),
      deadline: "2000000000",
    },
    [{ path: "title", value: sequence, salt: salt() }],
    parents.map((m, i) => ({
      claimId: claimId(m),
      assetDigest: m.core.assetDigest as `0x${string}`,
      role: `input-${i}`,
      salt: salt(),
    })),
  );
  const full: any = {
    core: p.core,
    domain,
    signature: await account.signTypedData(typedData(p.core, domain)),
    privateFields: p.fields,
    privateParents: p.parents,
  };
  full.disclosure = disclose(full).disclosure;
  return full as PrivateManifest;
}
const rows: any[] = [];
for (const count of [10, 100, 1000]) {
  const manifests = new Map<string, Manifest>();
  let layer: PrivateManifest[] = [];
  const add = (m: PrivateManifest) => {
    manifests.set(claimId(m), disclose(m));
    return m;
  };
  for (let i = 0; i < count / 2; i++) layer.push(add(await node()));
  const first = layer[0];
  while (layer.length > 1) {
    const next: PrivateManifest[] = [];
    for (let i = 0; i < layer.length; i += 2)
      next.push(
        i + 1 === layer.length
          ? layer[i]
          : add(await node(layer.slice(i, i + 2))),
      );
    layer = next;
  }
  const root = add(await node([layer[0], first]));
  if (manifests.size !== count) throw Error("FIXTURE_COUNT");
  const durations: number[] = [];
  let peakRss = process.memoryUsage().rss;
  for (let repeat = 0; repeat < 3; repeat++) {
    const timer = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 20),
      start = performance.now();
    try {
      const result = await verify(claimId(root), {
        manifests,
        files: new Map([[root.core.assetDigest, bytes]]),
        observe: async () => ({ anchor: "confirmed", identity: "active" }),
        reproduce: async () => "reproduced",
      });
      if (result.outcome !== "pass") throw Error("BENCHMARK_INVALID_GRAPH");
      durations.push(performance.now() - start);
    } finally {
      clearInterval(timer);
    }
  }
  const targetOnly = await verify(claimId(root), {
    manifests: new Map([[claimId(root), disclose(root)]]),
    files: new Map([[root.core.assetDigest, bytes]]),
  });
  rows.push({
    nodes: count,
    repeat: 3,
    milliseconds: durations,
    medianMs: [...durations].sort((a, b) => a - b)[1],
    peakRssBytes: peakRss,
    missingAncestorOutcome: targetOnly.outcome,
  });
  console.log(
    `${count} protocol nodes checked, median ${rows.at(-1).medianMs.toFixed(1)} ms`,
  );
}
mkdirSync("data/app/results", { recursive: true });
writeFileSync(
  "data/app/results/scale-protocol.json",
  JSON.stringify(
    {
      date: new Date().toISOString(),
      scope:
        "Protocol SHA256/Merkle/EIP712/DAG only. Online observer and media reproduction are stubs; no chain or media throughput claim.",
      node: process.version,
      platform: platform(),
      arch: arch(),
      rows,
    },
    null,
    2,
  ),
);
