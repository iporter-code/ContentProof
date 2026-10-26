import { fork } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { resolve } from "node:path";
const dir = resolve(process.env.CP_RESULTS_DIR ?? "data/app/results");
const name = process.env.CP_SOAK_REPORT ?? "soak-24h";
if (!/^[a-z][a-z0-9-]{0,48}$/.test(name))
  throw Error("INVALID_SOAK_REPORT_NAME");
mkdirSync(dir, { recursive: true });
const path = resolve(dir, `${name}-progress.json`);
const read = (file) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  } catch {
    return { errors: ["SOAK_REPORT_UNREADABLE"] };
  }
};
function finish(reason, runnerExit, serviceResult) {
  const state = read(path);
  const targetSeconds = Number(process.env.CP_SOAK_SECONDS ?? 86400);
  const observedExit = runnerExit ?? state.runnerExit;
  const successfulExit =
    observedExit?.code === 0 && observedExit?.signal === null;
  const accepted =
    successfulExit &&
    (!serviceResult || serviceResult === "success") &&
    state.status === "completed" &&
    state.passed === true &&
    state.cleanup?.passed === true &&
    state.targetSeconds === targetSeconds &&
    state.elapsedSeconds >= targetSeconds;
  const cancelled = state.status === "cancelled";
  const outcome = {
    date: new Date().toISOString(),
    status: accepted ? "completed" : cancelled ? "cancelled" : "failed",
    passed: accepted,
    businessPassed: state.businessPassed ?? state.passed ?? false,
    targetSeconds,
    ...(observedExit ? { runnerExit: observedExit } : {}),
    ...(serviceResult ? { serviceResult } : {}),
    errors: [
      ...new Set([
        ...(state.errors ?? []),
        ...(!accepted && !(cancelled && successfulExit) ? [reason] : []),
      ]),
    ],
  };
  for (const file of [path, resolve(dir, `${name}.json`)]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...read(file), ...outcome }, null, 2));
    renameSync(temp, file);
  }
  return { ...state, ...outcome };
}
if (process.argv[2] === "finalize") {
  const result = process.env.SERVICE_RESULT ?? "unknown";
  finish(`SOAK_SERVICE_INTERRUPTED:${result}`, undefined, result);
} else if (process.argv[2] === "run") {
  const child = fork(resolve("dist/server/scripts/bench-local.js"), [], {
    execArgv: [],
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const stop = () => {
    const file = resolve(dir, `${name}.stop`);
    if (!existsSync(file))
      writeFileSync(file, new Date().toISOString(), { flag: "wx" });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.once("error", () => {
    finish("SOAK_RUNNER_START_FAILED");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    const state = finish(`SOAK_RUNNER_EXITED:${signal ?? code}`, {
      code,
      signal,
      observedAt: new Date().toISOString(),
    });
    process.exitCode =
      state.status === "completed" && state.passed === true && code === 0
        ? 0
        : 1;
  });
} else throw Error("Use run or finalize");
