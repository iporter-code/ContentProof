import { it, expect, afterAll } from "vitest";
import sharp from "sharp";
import { ProcessJobs } from "../packages/media/process-jobs.js";
import { ResourcePool } from "../packages/media/resources.js";
import {
  inspect,
  execute,
  stopMediaWorkers,
} from "../packages/media/isolated.js";
afterAll(() => stopMediaWorkers());
it("an oversized pixel header returns the explicit dimension limit before decoding", async () => {
  const oversized = await sharp({
    create: { width: 5001, height: 4000, channels: 3, background: "#345678" },
  })
    .png()
    .toBuffer();
  await expect(inspect(oversized)).rejects.toThrow("MEDIA_DIMENSION_LIMIT");
});
it("child crash and timeout are contained and the next job remains usable", async () => {
  const pool = new ProcessJobs(
    new URL("./fixtures/media-job-worker.mjs", import.meta.url),
    new ResourcePool(1, 1),
    1000,
  );
  try {
    await expect(pool.run("crash")).rejects.toThrow("MEDIA_WORKER_CRASH");
    await expect(pool.run("hang")).rejects.toThrow("MEDIA_WORKER_TIMEOUT");
    expect(await pool.run("still-alive")).toBe("still-alive");
    expect(pool.pool.status().active).toBe(0);
  } finally {
    pool.close();
  }
});
it("API image operations execute in bounded child processes and preserve output bytes", async () => {
  const bytes = await sharp({
    create: { width: 8, height: 6, channels: 4, background: "#456789" },
  })
    .png()
    .toBuffer();
  const meta = await inspect(bytes);
  expect(meta.width).toBe(8);
  const out = await execute("crop", [bytes], {
    left: 1,
    top: 1,
    width: 4,
    height: 3,
  });
  expect((await inspect(out)).width).toBe(4);
  await expect(inspect(Buffer.from("invalid"))).rejects.toThrow();
  expect((await inspect(bytes)).height).toBe(6);
});
