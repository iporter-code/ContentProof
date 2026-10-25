import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { rotateExternalStorage } from "../packages/persistence/external-rotation.js";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import sharp from "sharp";
import { typedData } from "../packages/protocol/index.js";
import {
  backupData,
  restoreData,
  rotateStorage,
} from "../packages/persistence/maintenance.js";
mkdirSync("data/reliability-runs", { recursive: true });
const root = mkdtempSync(resolve("data/reliability-runs/run-")),
  original = resolve(root, "source"),
  restored = resolve(root, "restored"),
  backup = resolve(root, "backup");
const account = privateKeyToAccount(generatePrivateKey()),
  password = generatePrivateKey(),
  base = "http://127.0.0.1:3065",
  checks: string[] = [];
let child: ChildProcess | undefined;
let log = "";
function env(dir: string, externalFile = "") {
  return {
    ...process.env,
    DEMO_MODE: "false",
    NODE_ENV: "production",
    DATA_DIR: dir,
    STORAGE_KEY_FILE: externalFile,
    PORT: "3065",
    WEB_PORT: "5188",
    RPC_URL: "http://127.0.0.1:8565",
    CHAIN_PORT: "8565",
  };
}
async function start(dir: string, externalFile = "") {
  log = "";
  child = spawn(process.execPath, ["scripts/start-app.mjs", "--built"], {
    env: env(dir, externalFile),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout!.on("data", (b) => (log += b));
  child.stderr!.on("data", (b) => (log += b));
  for (let i = 0; i < 150; i++) {
    try {
      if (
        (
          await fetch(base + "/health/ready", {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      )
        return;
    } catch {}
    if (child.exitCode !== null) throw Error(log);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error(log || "SERVICE_START_TIMEOUT");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const c = child;
  await new Promise<void>((r, reject) => {
    const timer = setTimeout(() => {
      c.kill();
      reject(Error("GRACEFUL_STOP_TIMEOUT"));
    }, 15000);
    c.once("exit", () => {
      clearTimeout(timer);
      r();
    });
    c.send("shutdown");
  });
}
async function call(path: string, token = "", body?: any) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const json = await response.json();
  assert(response.ok, json.error?.message);
  return json.data;
}
async function login() {
  const c = await call("/v1/auth/challenge", "", { address: account.address });
  return (
    await call("/v1/auth/verify", "", {
      id: c.id,
      signature: await account.signMessage({ message: c.message }),
    })
  ).token;
}
try {
  await start(original);
  const token = await login();
  await call("/v1/profile", token, { name: "备份恢复持钥验收" });
  const bytes = await sharp({
      create: { width: 33, height: 25, channels: 4, background: "#457965" },
    })
      .png()
      .toBuffer(),
    form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), "recovery.png");
  const asset = await call("/v1/assets", token, form),
    draft = await call("/v1/drafts/import", token, {
      assetDigest: asset.digest,
      fields: { title: "跨备份与轮换的声明" },
    }),
    prepared = await call(`/v1/drafts/${draft.id}/prepare`, token, {}),
    signed = await call(`/v1/drafts/${draft.id}/signatures`, token, {
      signature: await account.signTypedData(
        typedData(prepared.core, prepared.domain),
      ),
    }),
    job = await call(`/v1/claims/${signed.id}/anchor`, token, {});
  for (let i = 0; i < 80; i++) {
    const status = await call(`/v1/jobs/${job.jobId}`, token);
    if (status.state === "confirmed") break;
    if (status.state === "failed") throw Error(status.error);
    if (i === 79) throw Error("ANCHOR_TIMEOUT");
    await new Promise((r) => setTimeout(r, 200));
  }
  checks.push("compiled non-demo upload/sign/anchor");
  await stop();
  checks.push("all owned services stopped before snapshot");
  const before = readFileSync(resolve(original, "storage.key"));
  await backupData(original, backup, password);
  checks.push("streamed authenticated encrypted backup including local chain");
  await restoreData(backup, restored, password);
  checks.push(
    "restore to fresh data directory with manifest and hashes validated",
  );
  const rotation = rotateStorage(restored);
  assert.notDeepEqual(readFileSync(resolve(restored, "storage.key")), before);
  assert(rotation.records > 0);
  checks.push("restored storage key rotated, records and objects reencrypted");
  await start(restored);
  const resumed = await login(),
    record = await call(`/v1/claims/${signed.id}`, resumed);
  assert.equal(record.chain.anchor, "confirmed");
  assert.equal(record.chain.identity, "active");
  const image = await fetch(base + `/v1/assets/${asset.digest}/content`, {
    headers: { Authorization: `Bearer ${resumed}` },
  });
  assert(image.ok);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  checks.push(
    "restored and rotated API decrypts original image and original signed claim",
  );
  assert.equal(
    (await call("/v1/assets/page?limit=1", resumed)).items[0].digest,
    asset.digest,
  );
  checks.push("migrated database and cursor API remain usable");
  const metrics = await call("/v1/system/metrics", resumed);
  assert(metrics.requests > 0);
  checks.push("runtime resource metrics available");
  await stop();
  const secretFile = resolve(root, "external-storage-key");
  writeFileSync(
    secretFile,
    readFileSync(resolve(restored, "storage.key")).toString("hex"),
    { mode: 0o600 },
  );
  const rotated = rotateExternalStorage(restored, secretFile);
  assert(rotated.records > 0);
  assert(!existsSync(resolve(restored, "storage.key")));
  await start(restored, secretFile);
  const externalToken = await login();
  assert.equal(
    (await call(`/v1/claims/${signed.id}`, externalToken)).chain.anchor,
    "confirmed",
  );
  const externalImage = await fetch(
    base + `/v1/assets/${asset.digest}/content`,
    {
      headers: { Authorization: `Bearer ${externalToken}` },
    },
  );
  assert(externalImage.ok);
  assert.deepEqual(Buffer.from(await externalImage.arrayBuffer()), bytes);
  checks.push(
    "external file secret rotation restarts compiled services and decrypts original claim and image",
  );
  mkdirSync("data/app/results", { recursive: true });
  writeFileSync(
    "data/app/results/reliability.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        passed: true,
        checks,
        backupFiles: (await import("node:fs")).readdirSync(backup).length,
      },
      null,
      2,
    ),
  );
  console.log(
    `${checks.length} compiled service backup/restore/rotation checks passed.`,
  );
} finally {
  await stop();
}
