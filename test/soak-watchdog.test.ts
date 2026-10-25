import { it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
it("records unexpected runner death and preserves terminal reports during service finalization", () => {
  mkdirSync("data/test-watchdog", { recursive: true });
  const root = mkdtempSync(resolve("data/test-watchdog/run-")),
    results = resolve(root, "results");
  mkdirSync(resolve(root, "dist/server/scripts"), { recursive: true });
  writeFileSync(
    resolve(root, "dist/server/scripts/bench-local.js"),
    "process.exit(17)",
  );
  const file = resolve(results, "soak-progress.json"),
    env = {
      ...process.env,
      CP_RESULTS_DIR: results,
      CP_SOAK_REPORT: "soak",
      CP_SOAK_SECONDS: "90",
    };
  const script = resolve("scripts/soak-watchdog.mjs");
  const run = spawnSync(process.execPath, [script, "run"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  expect(run.status).toBe(1);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    status: "failed",
    passed: false,
    errors: ["SOAK_RUNNER_EXITED:17"],
  });
  const completed = { status: "completed", passed: true };
  writeFileSync(file, JSON.stringify(completed));
  const final = spawnSync(process.execPath, [script, "finalize"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  expect(final.status).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(completed);
});
