// Controls only the dedicated local synthetic soak. Never terminates a PID.
import { fork } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, "data/app/results");
const smoke = process.argv.includes("--smoke"),
  name = smoke ? "soak-frozen-smoke" : "soak-24h",
  seconds = smoke ? 90 : 86400;
const progress = resolve(dir, `${name}-progress.json`);
const stop = resolve(dir, `${name}.stop`);
const launch = resolve(dir, `${name}-launch.json`);
mkdirSync(dir, { recursive: true });
const read = (path) =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const action = process.argv[2] ?? "status";
if (action === "status") {
  const state = read(progress),
    launched = read(launch);
  const processAlive = alive(state?.pid ?? launched?.pid);
  const ageSeconds = state
    ? Math.max(0, (Date.now() - Date.parse(state.date)) / 1000)
    : null;
  const terminal = ["completed", "failed", "cancelled"].includes(state?.status);
  console.log(
    JSON.stringify(
      {
        ...state,
        processAlive,
        ageSeconds,
        status: terminal
          ? state.status
          : !processAlive
            ? "interrupted-or-not-started"
            : ageSeconds !== null && ageSeconds > 180
              ? "stalled-or-suspended"
              : (state?.status ?? "starting"),
        stopRequested: existsSync(stop),
        complete:
          state?.passed === true &&
          state.status === "completed" &&
          state.elapsedSeconds >= seconds,
      },
      null,
      2,
    ),
  );
} else if (action === "archive") {
  const state = read(progress),
    launched = read(launch);
  if (alive(state?.pid ?? launched?.pid))
    throw Error("SOAK_PROCESS_MAY_ALREADY_EXIST: cannot archive an active run");
  const suffixes = [
    ".json",
    "-progress.json",
    "-launch.json",
    ".stop",
    ".log",
    "-diagnostics.json",
  ];
  if (!suffixes.some((suffix) => existsSync(resolve(dir, `${name}${suffix}`))))
    throw Error("SOAK_HISTORY_NOT_FOUND");
  const history = resolve(
    dir,
    "soak-history",
    `${name}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  if (!history.startsWith(dir + sep)) throw Error("UNSAFE_SOAK_ARCHIVE_PATH");
  mkdirSync(history, { recursive: true, mode: 0o700 });
  const status = ["completed", "failed", "cancelled"].includes(state?.status)
    ? state.status
    : "interrupted";
  for (const suffix of suffixes) {
    const from = resolve(dir, `${name}${suffix}`),
      to = resolve(history, `${name}${suffix}`);
    if (!from.startsWith(dir + sep) || !to.startsWith(history + sep))
      throw Error("UNSAFE_SOAK_ARCHIVE_PATH");
    if (existsSync(from)) renameSync(from, to);
  }
  if (status === "interrupted" && !existsSync(resolve(history, `${name}.json`)))
    writeFileSync(
      resolve(history, `${name}.json`),
      JSON.stringify(
        {
          ...state,
          date: new Date().toISOString(),
          status,
          passed: false,
          errors: [...(state?.errors ?? []), "SOAK_PROCESS_INTERRUPTED"],
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
  writeFileSync(
    resolve(history, "archive-status.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        status,
        passed: status === "completed" && state?.passed === true,
        processAlive: false,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      archived: true,
      status,
      history: relative(root, history).split(sep).join("/"),
    }),
  );
} else if (action === "stop") {
  writeFileSync(stop, `${new Date().toISOString()}\n`, { flag: "wx" });
  console.log(
    "Stop requested. The owned test finishes its current workflow, writes a cancelled report and shuts down its own services.",
  );
} else if (action === "start") {
  const previous = read(progress),
    launched = read(launch);
  if (alive(previous?.pid ?? launched?.pid))
    throw Error("SOAK_PROCESS_MAY_ALREADY_EXIST: inspect status first");
  if (existsSync(progress) || existsSync(stop) || existsSync(launch))
    throw Error(
      "SOAK_HISTORY_EXISTS: preserve the previous run before starting a new one",
    );
  // Freeze code and dependencies so development cannot alter a running test.
  const snapshot = resolve(root, "data/soak-artifacts", randomUUID());
  mkdirSync(snapshot, { recursive: true });
  for (const path of [
    "packages",
    "scripts",
    "dist/server",
    "dist/web",
    "configs",
    "docs",
    "package.json",
    "package-lock.json",
    "node_modules",
  ])
    cpSync(resolve(root, path), resolve(snapshot, path), {
      recursive: true,
      dereference: true,
      filter: (source) => !source.split(sep).includes(".bin"),
    });
  const { writeSnapshotManifest } =
    await import("../dist/server/packages/operations/snapshot.js");
  writeSnapshotManifest(snapshot);
  const fd = openSync(resolve(dir, `${name}.log`), "a");
  try {
    const child = fork(
      resolve(snapshot, "scripts/soak-watchdog.mjs"),
      ["run"],
      {
        cwd: snapshot,
        execArgv: [],
        env: {
          ...process.env,
          CP_SOAK_SECONDS: String(seconds),
          CP_SOAK_REPORT: name,
          CP_SOAK_REAUTH_SECONDS: smoke ? "15" : "1800",
          CP_RESULTS_DIR: dir,
          CP_SOAK_SNAPSHOT: "required",
        },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd, "ipc"],
      },
    );
    child.once("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.disconnect();
    child.unref();
    writeFileSync(
      launch,
      JSON.stringify(
        {
          date: new Date().toISOString(),
          pid: child.pid,
          targetSeconds: seconds,
          report: `${name}-progress.json`,
          artifact: snapshot,
          manifest: "snapshot-manifest.json",
          scope:
            "Dedicated local synthetic Ganache workflow; no production data",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    console.log(
      `Started dedicated ${seconds}-second test (PID ${child.pid}). Inspect actual progress before reporting success.`,
    );
  } finally {
    closeSync(fd);
  }
} else
  throw Error(
    "Use start, status, stop or archive; --smoke selects the isolated 90-second run",
  );
