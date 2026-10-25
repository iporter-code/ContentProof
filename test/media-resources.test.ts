import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
const check = (values: Record<string, string | undefined>, script: string) => {
  const env = { ...process.env };
  delete env.MEDIA_CONCURRENCY;
  delete env.MEDIA_QUEUE_LIMIT;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      env: { ...env, ...values },
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    },
  );
};
it("low-memory configuration actually limits active work and rejects overflow without leaking capacity", () => {
  const r = check(
    { MEDIA_CONCURRENCY: "1", MEDIA_QUEUE_LIMIT: "0" },
    `import assert from 'node:assert/strict';const {mediaPool:p}=await import('./packages/media/resources.ts');let finish;const first=p.run(()=>new Promise(r=>finish=r));await assert.rejects(p.run(async()=>2),/MEDIA_RESOURCE_LIMIT/);assert.equal(p.status().active,1);finish(1);assert.equal(await first,1);assert.equal(await p.run(async()=>3),3);assert.equal(p.status().active,0);`,
  );
  expect(r.status, r.stderr).toBe(0);
});
it.each([
  { MEDIA_CONCURRENCY: "0" },
  { MEDIA_CONCURRENCY: "5" },
  { MEDIA_QUEUE_LIMIT: "17" },
  { MEDIA_QUEUE_LIMIT: "-1" },
])("invalid server budget fails at startup: %j", (values) => {
  const r = check(values, "await import('./packages/media/resources.ts')");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/INVALID_MEDIA_(CONCURRENCY|QUEUE_LIMIT)/);
});
