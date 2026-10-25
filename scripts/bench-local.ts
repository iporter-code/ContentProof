import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { platform, arch, cpus, totalmem } from "node:os";
import sharp from "sharp";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  LocalHarness,
  delay,
  saveReport,
  resultsDir,
} from "./local-harness.js";
import { importBundle } from "../packages/bundle/index.js";
import { hashBytes } from "../packages/protocol/index.js";
import { execute as native } from "../packages/media/index.js";
import { verifySnapshotManifest } from "../packages/operations/snapshot.js";
import {
  execute as isolated,
  stopMediaWorkers,
} from "../packages/media/isolated.js";

const seconds = Number(process.env.CP_SOAK_SECONDS ?? 600);
const reauthSeconds = Number(process.env.CP_SOAK_REAUTH_SECONDS ?? 1800);
assert(
  Number.isSafeInteger(reauthSeconds) &&
    reauthSeconds >= 15 &&
    reauthSeconds <= 1800,
  "INVALID_SOAK_REAUTH_INTERVAL",
);
const reportName = process.env.CP_SOAK_REPORT ?? "local-performance";
assert(/^[a-z][a-z0-9-]{0,48}$/.test(reportName), "INVALID_SOAK_REPORT_NAME");
const stopFile = resolve(resultsDir, `${reportName}.stop`);
assert(!existsSync(stopFile), "SOAK_STOP_FILE_ALREADY_EXISTS");
assert(
  Number.isSafeInteger(seconds) && seconds >= 30 && seconds <= 86400,
  "CP_SOAK_SECONDS must be 30..86400",
);
const h = new LocalHarness("soak", 3081, 8581),
  latency: Record<string, number[]> = {},
  memory: any[] = [],
  errors: string[] = [];
let completed = 0,
  reauthentications = 0,
  activeStart = 0,
  monotonicStart = 0;
const progress = () =>
  saveReport(`${reportName}-progress`, {
    date: new Date().toISOString(),
    status: activeStart ? "running" : "preparing",
    passed: false,
    pid: process.pid,
    targetSeconds: seconds,
    elapsedSeconds: activeStart ? (Date.now() - activeStart) / 1000 : 0,
    completedWorkflows: completed,
    reauthentications,
    stopFile,
    lastSample: memory.at(-1) ?? null,
    errors,
  });
function stats(values: number[]) {
  const a = [...values].sort((a, b) => a - b);
  return {
    n: a.length,
    p50: a[Math.ceil(a.length * 0.5) - 1] ?? 0,
    p95: a[Math.ceil(a.length * 0.95) - 1] ?? 0,
    p99: a[Math.ceil(a.length * 0.99) - 1] ?? 0,
  };
}
async function timed<T>(name: string, fn: () => Promise<T>) {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    (latency[name] ??= []).push(performance.now() - t);
  }
}
const raw = Buffer.alloc(256 * 192 * 3);
for (let i = 0; i < raw.length; i++)
  raw[i] = (i * 13 + Math.floor(i / 31)) % 256;
const png = await sharp(raw, { raw: { width: 256, height: 192, channels: 3 } })
  .png()
  .toBuffer();
const ablation: any[] = [];
try {
  const snapshotDigest =
    process.env.CP_SOAK_SNAPSHOT === "required"
      ? verifySnapshotManifest(process.cwd())
      : null;
  progress();
  // Same deterministic edit and exact bytes, changing only process isolation.
  for (const [name, execute] of [
    ["in-process", native],
    ["isolated-process", isolated],
  ] as const) {
    const ms: number[] = [];
    let digest = "";
    for (let i = 0; i < 4; i++) {
      const t = performance.now();
      const out = await execute("resize", [png], { width: 128, height: 96 });
      if (i) ms.push(performance.now() - t);
      digest = hashBytes(out);
    }
    ablation.push({ mode: name, milliseconds: stats(ms), digest });
  }
  assert.equal(ablation[0].digest, ablation[1].digest);
  stopMediaWorkers();
  await h.start();
  const apiSpecification = await h.response("/v1/openapi.json");
  assert(apiSpecification.ok, "SOAK_RUNTIME_OPENAPI_UNAVAILABLE");
  assert.equal((await apiSpecification.json()).openapi, "3.1.0");
  const user = await h.identity();
  // Closed loop paced below configured 180/minute abuse limit. This measures
  // supported workflows and stability, not unrestricted saturation throughput.
  const call = (name: string, path: string, body?: unknown) =>
    timed(name, () => h.call(path, user.token, body));
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(png)]), "synthetic-soak.png");
  const asset = await call("upload", "/v1/assets", form);
  const rootDraft = await call("draft-import", "/v1/drafts/import", {
    assetDigest: asset.digest,
    fields: { title: "持续运行原始素材" },
  });
  const root = await h.sign(rootDraft.id, user),
    rootJob = await call("queue-anchor", `/v1/claims/${root.id}/anchor`, {});
  await h.confirmed(rootJob.jobId, user.token);
  activeStart = Date.now();
  monotonicStart = performance.now();
  let lastCycleAt = activeStart;
  let renewAt = activeStart + reauthSeconds * 1000;
  let next = activeStart;
  while (Date.now() - activeStart < seconds * 1000 && !existsSync(stopFile)) {
    try {
      const cycleAt = Date.now();
      assert(
        Math.abs(
          cycleAt - activeStart - (performance.now() - monotonicStart),
        ) <= 5000,
        "SOAK_WALL_CLOCK_CHANGED",
      );
      assert(
        cycleAt >= lastCycleAt && cycleAt - lastCycleAt <= 120000,
        "SOAK_CONTINUITY_GAP_OR_CLOCK_CHANGE",
      );
      lastCycleAt = cycleAt;
      if (Date.now() >= renewAt) {
        await timed("session-renewal", async () => {
          const previous = user.token;
          user.token = await user.login();
          await h.call("/v1/auth/logout", previous, {});
          await h.call("/v1/profile", user.token);
          reauthentications++;
        });
        renewAt = Date.now() + reauthSeconds * 1000;
      }
      const cycleStart = performance.now();
      const draft = await call("transform", "/v1/drafts/transform", {
        parents: [root.id],
        operation: "resize",
        params: { width: 120 + (completed % 3), height: 90 },
        fields: { title: `持续运行合成样本 ${completed}` },
      });
      const signed = await timed("prepare-and-sign", () =>
        h.sign(draft.id, user),
      );
      const job = await call(
        "queue-anchor",
        `/v1/claims/${signed.id}/anchor`,
        {},
      );
      await timed("anchor-confirmation", () =>
        h.confirmed(job.jobId, user.token),
      );
      const exported = await timed("export", async () => {
        const r = await h.response("/v1/bundles", user.token, {
          target: signed.id,
          hideFields: [],
          hideParents: [],
        });
        assert(r.ok);
        return new Uint8Array(await r.arrayBuffer());
      });
      const bundle = await importBundle(exported);
      assert.equal(bundle.target, signed.id);
      const verifyForm = new FormData();
      verifyForm.append("file", new Blob([exported]), "synthetic-evidence.zip");
      const report = await call(
        "verify-real-chain-and-images",
        "/v1/verify",
        verifyForm,
      );
      assert.equal(report.outcome, "pass");
      assert.equal(report.checks.transformation, "reproduced");
      // Two simultaneous authorized read requests exercise ordinary concurrency.
      await timed("parallel-pages", () =>
        Promise.all([
          h.call("/v1/assets/page?limit=10", user.token),
          h.call("/v1/claims/page?limit=10", user.token),
        ]),
      );
      const metrics = await h.call("/v1/system/metrics", user.token);
      assert.deepEqual(
        metrics.alerts,
        [],
        "BACKGROUND_WORKER_ALERT_DURING_SOAK",
      );
      memory.push({
        elapsedSeconds: (Date.now() - activeStart) / 1000,
        rss: metrics.memory.rss,
        heapUsed: metrics.memory.heapUsed,
        media: metrics.media,
        requests: metrics.requests,
      });
      (latency["complete-workflow"] ??= []).push(
        performance.now() - cycleStart,
      );
      completed++;
      progress();
      if (completed % 3 === 0)
        console.log(
          `Soak: ${completed} complete workflows, ${Math.round((Date.now() - activeStart) / 1000)} seconds.`,
        );
    } catch (e) {
      errors.push((e as Error).message);
      throw e;
    }
    next += 15000;
    await delay(
      Math.max(0, Math.min(next, activeStart + seconds * 1000) - Date.now()),
    );
  }
  const after = await h.call("/v1/system/metrics", user.token);
  assert(
    Date.now() >= lastCycleAt && Date.now() - lastCycleAt <= 120000,
    "SOAK_CONTINUITY_GAP_OR_CLOCK_CHANGE",
  );
  assert.equal(after.media.active, 0);
  assert.equal(after.media.queued, 0);
  assert(completed >= 1);
  assert(
    Math.abs(Date.now() - activeStart - (performance.now() - monotonicStart)) <=
      5000,
    "SOAK_WALL_CLOCK_CHANGED",
  );
  if (snapshotDigest)
    assert.equal(verifySnapshotManifest(process.cwd()), snapshotDigest);
  const durations = latency["complete-workflow"],
    elapsed = (Date.now() - activeStart) / 1000;
  const cancelled = existsSync(stopFile);
  const report = {
    date: new Date().toISOString(),
    passed: errors.length === 0 && !cancelled,
    status: cancelled ? "cancelled" : "completed",
    targetSeconds: seconds,
    durationSeconds: elapsed,
    completedWorkflows: completed,
    reauthentications,
    snapshotDigest,
    workflowsPerMinute: (completed / elapsed) * 60,
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    workload: {
      image: "256x192 deterministic synthetic RGB PNG",
      parallelReads: 2,
      paceMilliseconds: 15000,
      reauthenticationSeconds: reauthSeconds,
      maximumCycleGapSeconds: 120,
      chain: "isolated persistent Ganache",
      scope:
        "Measured paced local end-to-end workflows, real EVM writes and real image reproduction. Not maximum capacity, long-duration production SLA or QBFT throughput.",
    },
    latencyMilliseconds: Object.fromEntries(
      Object.entries(latency).map(([k, v]) => [k, stats(v)]),
    ),
    memory: {
      scope: "API process only; excludes temporary media children and chain",
      samples: memory,
      peakRss: Math.max(...memory.map((x) => x.rss)),
      rssFirst: memory[0].rss,
      rssLast: memory.at(-1).rss,
    },
    processIsolationAblation: ablation,
    errors,
    checks: [
      "every workflow signs, anchors, exports and independently verifies real image bytes",
      "parallel authorized pagination succeeds",
      "all media permits and queues drain at the end",
      ...(reauthentications
        ? [
            "renewed challenge signatures replace and revoke old sessions before their one-hour expiry",
          ]
        : []),
    ],
  };
  saveReport(reportName, report);
  saveReport(`${reportName}-progress`, {
    date: new Date().toISOString(),
    status: report.status,
    passed: report.passed,
    pid: process.pid,
    targetSeconds: seconds,
    elapsedSeconds: elapsed,
    completedWorkflows: completed,
    reauthentications,
    lastSample: memory.at(-1),
    errors,
  });
  console.log(
    `${report.status}: ${completed} real workflows over ${elapsed.toFixed(1)} seconds; median ${stats(durations).p50.toFixed(0)} ms.`,
  );
} catch (error) {
  saveReport(`${reportName}-diagnostics`, h.diagnostics());
  const message = (error as Error).message;
  if (!errors.includes(message)) errors.push(message);
  const failed = {
    date: new Date().toISOString(),
    status: "failed",
    passed: false,
    pid: process.pid,
    targetSeconds: seconds,
    elapsedSeconds: activeStart ? (Date.now() - activeStart) / 1000 : 0,
    completedWorkflows: completed,
    reauthentications,
    errors,
  };
  saveReport(reportName, failed);
  saveReport(`${reportName}-progress`, failed);
  throw error;
} finally {
  stopMediaWorkers();
  await h.stop();
}
