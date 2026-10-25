import { spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
const env = {
  ...process.env,
  DEMO_MODE: "false",
  DATA_DIR: resolve("data/config-test"),
  PORT: "3051",
  WEB_PORT: "5178",
  RPC_URL: "http://127.0.0.1:8555",
  CHAIN_PORT: "8555",
};
const child = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/start-app.mjs"],
  { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
);
let log = "";
child.stdout!.on("data", (b) => (log += b));
child.stderr!.on("data", (b) => (log += b));
async function stop() {
  if (child.exitCode !== null) return;
  await new Promise<void>((r) => {
    const timer = setTimeout(() => {
      child.kill();
      r();
    }, 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      r();
    });
    child.send("shutdown");
  });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if (
        (
          await fetch("http://127.0.0.1:5178", {
            signal: AbortSignal.timeout(800),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) throw Error(log);
    await new Promise((r) => setTimeout(r, 300));
  }
  assert(ready, log);
  const response = await fetch("http://127.0.0.1:3051/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: "0x0000000000000000000000000000000000000001",
    }),
  });
  assert.equal(response.status, 200);
  const json = (await response.json()) as any;
  assert(json.data.message.includes("http://127.0.0.1:3051"));
  const run = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/test-business.ts"],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  run.stdout!.on("data", (b) => (output += b));
  run.stderr!.on("data", (b) => (output += b));
  const code = await new Promise((r) => run.once("exit", r));
  assert.equal(code, 0, output);
  mkdirSync("data/app/results", { recursive: true });
  writeFileSync(
    "data/app/results/config.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        passed: true,
        apiPort: 3051,
        webPort: 5178,
        rpcPort: 8555,
        businessChecks: 8,
      },
      null,
      2,
    ),
  );
  console.log(
    "Custom API/web/RPC ports, authentication audience and 8 business checks passed.",
  );
} finally {
  await stop();
}
