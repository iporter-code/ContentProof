import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importBundle } from "../packages/bundle/index.js";
import { claimId, signer, hashBytes } from "../packages/protocol/index.js";
import { observe, publicClient } from "../packages/chain/index.js";
import { apiPort, dataPath } from "../packages/config/index.js";

// Run after test-business and a full service/container restart. No original
// user's private key or authenticated session is retained by this check.
const target = JSON.parse(
  readFileSync(resolve(dataPath, "results/persistence-target.json"), "utf8"),
);
const bundle = await importBundle(
  readFileSync(resolve(dataPath, "results/persisted.zip")),
);
const original = bundle.manifests.get(target.claimId);
assert(original, "ORIGINAL_MANIFEST_MISSING");
assert.equal(claimId(original), target.claimId);
assert.equal(
  hashBytes(bundle.files.get(original.core.assetDigest)!),
  original.core.assetDigest,
);
const observation = await observe(original, await signer(original));
assert.equal(observation.anchor, "confirmed");
const height = await publicClient.getBlockNumber({ cacheTime: 0 });
assert(height >= BigInt(target.blockNumber));
assert((await fetch(`http://127.0.0.1:${apiPort}/health/ready`)).ok);
const db = new DatabaseSync(resolve(dataPath, "contentproof.sqlite"), {
  readOnly: true,
});
try {
  assert.equal(
    Number((db.prepare("PRAGMA user_version").get() as any).user_version),
    6,
  );
  assert(db.prepare("SELECT id FROM claims WHERE id=?").get(target.claimId));
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
} finally {
  db.close();
}
const report = {
  date: new Date().toISOString(),
  passed: true,
  claimId: target.claimId,
  height: String(height),
  checks: [
    "original persisted evidence bytes and manifest match signed digest",
    "original on-chain record remains confirmed after full restart",
    "chain height retained and readiness healthy",
    "schema v6 and original database claim retained, foreign keys valid",
  ],
};
writeFileSync(
  resolve(
    dataPath,
    `results/${process.argv.includes("--container") ? "container-persistence" : "persistence"}.json`,
  ),
  JSON.stringify(report, null, 2),
);
console.log(`${report.checks.length} restart persistence checks passed.`);
