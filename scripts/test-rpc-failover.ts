import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
const compose = resolve("data/qbft-network/compose.json"),
  env = {
    ...process.env,
    DATA_DIR: resolve("data/qbft-app"),
    CHAIN_ID: "31338",
    RPC_URL: "http://127.0.0.1:8575",
    RPC_URLS:
      "http://127.0.0.1:8576,http://127.0.0.1:8577,http://127.0.0.1:8578",
    CHAIN_MODE: "external",
    PORT: "3067",
    EVM_VERSION: "paris",
    DEMO_MODE: "false",
  };
async function docker(...args: string[]) {
  const c = spawn("docker", ["compose", "-f", compose, ...args], {
    windowsHide: true,
    stdio: "ignore",
  });
  assert.equal(await new Promise((r) => c.once("exit", r)), 0);
}
let supervisor: ReturnType<typeof spawn> | undefined,
  log = "";
async function stop() {
  if (!supervisor || supervisor.exitCode !== null) return;
  const c = supervisor;
  await new Promise<void>((r) => {
    const t = setTimeout(() => {
      c.kill();
      r();
    }, 15000);
    c.once("exit", () => {
      clearTimeout(t);
      r();
    });
    c.send("shutdown");
  });
}
try {
  await docker("stop", "validator1");
  supervisor = spawn(process.execPath, ["scripts/start-app.mjs", "--built"], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  supervisor.stdout!.on("data", (b) => (log += b));
  supervisor.stderr!.on("data", (b) => (log += b));
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if (
        (
          await fetch("http://127.0.0.1:3067/health/ready", {
            signal: AbortSignal.timeout(1500),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    if (supervisor.exitCode !== null) throw Error(log);
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(ready, log);
  assert(
    !existsSync("data/qbft-app/chain-db"),
    "Must not create a silent replacement chain when primary RPC is unavailable",
  );
  const business = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/test-business.ts"],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  business.stdout!.on("data", (b) => (output += b));
  business.stderr!.on("data", (b) => (output += b));
  assert.equal(await new Promise((r) => business.once("exit", r)), 0, output);
  mkdirSync("data/app/results", { recursive: true });
  copyFileSync(
    "data/qbft-app/results/business.json",
    "data/app/results/qbft-business.json",
  );
  writeFileSync(
    "data/app/results/rpc-failover.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        passed: true,
        checks: [
          "primary validator stopped before application startup",
          "startup selects configured fallback without replacing the chain",
          "all 8 non-demo business checks pass through fallback RPCs including sponsored writes",
        ],
        scope:
          "Availability failover to configured trusted RPCs; not a Byzantine RPC quorum proof.",
      },
      null,
      2,
    ),
  );
  console.log(
    "Startup and 8 business checks passed with the primary RPC offline.",
  );
} finally {
  await stop();
  await docker("start", "validator1");
}
