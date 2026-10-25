import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
const originDir = resolve("data");
const isolated = resolve("data/recovery-test");
mkdirSync(isolated, { recursive: true });
copyFileSync(
  resolve(originDir, "deployment.json"),
  resolve(isolated, "deployment.json"),
);
process.env.DATA_DIR = isolated;
const { publicClient, deployment, wallet, demoAccount } =
  await import("../packages/chain/index.js");
const { tickIndexer } = await import("../packages/chain/indexer.js");
const { one, db, run } = await import("../apps/api/store.js");
const rows: { name: string; passed: boolean }[] = [];
await tickIndexer();
const before = Number(one("SELECT COUNT(*) AS n FROM chain_events")!.n);
assert(before > 0);
await tickIndexer();
assert.equal(Number(one("SELECT COUNT(*) AS n FROM chain_events")!.n), before);
rows.push({ name: "事件幂等扫描", passed: true });
const d = deployment();
const snapshot = (await publicClient.request({
  method: "evm_snapshot" as any,
})) as string;
const epoch = BigInt(Date.now());
try {
  const tx = await wallet(0).writeContract({
    address: d.identity,
    abi: d.identityAbi,
    functionName: "authorizeKey",
    args: [demoAccount(1).address, epoch, demoAccount(1).address],
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  await tickIndexer();
  assert(Number(one("SELECT COUNT(*) AS n FROM chain_events")!.n) > before);
} finally {
  await publicClient.request({
    method: "evm_revert" as any,
    params: [snapshot] as any,
  });
}
await tickIndexer();
assert.equal(Number(one("SELECT COUNT(*) AS n FROM chain_events")!.n), before);
rows.push({ name: "链回滚后重建事件索引", passed: true });
const bundle = await (
  await import("../packages/bundle/index.js")
).importBundle(readFileSync(resolve(originDir, "demo/full.zip")));
const { claimId } = await import("../packages/protocol/index.js");
const manifest = bundle.manifests.get(bundle.target)!;
const full = {
  ...manifest,
  privateFields: manifest.disclosure.fields.map(({ proof, ...f }) => f),
  privateParents: manifest.disclosure.parents.map((p) => p.parent!),
};
const { encrypt } = await import("../apps/api/store.js");
const owner = manifest.core.issuer.toLowerCase(),
  id = claimId(manifest);
run("INSERT OR REPLACE INTO claims VALUES(?,?,?)", id, owner, encrypt(full));
run("INSERT OR IGNORE INTO claim_acl VALUES(?,?)", id, owner);
run(
  "INSERT OR REPLACE INTO jobs(id,owner,claimId,state,updated) VALUES(?,?,?,?,?)",
  "recovery-test",
  owner,
  id,
  "submitted",
  new Date().toISOString(),
);
let child: ChildProcess | undefined;
try {
  child = spawn(process.execPath, ["--import", "tsx", "apps/api/main.ts"], {
    cwd: process.cwd(),
    windowsHide: true,
    env: { ...process.env, PORT: "3002", DATA_DIR: isolated },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    const row = one("SELECT state FROM jobs WHERE id=?", "recovery-test");
    if (row?.state === "confirmed") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(
    one("SELECT state FROM jobs WHERE id=?", "recovery-test")?.state,
    "confirmed",
  );
  rows.push({
    name: "服务重启恢复submitted任务并识别链上已存在声明",
    passed: true,
  });
} finally {
  child?.kill();
  db.close();
}
mkdirSync("data/results", { recursive: true });
writeFileSync(
  "data/results/recovery.json",
  JSON.stringify({ createdAt: new Date().toISOString(), rows }, null, 2),
);
console.log(JSON.stringify(rows, null, 2));
