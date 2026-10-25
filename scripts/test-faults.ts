import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import sharp from "sharp";
import { importBundle } from "../packages/bundle/index.js";
import { LocalHarness, delay, saveReport } from "./local-harness.js";

const h = new LocalHarness("faults", 3082, 8582),
  checks: string[] = [];
function database(fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(resolve(h.dir, "contentproof.sqlite"));
  try {
    fn(db);
  } finally {
    db.close();
  }
}
try {
  await h.start();
  const user = await h.identity();
  const png = await sharp({
    create: { width: 64, height: 48, channels: 4, background: "#4d756c" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(png)]), "synthetic.png");
  const asset = await h.call("/v1/assets", user.token, form);
  // Snapshot after deployment/enrolment: only claim registration will be reverted.
  const snapshot = await h.rpc("evm_snapshot");
  const draft = await h.call("/v1/drafts/import", user.token, {
    assetDigest: asset.digest,
    fields: { title: "重组恢复合成样本" },
  });
  const signed = await h.sign(draft.id, user);
  const initial = await h.call(
    `/v1/claims/${signed.id}/anchor`,
    user.token,
    {},
  );
  await h.confirmed(initial.jobId, user.token);
  await delay(1000);
  assert.equal(await h.rpc("evm_revert", [snapshot]), true);
  await h.rpc("evm_mine");
  const orphan = await h.call(`/v1/jobs/${initial.jobId}`, user.token);
  assert.equal(orphan.state, "orphaned");
  checks.push(
    "real local EVM rollback marks a previously confirmed job orphaned",
  );
  const repeated = await Promise.all(
    [0, 1, 2].map(() =>
      h.call(`/v1/claims/${signed.id}/anchor`, user.token, {}),
    ),
  );
  assert(repeated.every((j) => j.jobId === initial.jobId));
  await h.confirmed(initial.jobId, user.token, 15000);
  checks.push(
    "orphaned job can be explicitly requeued; concurrent retries share one job",
  );
  const exp = await h.call("/v1/exports", user.token, { target: signed.id });
  for (let i = 0; i < 50; i++) {
    if (
      (await h.call(`/v1/exports/${exp.id}`, user.token)).state === "completed"
    )
      break;
    await delay(200);
  }
  assert.equal(
    (await h.call(`/v1/exports/${exp.id}`, user.token)).state,
    "completed",
  );
  // A second API must fail before it can compete for the same persistent queue.
  const second = fork("dist/server/apps/api/main.js", [], {
    execArgv: [],
    env: { ...h.env, PORT: "3083" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let secondLog = "";
  for (const s of [second.stdout!, second.stderr!])
    s.on("data", (b) => (secondLog += b));
  const secondExit = await new Promise<number | null>((resolve, reject) => {
    const t = setTimeout(() => {
      second.kill();
      reject(Error("SECOND_API_DID_NOT_EXIT"));
    }, 10000);
    second.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
  assert.notEqual(secondExit, 0);
  assert.match(secondLog, /DATA_DIRECTORY_BUSY_API/);
  assert((await h.response("/health/ready")).ok);
  checks.push(
    "exclusive data lock rejects a competing API while original service remains healthy",
  );
  await h.stop();
  // Deterministic persisted crash state: tx was mined but worker failed to save
  // completion; export lease also expired. No active process writes this DB.
  database((db) => {
    db.prepare(
      "UPDATE jobs SET state='submitted',leaseUntil=0,nextAttempt=0 WHERE id=?",
    ).run(initial.jobId);
    db.prepare(
      "UPDATE exports SET state='running',lease='interrupted-fixture',leaseUntil=0,attempts=1,progress=20 WHERE id=?",
    ).run(exp.id);
  });
  await h.start();
  user.token = await user.login();
  const recovered = await h.confirmed(initial.jobId, user.token);
  assert.equal(recovered.state, "confirmed");
  checks.push(
    "submitted job with mined transaction and expired lease recovers idempotently after full restart",
  );
  for (let i = 0; i < 50; i++) {
    if (
      (await h.call(`/v1/exports/${exp.id}`, user.token)).state === "completed"
    )
      break;
    await delay(200);
  }
  const download = await h.response(
    `/v1/exports/${exp.id}/content`,
    user.token,
  );
  assert(download.ok);
  assert.equal(
    (await importBundle(new Uint8Array(await download.arrayBuffer()))).target,
    signed.id,
  );
  checks.push(
    "interrupted export with expired lease is rebuilt into a readable authenticated evidence bundle",
  );
  await delay(1200);
  const status = await h.call("/v1/chain/status");
  assert(status.index);
  const block = await h.rpc("eth_getBlockByNumber", [
    `0x${BigInt(status.index.blockNumber).toString(16)}`,
    false,
  ]);
  assert.equal(status.index.blockHash, block.hash);
  checks.push(
    "event checkpoint converges to the canonical block hash after rollback and restart",
  );
  saveReport("fault-recovery", {
    date: new Date().toISOString(),
    passed: true,
    checks,
    scope:
      "Isolated non-demo Ganache chain rollback and injected durable queue interruption states. Not Byzantine QBFT, arbitrary process crash timing, power-loss or cross-host fault coverage.",
  });
  console.log(`${checks.length} local fault recovery checks passed.`);
} finally {
  await h.stop();
}
