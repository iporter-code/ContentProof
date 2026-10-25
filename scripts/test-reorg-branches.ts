import assert from "node:assert/strict";
import sharp from "sharp";
import { LocalHarness, delay, saveReport } from "./local-harness.js";
const h = new LocalHarness("reorg-branches", 3085, 8585),
  checks: string[] = [];
const branches: {
  label: string;
  claimId: string;
  txHash: string;
  blockHash: string;
}[] = [];
try {
  await h.start();
  const user = await h.identity();
  const png = await sharp({
    create: { width: 48, height: 32, channels: 3, background: "#365e85" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(png)]), "synthetic-reorg.png");
  const asset = await h.call("/v1/assets", user.token, form);
  let snapshot = await h.rpc("evm_snapshot");
  const makeBranch = async (label: string) => {
    const draft = await h.call("/v1/drafts/import", user.token, {
      assetDigest: asset.digest,
      fields: { title: `多分支重组合成样本 ${label}` },
    });
    const signed = await h.sign(draft.id, user),
      queued = await h.call(`/v1/claims/${signed.id}/anchor`, user.token, {});
    const job = await h.confirmed(queued.jobId, user.token);
    const claim = await h.call(`/v1/claims/${signed.id}`, user.token);
    assert.equal(claim.chain.anchor, "confirmed");
    const block = await h.rpc("eth_getBlockByNumber", [
      `0x${BigInt(claim.chain.blockNumber).toString(16)}`,
      false,
    ]);
    branches.push({
      label,
      claimId: signed.id,
      txHash: job.txHash,
      blockHash: block.hash,
    });
    return { signed, jobId: queued.jobId };
  };
  const a = await makeBranch("A");
  assert.equal(await h.rpc("evm_revert", [snapshot]), true);
  snapshot = await h.rpc("evm_snapshot");
  const b = await makeBranch("B");
  assert.equal(
    (await h.call(`/v1/jobs/${a.jobId}`, user.token)).state,
    "orphaned",
  );
  assert.equal(
    (await h.call(`/v1/claims/${a.signed.id}`, user.token)).chain.anchor,
    "absent",
  );
  checks.push(
    "canonical branch B replaces A at the reused issuer nonce; A becomes absent/orphaned",
  );
  assert.equal(await h.rpc("evm_revert", [snapshot]), true);
  await h.rpc("evm_mine");
  const c = await makeBranch("C");
  for (const old of [a, b]) {
    assert.equal(
      (await h.call(`/v1/jobs/${old.jobId}`, user.token)).state,
      "orphaned",
    );
    assert.equal(
      (await h.call(`/v1/claims/${old.signed.id}`, user.token)).chain.anchor,
      "absent",
    );
  }
  assert.equal(new Set(branches.map((x) => x.blockHash)).size, 3);
  checks.push(
    "a second rollback and branch C preserve neither orphaned registration as confirmed",
  );
  await delay(1200);
  const before = await h.call("/v1/chain/status");
  const canonical = await h.rpc("eth_getBlockByNumber", [
    `0x${BigInt(before.index.blockNumber).toString(16)}`,
    false,
  ]);
  assert.equal(before.index.blockHash, canonical.hash);
  checks.push(
    "event index converges to the canonical hash after both branch changes",
  );
  await h.stop();
  await h.start();
  user.token = await user.login();
  assert.equal(
    (await h.call(`/v1/claims/${c.signed.id}`, user.token)).chain.anchor,
    "confirmed",
  );
  for (const old of [a, b])
    assert.equal(
      (await h.call(`/v1/claims/${old.signed.id}`, user.token)).chain.anchor,
      "absent",
    );
  checks.push(
    "full service and persistent-chain restart retains C and does not resurrect A/B",
  );
  saveReport("reorg-branches", {
    date: new Date().toISOString(),
    passed: true,
    checks,
    branches,
    scope:
      "Three actual local Ganache branches, issuer nonce reuse and two explicit EVM snapshot rollbacks; not a Byzantine consensus fork, malicious validator or cross-host network fault.",
  });
  console.log(`${checks.length} multi-branch recovery checks passed.`);
} finally {
  await h.stop();
}
