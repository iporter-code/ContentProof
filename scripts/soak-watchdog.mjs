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
function finish(reason) {
  const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (["completed", "failed", "cancelled"].includes(state.status)) return state;
  const failed = {
    ...state,
    date: new Date().toISOString(),
    status: "failed",
    passed: false,
    targetSeconds: Number(process.env.CP_SOAK_SECONDS ?? 86400),
    errors: [...(state.errors ?? []), reason],
  };
  for (const file of [path, resolve(dir, `${name}.json`)]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(failed, null, 2));
    renameSync(temp, file);
  }
  return failed;
}
if (process.argv[2] === "finalize") {
  finish(`SOAK_SERVICE_INTERRUPTED:${process.env.SERVICE_RESULT ?? "unknown"}`);
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
    const state = finish(`SOAK_RUNNER_EXITED:${signal ?? code}`);
    process.exitCode =
      state.status === "completed" && state.passed === true && code === 0
        ? 0
        : 1;
  });
} else throw Error("Use run or finalize");
