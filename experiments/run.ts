import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { cpus, totalmem, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { importBundle, exportBundle } from "../packages/bundle/index.js";
import {
  hashBytes,
  verify,
  jcs,
  claimId,
  signer,
  type Manifest,
} from "../packages/protocol/index.js";
import { reproduce } from "../packages/media/index.js";
import { publicClient, deployment } from "../packages/chain/index.js";
const fullBytes = readFileSync("data/demo/full.zip"),
  privateBytes = readFileSync("data/demo/private.zip");
const full = await importBundle(fullBytes),
  hidden = await importBundle(privateBytes);
const rows: Record<string, unknown>[] = [];
async function measure(name: string, fn: () => Promise<unknown> | unknown) {
  for (let i = 0; i < 3; i++) await fn();
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    await fn();
    rows.push({
      kind: "performance",
      name,
      iteration: i,
      milliseconds: performance.now() - start,
    });
  }
  console.log("Measured", name);
}
const m = full.manifests.get(full.target)!,
  bytes = full.files.get(m.core.assetDigest)!;
await measure("B0_hash_only", () => hashBytes(bytes));
await measure("B1_signed_statement_only", async () => {
  hashBytes(bytes);
  await signer(m);
});
await measure("B2_full_disclosure_offline", () =>
  verify(full.target, { ...full, reproduce }),
);
await measure("Ours_selective_disclosure_offline", () =>
  verify(hidden.target, { ...hidden, reproduce }),
);
await measure("bundle_import_full", () => importBundle(fullBytes));
await measure("bundle_export_full", () => exportBundle(full));
await measure("operation_reproduction_full", () =>
  reproduce(
    m,
    m.disclosure.parents.map((p) => full.manifests.get(p.parent!.claimId)!),
    full.files,
  ),
);
for (const [n, b] of [
  ["full", full],
  ["selective", hidden],
] as const) {
  const report = await verify(b.target, { ...b, reproduce });
  rows.push({
    kind: "coverage",
    name: n,
    bytes: n === "full" ? fullBytes.length : privateBytes.length,
    nodes: b.manifests.size,
    fields: [...b.manifests.values()].reduce(
      (v, m) => v + m.disclosure.fields.length,
      0,
    ),
    outcome: report.outcome,
    checks: report.checks,
  });
}
const attacks: { name: string; mutate: (b: typeof full) => void }[] = [
  {
    name: "file_change",
    mutate: (b) => b.files.set(m.core.assetDigest, Buffer.from("altered")),
  },
  {
    name: "parent_replacement",
    mutate: (b) => {
      b.manifests.get(b.target)!.disclosure.parents[0].parent!.claimId = ("0x" +
        "11".repeat(32)) as `0x${string}`;
    },
  },
  {
    name: "field_change",
    mutate: (b) => {
      b.manifests.get(b.target)!.disclosure.fields[0].value = "altered";
    },
  },
  {
    name: "parent_missing",
    mutate: (b) => {
      b.manifests.delete(m.disclosure.parents[0].parent!.claimId);
    },
  },
];
for (const attack of attacks) {
  const b = {
    target: full.target,
    files: new Map(full.files),
    manifests: new Map(
      [...full.manifests].map(([id, m]) => [id, structuredClone(m)]),
    ),
  };
  attack.mutate(b);
  const own = await verify(b.target, { ...b, reproduce });
  const candidate = b.manifests.get(b.target)!;
  const hashOnly =
    hashBytes(b.files.get(candidate.core.assetDigest)!) === m.core.assetDigest;
  let signed = true;
  try {
    signed =
      (await signer(candidate)) === (await signer(m)) &&
      claimId(candidate) === claimId(m);
  } catch {
    signed = false;
  }
  rows.push({
    kind: "attack",
    name: attack.name,
    hashOnly: hashOnly ? "file-match-only" : "file-mismatch",
    signedStatement: signed ? "signature-match-only" : "signature-mismatch",
    ours: own.outcome,
    ancestry: own.checks.ancestry,
    reason: own.reasons.map((r) => r.code),
  });
}
// Explicitly scoped ablations: roots still bind disclosed values; changing a check only belongs in this experiment.
const noChain = await verify(full.target, { ...full, reproduce });
rows.push({
  kind: "ablation",
  name: "online_check_removed",
  outcome: noChain.outcome,
  anchor: noChain.checks.anchor,
});
const summaries = [
  ...new Set(
    rows.filter((r) => r.kind === "performance").map((r) => String(r.name)),
  ),
].map((name) => {
  const values = rows
    .filter((r) => r.kind === "performance" && r.name === name)
    .map((r) => Number(r.milliseconds))
    .sort((a, b) => a - b);
  return {
    name,
    n: values.length,
    medianMs: values[Math.floor(values.length / 2)],
    p95Ms: values[Math.ceil(values.length * 0.95) - 1],
  };
});
const gas: unknown[] = [];
try {
  const d = deployment();
  const logs = await publicClient.getLogs({
    address: d.provenance,
    fromBlock: BigInt(d.blockNumber),
    toBlock: "latest",
  });
  const seen = new Set<string>();
  for (const l of logs) {
    if (seen.has(l.transactionHash!)) continue;
    seen.add(l.transactionHash!);
    const receipt = await publicClient.getTransactionReceipt({
      hash: l.transactionHash!,
    });
    gas.push({
      txHash: l.transactionHash,
      gasUsed: String(receipt.gasUsed),
      status: receipt.status,
    });
  }
} catch {}
const metadata = {
  date: new Date().toISOString(),
  node: process.version,
  os: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model,
  memoryBytes: totalmem(),
  sample: "generated demo images, 4-node graph",
  warmup: 3,
  repetitions: 30,
  limitations:
    "Local microbenchmark; selective disclosure has fewer inputs and cannot reproduce hidden operations. No scale or universal performance claims.",
};
mkdirSync("data/results", { recursive: true });
writeFileSync(
  "data/results/raw.jsonl",
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
);
writeFileSync(
  "data/results/performance.csv",
  "name,n,median_ms,p95_ms\n" +
    summaries
      .map((r) => `${r.name},${r.n},${r.medianMs},${r.p95Ms}`)
      .join("\n"),
);
writeFileSync(
  "data/results/summary.json",
  JSON.stringify(
    {
      metadata,
      summaries,
      gas,
      security: rows.filter((r) => r.kind === "attack"),
    },
    null,
    2,
  ),
);
const max = Math.max(...summaries.map((x) => x.p95Ms));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="420" viewBox="0 0 1000 420"><rect width="1000" height="420" fill="#f5f7f2"/><text x="30" y="36" font-family="sans-serif" font-size="21" fill="#174f41">ContentProof local microbenchmark · p95 (ms)</text>${summaries.map((x, i) => `<text x="30" y="${85 + i * 42}" font-family="monospace" font-size="12">${x.name}</text><rect x="355" y="${69 + i * 42}" width="${Math.max(1, (x.p95Ms / max) * 520)}" height="23" rx="3" fill="#426959"/><text x="${365 + Math.max(1, (x.p95Ms / max) * 520)}" y="${85 + i * 42}" font-family="monospace" font-size="12">${x.p95Ms.toFixed(2)}</text>`).join("")}<text x="30" y="395" font-family="sans-serif" font-size="11">30 runs after 3 warmups; different checks and disclosure coverage, not equivalent security guarantees.</text></svg>`;
writeFileSync("data/results/performance.svg", svg);
console.log(JSON.stringify({ metadata, summaries }, null, 2));
