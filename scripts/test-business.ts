import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import sharp from "sharp";
import { typedData, verify, claimId } from "../packages/protocol/index.js";
import { importBundle } from "../packages/bundle/index.js";
import { observe, publicClient, domain } from "../packages/chain/index.js";
import { reproduce } from "../packages/media/index.js";
import { apiPort, dataPath } from "../packages/config/index.js";
const base = `http://127.0.0.1:${apiPort}`;
const rows: { name: string; passed: boolean }[] = [];
async function call(path: string, token = "", body?: any, method?: string) {
  const r = await fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
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
  const json = await r.json();
  if (!r.ok) throw Error(json.error.message);
  return json.data;
}
const account = privateKeyToAccount(generatePrivateKey()),
  second = privateKeyToAccount(generatePrivateKey());
async function login(a = account) {
  const c = await call("/v1/auth/challenge", "", { address: a.address });
  return (
    await call("/v1/auth/verify", "", {
      id: c.id,
      signature: await a.signMessage({ message: c.message }),
    })
  ).token as string;
}
const token = await login(),
  otherToken = await login(second);
await assert.rejects(call("/v1/demo/login", "", { index: 1 }), /FORBIDDEN/);
rows.push({ name: "default demo routes disabled", passed: true });
await call("/v1/profile", token, { name: "独立用户签名测试" });
await call("/v1/profile", otherToken, { name: "协作用户签名测试" });
rows.push({
  name: "new independent wallets authenticate and enroll",
  passed: true,
});
const png = await sharp({
  create: { width: 64, height: 48, channels: 4, background: "#426959" },
})
  .png()
  .toBuffer();
const form = new FormData();
form.append("file", new Blob([new Uint8Array(png)]), "original.png");
const asset = await call("/v1/assets", token, form);
async function makeDraft(
  operation = "import",
  parents: string[] = [],
  params?: any,
) {
  return operation === "import"
    ? call("/v1/drafts/import", token, {
        assetDigest: asset.digest,
        fields: { title: "真实签名样本" },
      })
    : call("/v1/drafts/transform", token, {
        parents,
        operation,
        params,
        fields: { title: "用户执行裁剪" },
      });
}
async function signDraft(draftId: string, refresh = false) {
  const p = await call(`/v1/drafts/${draftId}/prepare`, token, { refresh });
  const m = await call(`/v1/drafts/${draftId}/signatures`, token, {
    signature: await account.signTypedData(typedData(p.core, p.domain)),
  });
  return m;
}
async function anchor(id: string) {
  const j = await call(`/v1/claims/${id}/anchor`, token, {});
  for (let i = 0; i < 80; i++) {
    const job = await call(`/v1/jobs/${j.jobId}`, token);
    if (job.state === "confirmed") return job;
    if (job.state === "failed") throw Error(job.error);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error("ANCHOR_TIMEOUT");
}
const first = await makeDraft(),
  competing = await makeDraft();
await call(`/v1/drafts/${competing.id}/prepare`, token, {});
const original = await signDraft(first.id);
await anchor(original.id);
await assert.rejects(signDraft(competing.id), /NONCE_CONFLICT/);
const renewed = await signDraft(competing.id, true);
await anchor(renewed.id);
rows.push({
  name: "nonce conflict refresh creates newly signed core",
  passed: true,
});
await call(`/v1/assets/${asset.digest}/grant`, token, {
  address: second.address,
});
await assert.rejects(
  call(`/v1/assets/${asset.digest}/grant`, otherToken, {
    address: account.address,
  }),
  /FORBIDDEN/,
);
await call(`/v1/assets/${asset.digest}/revoke`, token, {
  address: second.address,
});
await assert.rejects(
  call(`/v1/assets/${asset.digest}`, otherToken),
  /FORBIDDEN/,
);
rows.push({
  name: "readers cannot regrant and owner can revoke",
  passed: true,
});
const crop = await makeDraft("crop", [original.id], {
    left: 1,
    top: 2,
    width: 32,
    height: 24,
  }),
  edited = await signDraft(crop.id);
await anchor(edited.id);
const response = await fetch(base + "/v1/bundles", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ target: edited.id, hideFields: [], hideParents: [] }),
});
assert(response.ok);
const bytes = new Uint8Array(await response.arrayBuffer()),
  bundle = await importBundle(bytes);
const report = await verify(bundle.target, { ...bundle, observe, reproduce });
assert.equal(report.outcome, "pass");
assert.equal(report.checks.transformation, "reproduced");
rows.push({
  name: "non-demo user upload/edit/sign/anchor/export/independent verification",
  passed: true,
});
const action = await call("/v1/keys/challenge", token, {
  action: "authorize",
  epoch: "2",
  signer: account.address,
});
await assert.rejects(
  call("/v1/auth/verify", "", {
    id: action.id,
    signature: await account.signMessage({ message: action.message }),
  }),
  /UNAUTHORIZED/,
);
await call("/v1/keys/action", token, {
  id: action.id,
  signature: await account.signMessage({ message: action.message }),
});
const after = await makeDraft(),
  signed2 = await signDraft(after.id);
assert.equal(signed2.manifest.core.keyEpoch, "2");
await anchor(signed2.id);
rows.push({
  name: "active signing epoch selected after key management action",
  passed: true,
});
const deadline = String(Math.floor(Date.now() / 1000) + 300);
const signature = await account.signTypedData({
  domain: domain(),
  types: {
    Withdrawal: [
      { name: "claimId", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Withdrawal",
  message: { claimId: edited.id, deadline: BigInt(deadline) },
});
await call(`/v1/claims/${edited.id}/withdraw`, token, { deadline, signature });
await assert.rejects(
  call(`/v1/claims/${edited.id}/anchor`, token, {}),
  /CLAIM_WITHDRAWN/,
);
assert.equal(
  (await verify(bundle.target, { ...bundle, observe, reproduce })).checks
    .anchor,
  "withdrawn",
);
rows.push({
  name: "user-signed withdrawal and retry cannot revive withdrawn claim",
  passed: true,
});
await call("/v1/auth/logout", otherToken, {});
await assert.rejects(call("/v1/assets", otherToken), /UNAUTHORIZED/);
rows.push({ name: "logout invalidates session", passed: true });
mkdirSync(`${dataPath}/results`, { recursive: true });
writeFileSync(
  `${dataPath}/results/business.json`,
  JSON.stringify({ date: new Date().toISOString(), rows }, null, 2),
);
writeFileSync(`${dataPath}/results/persisted.zip`, bytes);
writeFileSync(
  `${dataPath}/results/persistence-target.json`,
  JSON.stringify({
    claimId: original.id,
    blockNumber: String(await publicClient.getBlockNumber()),
    issuer: account.address,
  }),
);
console.log(
  `${rows.length} non-demo business checks passed. User private keys stayed inside test client memory.`,
);
