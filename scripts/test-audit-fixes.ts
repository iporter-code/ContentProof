import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { LocalHarness, delay } from "./local-harness.js";
import {
  reviewPrepared,
  reviewedClaimId,
  type SigningIntent,
} from "../apps/web/src/integrity.js";
import sharp from "sharp";
import { createConnection } from "node:net";

const h = new LocalHarness("audit-fixes", 3096, 8596),
  checks: string[] = [];
mkdirSync("data/fix-audit-2026-10-24", { recursive: true });
try {
  await h.start();
  const upgradeStatus = await new Promise<number>((resolve, reject) => {
    const url = new URL(h.rpcURL),
      socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let reply = "";
    socket.once("connect", () =>
      socket.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      ),
    );
    socket.on("data", (bytes) => {
      reply += bytes.toString("ascii");
      if (reply.length > 1024) {
        socket.destroy(Error("RPC_UPGRADE_REPLY_TOO_LARGE"));
        return;
      }
      if (reply.includes("\n")) {
        const status = reply.match(/^HTTP\/1\.[01] (\d{3}) /)?.[1];
        socket.destroy();
        if (!status) reject(Error("INVALID_RPC_UPGRADE_REPLY"));
        else resolve(Number(status));
      }
    });
    socket.once("error", reject);
    socket.setTimeout(5000, () =>
      socket.destroy(Error("WEBSOCKET_CHECK_TIMEOUT")),
    );
  });
  assert.notEqual(upgradeStatus, 101);
  assert.equal(await h.rpc("eth_chainId"), "0x7a69");
  checks.push(
    "reference chain refuses WebSocket upgrade while HTTP RPC remains available",
  );
  const business = spawn(
    process.execPath,
    ["dist/server/scripts/test-business.js"],
    { env: h.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  business.stdout.on("data", (b) => (log += b));
  business.stderr.on("data", (b) => (log += b));
  assert.equal(await new Promise((r) => business.once("exit", r)), 0, log);
  checks.push("existing 8 non-demo business checks");
  const a = await h.identity(),
    b = await h.identity();
  const bytes = await sharp({
    create: { width: 21, height: 19, channels: 4, background: "#327591" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), "audit.png");
  const asset = await h.call("/v1/assets", a.token, form);
  await h.call(`/v1/assets/${asset.digest}/grant`, a.token, {
    address: b.account.address,
    permission: "edit",
  });
  const stale = await h.call("/v1/drafts/import", b.token, {
    assetDigest: asset.digest,
    fields: { title: "stale" },
  });
  await h.call(`/v1/drafts/${stale.id}/prepare`, b.token, {});
  await h.call(`/v1/assets/${asset.digest}/revoke`, a.token, {
    address: b.account.address,
  });
  assert.equal(
    (await h.response(`/v1/drafts/${stale.id}/prepare`, b.token, {})).status,
    403,
  );
  checks.push("revoked cached draft rejected before preparation");
  const d = await h.call("/v1/drafts/import", a.token, {
    assetDigest: asset.digest,
    fields: { title: "reorg sample" },
  });
  const prepared = await h.call(`/v1/drafts/${d.id}/prepare`, a.token, {});
  const intent: SigningIntent = {
    issuer: a.account.address,
    keyEpoch: "1",
    domain: prepared.domain,
    operation: "import",
    assetDigest: asset.digest,
    mediaType: asset.mediaType,
    byteLength: asset.size,
    engineDigest: d.engineDigest,
    fields: { title: "reorg sample" },
    parents: [],
  };
  const local = reviewPrepared(prepared, intent),
    id = reviewedClaimId(local);
  const signed = await h.sign(d.id, a);
  assert.equal(signed.id, id);
  checks.push("browser commitments and ID agree with real API preparation");
  const snapshot = await h.rpc("evm_snapshot");
  const queued = await h.call(`/v1/claims/${id}/anchor`, a.token, {});
  await h.confirmed(queued.jobId, a.token);
  await h.rpc("evm_revert", [snapshot]);
  assert.equal(
    (await h.call(`/v1/jobs/${queued.jobId}`, a.token)).state,
    "orphaned",
  );
  Object.assign(process.env, h.env);
  const chain = await import("../packages/chain/index.js");
  await chain.anchor(signed.manifest);
  const restored = await h.call(`/v1/jobs/${queued.jobId}`, a.token);
  assert.equal(restored.state, "confirmed");
  assert.equal(restored.registrationStatus, "confirmed");
  checks.push("real rollback and reanchor restore confirmed job state");
  const block = await h.rpc("eth_getBlockByNumber", ["latest", false]);
  const deadline = String(Number(block.timestamp) + 30);
  const signature = await a.account.signTypedData({
    domain: prepared.domain,
    types: {
      Withdrawal: [
        { name: "claimId", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Withdrawal",
    message: { claimId: id, deadline: BigInt(deadline) },
  });
  await h.rpc("miner_stop");
  try {
    const pending = h.response(`/v1/claims/${id}/withdraw`, a.token, {
      deadline,
      signature,
    });
    let submitted = false;
    for (let i = 0; i < 50; i++) {
      if (Object.keys((await h.rpc("txpool_content")).pending ?? {}).length) {
        submitted = true;
        break;
      }
      await delay(100);
    }
    assert(submitted, "WITHDRAWAL_NOT_SUBMITTED");
    await h.rpc("evm_increaseTime", [60]);
    await h.rpc("miner_start");
    const response = await pending;
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "TRANSACTION_REVERTED");
    assert.equal(
      (await chain.observe(signed.manifest, a.account.address)).anchor,
      "confirmed",
    );
    assert.equal(
      (await h.call(`/v1/jobs/${queued.jobId}`, a.token)).state,
      "confirmed",
    );
    checks.push(
      "real reverted withdrawal rejected without false withdrawn state",
    );
  } finally {
    await h.rpc("miner_start");
  }
  const parent = h.child!.pid!;
  let apiPid: number;
  if (process.platform === "win32") {
    const children = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parent}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    );
    apiPid = [children]
      .flat()
      .find((p) =>
        p.CommandLine?.includes("dist/server/apps/api/main.js"),
      )?.ProcessId;
  } else {
    const rows = execFileSync(
      "ps",
      ["-o", "pid=,args=", "--ppid", String(parent)],
      { encoding: "utf8" },
    );
    apiPid = Number(
      rows
        .split("\n")
        .find((line) => line.includes("dist/server/apps/api/main.js"))
        ?.trim()
        .split(/\s+/)[0],
    );
  }
  assert(
    Number.isSafeInteger(apiPid) && apiPid > 0,
    "OWNED_API_CHILD_NOT_FOUND",
  );
  process.kill(apiPid);
  for (let i = 0; i < 100 && h.child!.exitCode === null; i++) await delay(100);
  assert.equal(h.child!.exitCode, 1);
  checks.push("real API child exit shuts down supervisor with failure status");
  console.log(`${checks.length} audit-fix integration checks passed.`);
} finally {
  await h.stop();
  writeFileSync(
    "data/fix-audit-2026-10-24/integration.json",
    JSON.stringify(
      { date: new Date().toISOString(), passed: checks.length === 7, checks },
      null,
      2,
    ),
  );
}
