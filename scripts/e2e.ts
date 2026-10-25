import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { seed, request, upload, bundle, fixture, login } from "./client.js";
import { importBundle, exportBundle } from "../packages/bundle/index.js";
import {
  verify,
  claimId,
  typedData,
  salt,
  checkDisclosure,
  signer,
  type Manifest,
} from "../packages/protocol/index.js";
import {
  observe,
  publicClient,
  deployment,
  wallet,
  chainCore,
  demoAccount,
  nonce,
} from "../packages/chain/index.js";
import { reproduce } from "../packages/media/index.js";
const rows: { name: string; passed: boolean; detail?: string }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    rows.push({ name, passed: true });
    console.log("PASS", name);
  } catch (e) {
    rows.push({
      name,
      passed: false,
      detail: e instanceof Error ? e.message : String(e),
    });
    console.error("FAIL", name, String(e));
  }
}
const seeded = await seed(),
  { tokens, final, root } = seeded;
const original = await importBundle(await bundle(tokens[2], final));
const verifyBundle = (b: typeof original, online = true) =>
  verify(b.target, { ...b, reproduce, ...(online ? { observe } : {}) });
const clone = () => ({
  target: original.target,
  manifests: new Map(
    [...original.manifests].map(([id, m]) => [id, structuredClone(m)]),
  ),
  files: new Map(original.files),
});
await check("T01 三身份、真实合成、真实链登记与独立复算", async () => {
  const r = await verifyBundle(original);
  assert.equal(r.outcome, "pass");
  assert.equal(r.checks.transformation, "reproduced");
});
await check("T02 修改最终文件字节", async () => {
  const b = clone(),
    m = b.manifests.get(final)!;
  b.files.set(m.core.assetDigest, Buffer.from("tampered"));
  const r = await verifyBundle(b);
  assert.equal(r.checks.file, "mismatch");
  assert.equal(r.outcome, "fail");
});
await check("T03 替换公开父节点", async () => {
  const b = clone();
  b.manifests.get(final)!.disclosure.parents[0].parent!.claimId =
    root as `0x${string}`;
  assert.equal((await verifyBundle(b)).outcome, "fail");
});
await check("T04 交换合成输入槽位", async () => {
  const b = clone(),
    m = b.manifests.get(final)!;
  m.disclosure.parents.reverse();
  assert.equal((await verifyBundle(b)).outcome, "fail");
});
await check("T05 修改操作参数", async () => {
  const b = clone();
  b.manifests
    .get(final)!
    .disclosure.fields.find((f) => f.path === "operation.params")!.value = {
    left: 0,
    top: 0,
  };
  assert.equal((await verifyBundle(b)).outcome, "fail");
});
await check("T06 缺失公开父manifest", async () => {
  const b = clone();
  b.manifests.delete(seeded.cropped);
  assert.equal((await verifyBundle(b)).checks.ancestry, "missing");
});
await check("T07 合法隐藏父节点", async () => {
  const b = await importBundle(await bundle(tokens[2], final, [], [1]));
  const r = await verifyBundle(b);
  assert.equal(r.checks.ancestry, "withheld");
  assert.equal(r.outcome, "incomplete");
  assert(!b.manifests.has(seeded.stampId));
  assert(
    !b.files.has(original.manifests.get(seeded.stampId)!.core.assetDigest),
  );
});
await check("T08 删除父槽位", async () => {
  const b = clone();
  b.manifests.get(final)!.disclosure.parents.pop();
  assert.equal((await verifyBundle(b)).outcome, "fail");
});
await check("T09 公开字段修改后复用proof", async () => {
  const b = clone();
  b.manifests.get(final)!.disclosure.fields[0].salt = salt();
  assert.equal((await verifyBundle(b)).outcome, "fail");
});
await check("T10 重复披露字段拒绝", async () => {
  const m = structuredClone(original.manifests.get(final)!);
  m.disclosure.fields.push(m.disclosure.fields[0]);
  assert.throws(() => checkDisclosure(m));
});
const d = deployment(),
  m = original.manifests.get(final)!;
async function expectRevert(manifest: Manifest) {
  await assert.rejects(
    publicClient.simulateContract({
      address: d.provenance,
      abi: d.provenanceAbi,
      functionName: "registerClaim",
      args: [chainCore(manifest), manifest.signature],
      account: demoAccount(0).address,
    }),
  );
}
await check("T11 跨链/跨合约域重放被真实合约拒绝", async () => {
  for (const domain of [
    { ...m.domain, chainId: 1 },
    { ...m.domain, verifyingContract: d.identity },
  ]) {
    const modified = {
      ...m,
      domain,
      core: { ...m.core, nonce: await nonce(demoAccount(3).address) },
    };
    modified.signature = await demoAccount(3).signTypedData(
      typedData(modified.core, domain),
    );
    await expectRevert(modified);
  }
});
await check("T12 重复nonce与过期声明被真实合约拒绝", async () => {
  await expectRevert(m);
  const expired = {
    ...m,
    core: {
      ...m.core,
      nonce: await nonce(demoAccount(3).address),
      deadline: "1",
    },
  };
  expired.signature = await demoAccount(3).signTypedData(
    typedData(expired.core, expired.domain),
  );
  await expectRevert(expired);
});
await check("T13 未注册签名密钥拒绝", async () => {
  const bad = {
    ...m,
    core: { ...m.core, nonce: await nonce(demoAccount(3).address) },
  };
  bad.signature = await demoAccount(4).signTypedData(
    typedData(bad.core, bad.domain),
  );
  await expectRevert(bad);
});
await check("T14 真实链上撤销密钥影响历史验证", async () => {
  const snapshot = (await publicClient.request({
    method: "evm_snapshot" as any,
  })) as string;
  try {
    const tx = await wallet(3).writeContract({
      address: d.identity,
      abi: d.identityAbi,
      functionName: "revokeKey",
      args: [demoAccount(3).address, 1n],
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    assert.equal((await verifyBundle(original)).outcome, "fail");
  } finally {
    await publicClient.request({
      method: "evm_revert" as any,
      params: [snapshot] as any,
    });
  }
});
await check("T15 虚构登记状态无法替代链读取", async () => {
  const copy = structuredClone(m);
  copy.core.nonce = "999999";
  copy.signature = await demoAccount(3).signTypedData(
    typedData(copy.core, copy.domain),
  );
  assert.equal((await observe(copy, await signer(copy))).anchor, "absent");
});
await check("T16 离线验证明确不完整", async () => {
  const r = await verifyBundle(original, false);
  assert.equal(r.checks.anchor, "offline");
  assert.equal(r.outcome, "incomplete");
});
await check("T17 CLI独立验证及离线退出码", async () => {
  const args = [
    "--import",
    "tsx",
    "apps/verifier/main.ts",
    "verify",
    "data/demo/full.zip",
    "--json",
  ];
  const online = spawnSync(process.execPath, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(online.status, 0, online.stderr);
  assert.equal(JSON.parse(online.stdout).outcome, "pass");
  const offline = spawnSync(process.execPath, [...args, "--offline"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(offline.status, 3);
  assert.equal(JSON.parse(offline.stdout).checks.anchor, "offline");
});
await check("T18 锚定幂等任务", async () => {
  const a = await request(`/v1/claims/${final}/anchor`, tokens[2], {}),
    b = await request(`/v1/claims/${final}/anchor`, tokens[2], {});
  assert.equal(a.jobId, b.jobId);
});
await check("T19 伪装格式上传拒绝", async () => {
  await assert.rejects(upload(tokens[0], Buffer.from("<svg/>")));
});
await check("T21 跨机构按摘要窃取文件拒绝", async () => {
  const privateAsset = await upload(tokens[0], await fixture(31, 19));
  await assert.rejects(
    request(`/v1/assets/${privateAsset.digest}`, tokens[2]),
    /403/,
  );
});
await check("T22 隐藏提示词及位置后不泄露明文", async () => {
  const bytes = await bundle(
    tokens[2],
    final,
    ["ai.prompt", "source.location"],
    [1],
  );
  assert(!Buffer.from(bytes).includes(Buffer.from("PRIVATE_DEMO_")));
});
await check("T23 签名者名称不能替代密钥认证", async () => {
  await assert.rejects(
    request("/v1/auth/verify", "", {
      id: "f".repeat(48),
      signature: "0x" + "00".repeat(65),
    }),
    /401/,
  );
});
await check("T24 导入声明明确仅声明属性", async () => {
  const r = await verify(root, { ...original, observe, reproduce });
  assert.equal(r.checks.transformation, "declared-only");
});
await check("T27 没有目标来源时为证据缺失", async () => {
  assert.equal(
    (await verify(final, { manifests: new Map(), files: new Map() })).checks
      .ancestry,
    "missing",
  );
});
await check("T28 AI生成属性仅签名声明", async () => {
  const r = await verify(seeded.stampId, { ...original, observe, reproduce });
  assert.equal(r.checks.transformation, "declared-only");
});
await check("授权撤回后验证拒绝，链回滚恢复", async () => {
  const snapshot = (await publicClient.request({
    method: "evm_snapshot" as any,
  })) as string;
  try {
    const tx = await wallet(3).writeContract({
      address: d.provenance,
      abi: d.provenanceAbi,
      functionName: "invalidateClaim",
      args: [final, salt()],
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    assert.equal((await verifyBundle(original)).checks.anchor, "withdrawn");
  } finally {
    await publicClient.request({
      method: "evm_revert" as any,
      params: [snapshot] as any,
    });
  }
});
await check("认证挑战不可重放", async () => {
  const account = demoAccount(1),
    c = await request("/v1/auth/challenge", "", { address: account.address }),
    signature = await account.signMessage({ message: c.message });
  await request("/v1/auth/verify", "", { id: c.id, signature });
  await assert.rejects(
    request("/v1/auth/verify", "", { id: c.id, signature }),
    /401/,
  );
});
await check("不允许第三方网页调用演示签名服务", async () => {
  const res = await fetch("http://127.0.0.1:3001/v1/demo/login", {
    method: "POST",
    headers: {
      Origin: "https://attacker.invalid",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ index: 1 }),
  });
  assert.equal(res.status, 403);
});
await check("T26 同一nonce竞争只能登记一份声明", async () => {
  const snapshot = (await publicClient.request({
    method: "evm_snapshot" as any,
  })) as string;
  try {
    const currentNonce = await nonce(demoAccount(3).address);
    const first = {
      ...m,
      core: { ...m.core, nonce: currentNonce, assetDigest: salt() },
    };
    first.signature = await demoAccount(3).signTypedData(
      typedData(first.core, first.domain),
    );
    const second = {
      ...m,
      core: { ...m.core, nonce: currentNonce, assetDigest: salt() },
    };
    second.signature = await demoAccount(3).signTypedData(
      typedData(second.core, second.domain),
    );
    const tx = await wallet(0).writeContract({
      address: d.provenance,
      abi: d.provenanceAbi,
      functionName: "registerClaim",
      args: [chainCore(first), first.signature],
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    await expectRevert(second);
    assert.equal(
      await nonce(demoAccount(3).address),
      String(BigInt(currentNonce) + 1n),
    );
  } finally {
    await publicClient.request({
      method: "evm_revert" as any,
      params: [snapshot] as any,
    });
  }
});
await check("正常停用保留历史声明但禁止未来登记", async () => {
  const snapshot = (await publicClient.request({
    method: "evm_snapshot" as any,
  })) as string;
  try {
    const tx = await wallet(3).writeContract({
      address: d.identity,
      abi: d.identityAbi,
      functionName: "retireKey",
      args: [demoAccount(3).address, 1n],
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    const report = await verifyBundle(original);
    assert.equal(report.checks.identity, "retired");
    assert.equal(report.outcome, "pass");
    const next = {
      ...m,
      core: {
        ...m.core,
        nonce: await nonce(demoAccount(3).address),
        assetDigest: salt(),
      },
    };
    next.signature = await demoAccount(3).signTypedData(
      typedData(next.core, next.domain),
    );
    await expectRevert(next);
  } finally {
    await publicClient.request({
      method: "evm_revert" as any,
      params: [snapshot] as any,
    });
  }
});
mkdirSync("data/results", { recursive: true });
writeFileSync(
  "data/results/e2e.json",
  JSON.stringify({ createdAt: new Date().toISOString(), rows }, null, 2),
);
const failed = rows.filter((r) => !r.passed);
console.log(
  `${rows.length - failed.length}/${rows.length} end-to-end checks passed. Raw report data/results/e2e.json`,
);
if (failed.length) process.exitCode = 1;
