import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { LocalHarness, saveReport } from "./local-harness.js";
import { hashBytes } from "../packages/protocol/index.js";
const h = new LocalHarness("media-boundaries", 3091, 8591),
  checks: string[] = [],
  measurements: any[] = [];
function form(bytes: Uint8Array, name: string) {
  const f = new FormData();
  f.append("file", new Blob([new Uint8Array(bytes)]), name);
  return f;
}
try {
  await h.start();
  const user = await h.identity();
  const raw = Buffer.alloc(3000 * 2000 * 3);
  let seed = 0x63af3912;
  for (let i = 0; i < raw.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    raw[i] = seed & 255;
  }
  const noisy = await sharp(raw, {
    raw: { width: 3000, height: 2000, channels: 3 },
  })
    .png()
    .toBuffer();
  assert(noisy.length > 17 * 1024 * 1024 && noisy.length < 20 * 1024 * 1024);
  let start = performance.now();
  const asset = await h.call(
    "/v1/assets",
    user.token,
    form(noisy, "synthetic-6mp.png"),
  );
  assert.equal(asset.digest, hashBytes(noisy));
  assert.equal(asset.width, 3000);
  assert.equal(asset.height, 2000);
  measurements.push({
    stage: "6MP-upload",
    bytes: noisy.length,
    milliseconds: performance.now() - start,
  });
  const root = await h.sign(
    (
      await h.call("/v1/drafts/import", user.token, {
        assetDigest: asset.digest,
        fields: { title: "大文件合成验收" },
      })
    ).id,
    user,
  );
  await h.confirmed(
    (await h.call(`/v1/claims/${root.id}/anchor`, user.token, {})).jobId,
    user.token,
  );
  start = performance.now();
  const transformed = await h.call("/v1/drafts/transform", user.token, {
    parents: [root.id],
    operation: "resize",
    params: { width: 1500, height: 1000 },
    fields: { title: "大文件缩放验收" },
  });
  const derived = await h.sign(transformed.id, user);
  await h.confirmed(
    (await h.call(`/v1/claims/${derived.id}/anchor`, user.token, {})).jobId,
    user.token,
  );
  const exported = await h.response("/v1/bundles", user.token, {
    target: derived.id,
    hideFields: [],
    hideParents: [],
  });
  assert(exported.ok);
  const bundle = new Uint8Array(await exported.arrayBuffer());
  const verified = await h.call(
    "/v1/verify",
    user.token,
    form(bundle, "synthetic-large.zip"),
  );
  assert.equal(verified.outcome, "pass");
  assert.equal(verified.checks.transformation, "reproduced");
  measurements.push({
    stage: "large-transform-anchor-export-verify",
    bundleBytes: bundle.length,
    milliseconds: performance.now() - start,
  });
  checks.push(
    "incompressible 6MP PNG above 17MiB completes upload, encryption, signature, anchor, resize, bundle export and reproduction",
  );
  const atLimit = await sharp({
    create: { width: 5000, height: 4000, channels: 3, background: "#4e758a" },
  })
    .png()
    .toBuffer();
  start = performance.now();
  const accepted = await h.call(
    "/v1/assets",
    user.token,
    form(atLimit, "synthetic-20mp.png"),
  );
  assert.equal(accepted.width * accepted.height, 20_000_000);
  measurements.push({
    stage: "20MP-pixel-limit-upload",
    bytes: atLimit.length,
    milliseconds: performance.now() - start,
  });
  checks.push(
    "exactly 20,000,000 pixels are accepted and fully decoded within the configured limit",
  );
  const tooMany = await sharp({
    create: { width: 5001, height: 4000, channels: 3, background: "#4e758a" },
  })
    .png()
    .toBuffer();
  const pixels = await h.response(
    "/v1/assets",
    user.token,
    form(tooMany, "synthetic-over-pixels.png"),
  );
  assert.equal(pixels.status, 413);
  assert.equal((await pixels.json()).error.code, "MEDIA_DIMENSION_LIMIT");
  checks.push("20,004,000 pixels return explicit 413 MEDIA_DIMENSION_LIMIT");
  const tooLarge = Buffer.alloc(20 * 1024 * 1024 + 1);
  noisy.copy(tooLarge);
  const bytes = await h.response(
    "/v1/assets",
    user.token,
    form(tooLarge, "synthetic-over-bytes.png"),
  );
  assert.equal(bytes.status, 413);
  assert.equal((await bytes.json()).error.code, "FST_REQ_FILE_TOO_LARGE");
  checks.push(
    "20MiB plus one byte is rejected by the multipart limit with 413",
  );
  assert.equal(
    (
      await h.call(
        "/v1/assets",
        user.token,
        form(atLimit, "synthetic-after-limits.png"),
      )
    ).digest,
    hashBytes(atLimit),
  );
  const metrics = await h.call("/v1/system/metrics", user.token);
  assert.equal(metrics.media.active, 0);
  assert.equal(metrics.media.queued, 0);
  assert((await h.response("/health/ready")).ok);
  checks.push(
    "service accepts a valid upload after both rejections and media permits drain",
  );
  saveReport("media-boundaries", {
    date: new Date().toISOString(),
    passed: true,
    checks,
    measurements,
    scope:
      "Synthetic 6MP incompressible PNG, exact 20MP compressed PNG and explicit byte/pixel rejection boundaries. Not arbitrary image codec coverage, maximum concurrency, saturation throughput or cross-host performance.",
  });
  console.log(
    `${checks.length} real large-file and media-boundary checks passed.`,
  );
} finally {
  await h.stop();
}
