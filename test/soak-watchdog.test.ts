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
  const completed = {
    status: "completed",
    passed: true,
    cleanup: { passed: true },
    targetSeconds: 90,
    elapsedSeconds: 90,
    runnerExit: { code: 0, signal: null },
  };
  writeFileSync(file, JSON.stringify(completed));
  const final = spawnSync(process.execPath, [script, "finalize"], {
    cwd: root,
    env: { ...env, SERVICE_RESULT: "success" },
    encoding: "utf8",
    timeout: 10000,
  });
  expect(final.status).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject(completed);
});
it.each([1, 0])(
  "does not accept an early success report when runner exit is %s",
  (code) => {
    mkdirSync("data/test-watchdog", { recursive: true });
    const root = mkdtempSync(resolve("data/test-watchdog/final-")),
      results = resolve(root, "results");
    mkdirSync(resolve(root, "dist/server/scripts"), { recursive: true });
    mkdirSync(results);
    writeFileSync(
      resolve(root, "dist/server/scripts/bench-local.js"),
      `process.exit(${code})`,
    );
    const prior = {
      status: "completed",
      passed: true,
      targetSeconds: 90,
      elapsedSeconds: 90,
      completedWorkflows: 6,
      errors: [],
    };
    for (const name of ["soak.json", "soak-progress.json"])
      writeFileSync(resolve(results, name), JSON.stringify(prior));
    const run = spawnSync(
      process.execPath,
      [resolve("scripts/soak-watchdog.mjs"), "run"],
      {
        cwd: root,
        env: {
          ...process.env,
          CP_RESULTS_DIR: results,
          CP_SOAK_REPORT: "soak",
          CP_SOAK_SECONDS: "90",
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(run.status).toBe(1);
    expect(
      JSON.parse(readFileSync(resolve(results, "soak.json"), "utf8")),
    ).toMatchObject({
      status: "failed",
      passed: false,
      businessPassed: true,
      completedWorkflows: 6,
      runnerExit: { code },
    });
  },
);
it("service failure overrides a completed business report and retains its measurements", () => {
  mkdirSync("data/test-watchdog", { recursive: true });
  const results = mkdtempSync(resolve("data/test-watchdog/service-"));
  const prior = {
    status: "completed",
    passed: true,
    cleanup: { passed: true },
    targetSeconds: 90,
    elapsedSeconds: 90,
    runnerExit: { code: 0, signal: null },
    completedWorkflows: 6,
    latencyMilliseconds: { p50: 123 },
    errors: [],
  };
  for (const name of ["soak.json", "soak-progress.json"])
    writeFileSync(resolve(results, name), JSON.stringify(prior));
  spawnSync(
    process.execPath,
    [resolve("scripts/soak-watchdog.mjs"), "finalize"],
    {
      env: {
        ...process.env,
        CP_RESULTS_DIR: results,
        CP_SOAK_REPORT: "soak",
        CP_SOAK_SECONDS: "90",
        SERVICE_RESULT: "exit-code",
      },
      timeout: 10000,
    },
  );
  expect(
    JSON.parse(readFileSync(resolve(results, "soak.json"), "utf8")),
  ).toMatchObject({
    status: "failed",
    passed: false,
    businessPassed: true,
    completedWorkflows: 6,
    latencyMilliseconds: { p50: 123 },
    errors: ["SOAK_SERVICE_INTERRUPTED:exit-code"],
  });
});
