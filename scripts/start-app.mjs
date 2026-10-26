import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stopOwnedProcess } from "./process-shutdown.mjs";
if (process.argv.includes("--demo")) process.env.DEMO_MODE = "true";
const built = process.argv.includes("--built");
const { loadConfiguredSecrets } = await import(
  built
    ? "../dist/server/packages/config/secrets.js"
    : "../packages/config/secrets.ts"
);
const { demoMode, dataPath, rpcUrl, rpcUrls, apiPort, webPort, chainId } =
  await import(
    built
      ? "../dist/server/packages/config/index.js"
      : "../packages/config/index.ts"
  );
const children = [];
const childNames = new Map();
if (existsSync(`${dataPath}.key-rotation.json`))
  throw Error("KEY_ROTATION_RECOVERY_REQUIRED");
await loadConfiguredSecrets();
let stopping = false;
let stopTask;
function serviceFailed(name, reason) {
  if (stopping) return;
  console.error(
    `${name} stopped unexpectedly (${reason}); shutting down owned services`,
  );
  void stop().then(() => process.exit(1));
}
async function rpc(method, params = []) {
  let lastError;
  for (const url of rpcUrls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) throw Error("RPC_HTTP_ERROR");
      const json = await response.json();
      if (json.error || json.result === undefined)
        throw Error("RPC_METHOD_ERROR");
      return json.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
function start(name, args, required = true) {
  const c = spawn(process.execPath, args, {
    windowsHide: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(c);
  childNames.set(c, name);
  for (const stream of [c.stdout, c.stderr])
    stream.on("data", (data) => {
      if (name !== "chain") process.stdout.write(`[${name}] ${data}`);
    });
  c.on("error", (e) => {
    serviceFailed(name, e.code ?? "START_FAILED");
  });
  c.on("exit", (code, signal) => {
    if (required) serviceFailed(name, signal ?? code);
  });
  return c;
}
async function wait(url) {
  for (let i = 0; i < 100; i++) {
    if (stopping) throw Error("OWNED_SERVICE_STOPPED");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error(`Service not ready: ${url}`);
}
function stop() {
  if (stopTask) return stopTask;
  stopping = true;
  stopTask = (async () => {
    const outcomes = [];
    for (const c of [...children].reverse()) {
      const result = await stopOwnedProcess(c, childNames.get(c));
      outcomes.push(result);
      console.log(`[shutdown] ${JSON.stringify(result)}`);
    }
    return outcomes.every((result) => result.passed);
  })();
  return stopTask;
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(
    signal,
    () => void stop().then((passed) => process.exit(passed ? 0 : 1)),
  );
process.on("message", (message) => {
  if (message === "shutdown")
    void stop().then((passed) => process.exit(passed ? 0 : 1));
});
if (process.connected)
  process.on("disconnect", () => void stop().then(() => process.exit(1)));
try {
  let running = false;
  try {
    const id = await rpc("eth_chainId");
    if (Number(id) !== chainId) throw Error("WRONG_CHAIN");
    running = true;
  } catch (e) {
    if (e.message === "WRONG_CHAIN") throw e;
  }
  if (!running) {
    if (rpcUrls.length > 1 || process.env.CHAIN_MODE === "external")
      throw Error("CONFIGURED_RPC_UNAVAILABLE");
    if (!["127.0.0.1", "localhost"].includes(new URL(rpcUrl).hostname))
      throw Error("EXTERNAL_RPC_UNAVAILABLE");
    start(
      "chain",
      built
        ? ["dist/server/scripts/persistent-chain.js"]
        : ["--import", "tsx", "scripts/persistent-chain.ts"],
    );
    for (let i = 0; i < 100; i++) {
      try {
        if (Number(await rpc("eth_chainId")) === chainId) {
          running = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!running) throw Error("CHAIN_NOT_READY");
  }
  mkdirSync(dataPath, { recursive: true });
  const file = resolve(dataPath, "deployment.json");
  let deployed = false;
  if (existsSync(file)) {
    const d = JSON.parse(readFileSync(file, "utf8"));
    const code = await rpc("eth_getCode", [d.provenance, "latest"]);
    if (d.chainId !== chainId) throw Error("DEPLOYMENT_CHAIN_MISMATCH");
    deployed = typeof code === "string" && code !== "0x";
    if (deployed) {
      const { validateDeployment } = await import(
        built
          ? "../dist/server/packages/chain/index.js"
          : "../packages/chain/index.ts"
      );
      await validateDeployment();
    }
  }
  if (!deployed) {
    const c = start(
      "deploy",
      built
        ? ["dist/server/scripts/deploy.js"]
        : ["--import", "tsx", "scripts/deploy.ts"],
      false,
    );
    if ((await new Promise((r) => c.once("exit", r))) !== 0)
      throw Error("DEPLOY_FAILED");
  }
  start(
    "api",
    built
      ? ["dist/server/apps/api/main.js"]
      : ["--import", "tsx", "apps/api/main.ts"],
  );
  await wait(`http://127.0.0.1:${apiPort}/health/ready`);
  if (!built)
    start("web", [
      "node_modules/vite/bin/vite.js",
      "--config",
      "apps/web/vite.config.ts",
    ]);
  await wait(`http://127.0.0.1:${built ? apiPort : webPort}`);
  console.log(
    `ContentProof ready http://127.0.0.1:${built ? apiPort : webPort}\n${demoMode ? "Explicit demonstration mode" : "User-signed mode; node data persisted on disk"}\nCtrl+C stops owned services.`,
  );
} catch (e) {
  console.error(e.message);
  await stop();
  process.exitCode = 1;
}
