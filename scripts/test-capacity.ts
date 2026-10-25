import assert from "node:assert/strict";
import sharp from "sharp";
import { performance } from "node:perf_hooks";
import { LocalHarness, saveReport, delay } from "./local-harness.js";
const h = new LocalHarness("capacity", 3084, 8584),
  results: any[] = [];
const raw = Buffer.alloc(2048 * 1536 * 3);
for (let i = 0; i < raw.length; i++)
  raw[i] = (i * 31 + Math.floor(i / 97)) % 256;
const bytes = await sharp(raw, {
  raw: { width: 2048, height: 1536, channels: 3 },
})
  .png()
  .toBuffer();
function form() {
  const f = new FormData();
  f.append("file", new Blob([new Uint8Array(bytes)]), "large-synthetic.png");
  return f;
}
try {
  await h.start();
  const user = await h.identity();
  for (const concurrency of [1, 2, 4, 8, 16]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const start = performance.now();
      const requests = await Promise.all(
        Array.from({ length: concurrency }, async () => {
          const t = performance.now(),
            r = await h.response("/v1/assets", user.token, form()),
            body = await r.json();
          assert([200, 429].includes(r.status), JSON.stringify(body));
          if (r.status === 200) {
            assert.equal(body.data.size, bytes.length);
            assert.equal(body.data.width, 2048);
          } else
            assert(
              ["RESOURCE_BUSY", "CONCURRENCY_LIMIT", "RATE_LIMIT"].includes(
                body.error.code,
              ),
            );
          return {
            status: r.status,
            code: body.error?.code ?? null,
            milliseconds: performance.now() - t,
          };
        }),
      );
      const metrics = await h.call("/v1/system/metrics", user.token);
      assert.equal(metrics.media.active, 0);
      assert.equal(metrics.media.queued, 0);
      assert((await h.response("/health/ready")).ok);
      results.push({
        concurrency,
        repeat,
        elapsedMilliseconds: performance.now() - start,
        success: requests.filter((x) => x.status === 200).length,
        rejected: requests.filter((x) => x.status === 429).length,
        requests,
        apiRss: metrics.memory.rss,
      });
      console.log(
        `Concurrency ${concurrency}, repeat ${repeat}: ${results.at(-1).success} succeeded, ${results.at(-1).rejected} bounded rejections.`,
      );
      await delay(500);
    }
  }
  assert(
    results.some((r) => r.concurrency > 2 && r.rejected > 0),
    "ADMISSION_LIMIT_NOT_EXERCISED",
  );
  // A successful request after the largest burst proves admission counters and
  // worker permits recovered, rather than merely observing 429 responses.
  assert((await h.response("/v1/assets", user.token, form())).ok);
  saveReport("capacity", {
    date: new Date().toISOString(),
    passed: true,
    input: {
      width: 2048,
      height: 1536,
      bytes: bytes.length,
      rawBytes: raw.length,
    },
    results,
    scope:
      "Isolated Windows local burst uploads, 1/2/4/8/16 concurrent requests repeated twice. Measures admission and recovery for one 3MP PNG, not maximum end-to-end chain throughput or multi-host capacity.",
    checks: [
      "only success or explicit bounded-admission errors",
      "all media permits and queues drained after each burst",
      "readiness remained healthy",
      "new upload succeeds after largest burst",
    ],
  });
} finally {
  await h.stop();
}
