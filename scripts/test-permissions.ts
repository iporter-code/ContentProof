import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import sharp from "sharp";
import { LocalHarness, delay, saveReport } from "./local-harness.js";
const h = new LocalHarness("permissions", 3097, 8597),
  checks: string[] = [];
const operator = privateKeyToAccount(generatePrivateKey());
h.env.OPERATOR_ADDRESSES = operator.address;
async function denied(
  path: string,
  token: string,
  body?: unknown,
  code = "FORBIDDEN",
) {
  const response = await h.response(path, token, body);
  assert(!response.ok, `${path}:unexpected success`);
  assert.equal((await response.json()).error.code, code, path);
}
try {
  await h.start();
  const challenge = await h.call("/v1/auth/challenge", "", {
    address: operator.address,
  });
  const op = (
    await h.call("/v1/auth/verify", "", {
      id: challenge.id,
      signature: await operator.signMessage({ message: challenge.message }),
    })
  ).token;
  await h.call("/v1/profile", op, { name: "隔离权限验收审核员" });
  const owner = await h.identity(),
    admin = await h.identity(),
    editor = await h.identity(),
    viewer = await h.identity();
  const bytes = await sharp({
    create: { width: 48, height: 36, channels: 3, background: "#497959" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)]),
    "synthetic-permissions.png",
  );
  const asset = await h.call("/v1/assets", owner.token, form);
  const draft = await h.call("/v1/drafts/import", owner.token, {
      assetDigest: asset.digest,
      fields: { title: "真实链权限验收" },
    }),
    root = await h.sign(draft.id, owner);
  const job = await h.call(`/v1/claims/${root.id}/anchor`, owner.token, {});
  await h.confirmed(job.jobId, owner.token);
  const share = { digest: asset.digest, claimId: root.id, permission: "edit" };
  const org = await h.call("/v1/organizations", owner.token, {
    name: "隔离测试机构",
    evidenceDigest: asset.digest,
  });
  await denied(`/v1/operator/organizations/${org.id}/review`, owner.token, {
    status: "approved",
    reason: "无审核权限不得批准",
  });
  const ownOrg = await h.call("/v1/organizations", op, {
    name: "自审拒绝测试机构",
    evidenceDigest: asset.digest,
  });
  await denied(
    `/v1/operator/organizations/${ownOrg.id}/review`,
    op,
    { status: "approved", reason: "审核人不能批准自己的机构" },
    "SELF_REVIEW_FORBIDDEN",
  );
  await denied(
    `/v1/organizations/${org.id}/share`,
    owner.token,
    share,
    "ORGANIZATION_NOT_APPROVED",
  );
  checks.push(
    "real signed claim; unapproved sharing, unauthorized review and operator self-review rejected",
  );
  await h.call(`/v1/operator/organizations/${org.id}/review`, op, {
    status: "approved",
    reason: "仅验证合成测试凭证与权限流程",
  });
  for (const [who, role] of [
    [admin, "admin"],
    [editor, "editor"],
    [viewer, "viewer"],
  ] as const) {
    await h.call(`/v1/organizations/${org.id}/members`, owner.token, {
      address: who.account.address,
      role,
    });
    await denied(`/v1/organizations/${org.id}`, who.token);
    await h.call(`/v1/organizations/${org.id}/accept`, who.token, {});
  }
  checks.push("three roles require explicit invitation acceptance");
  await h.call(`/v1/organizations/${org.id}/share`, owner.token, share);
  await h.call(`/v1/claims/${root.id}`, viewer.token);
  assert(
    (await h.response(`/v1/assets/${asset.digest}/content`, viewer.token)).ok,
  );
  const transform = {
    parents: [root.id],
    operation: "crop",
    params: { left: 1, top: 1, width: 12, height: 12 },
    fields: { title: "权限派生测试" },
  };
  await denied("/v1/drafts/transform", viewer.token, transform);
  await denied(`/v1/organizations/${org.id}/share`, viewer.token, share);
  await denied(`/v1/organizations/${org.id}/members`, editor.token, {
    address: viewer.account.address,
    role: "admin",
  });
  await denied(`/v1/organizations/${org.id}/members`, admin.token, {
    address: owner.account.address,
    role: "viewer",
  });
  await denied(
    `/v1/organizations/${org.id}/members`,
    owner.token,
    { address: owner.account.address, role: "viewer" },
    "LAST_OWNER_REQUIRED",
  );
  checks.push(
    "viewer reads shared bytes but cannot edit/share; editor cannot administer; admin cannot demote owner; last owner protected",
  );
  await h.call("/v1/drafts/transform", editor.token, transform);
  await h.call(`/v1/organizations/${org.id}/members`, owner.token, {
    address: editor.account.address,
    role: "viewer",
  });
  await denied("/v1/drafts/transform", editor.token, transform);
  await h.call(`/v1/organizations/${org.id}/members`, owner.token, {
    address: viewer.account.address,
    role: "viewer",
    remove: true,
  });
  await denied(`/v1/claims/${root.id}`, viewer.token);
  assert(
    !(await h.call("/v1/claims/page?limit=50", viewer.token)).items.some(
      (m: any) => m.id === root.id,
    ),
  );
  checks.push(
    "role downgrade immediately removes editing; member removal removes claim and paginated access",
  );
  await h.call(`/v1/operator/organizations/${org.id}/review`, op, {
    status: "suspended",
    reason: "测试暂停后已有访问立即失效",
  });
  await denied(`/v1/claims/${root.id}`, admin.token);
  await denied(`/v1/assets/${asset.digest}/content`, admin.token);
  checks.push(
    "organization suspension immediately removes existing claim and byte access",
  );
  await h.call(`/v1/operator/organizations/${org.id}/review`, op, {
    status: "approved",
    reason: "恢复隔离测试机构状态供撤销测试",
  });
  await h.call(`/v1/organizations/${org.id}/share`, owner.token, {
    ...share,
    revoke: true,
  });
  await denied(`/v1/claims/${root.id}`, admin.token);
  checks.push("unsharing removes organization permissions after reapproval");
  await h.call(`/v1/claims/${root.id}/grant`, owner.token, {
    address: viewer.account.address,
    permission: "edit",
    expiresAt: Date.now() + 4500,
  });
  await h.call(`/v1/claims/${root.id}`, viewer.token);
  const pending = await h.call("/v1/drafts/transform", viewer.token, transform);
  await delay(4700);
  await denied(`/v1/claims/${root.id}`, viewer.token);
  await denied(`/v1/assets/${asset.digest}/content`, viewer.token);
  await denied(`/v1/drafts/${pending.id}/prepare`, viewer.token, {});
  await denied("/v1/bundles", viewer.token, {
    target: root.id,
    hideFields: [],
    hideParents: [],
  });
  assert(
    !(await h.call("/v1/claims/page?limit=50", viewer.token)).items.some(
      (m: any) => m.id === root.id,
    ),
  );
  assert.equal((await h.call("/v1/stats", viewer.token)).claims, 0);
  checks.push(
    "real-time grant expiry removes bytes, claim, existing draft preparation, export, pagination and statistics",
  );
  await h.call(`/v1/claims/${root.id}/grant`, owner.token, {
    address: viewer.account.address,
    permission: "read",
  });
  await denied(`/v1/claims/${root.id}/grant`, viewer.token, {
    address: editor.account.address,
    permission: "edit",
  });
  await h.call(`/v1/claims/${root.id}/revoke`, owner.token, {
    address: viewer.account.address,
  });
  await denied(`/v1/claims/${root.id}`, viewer.token);
  await h.call(`/v1/assets/${asset.digest}/revoke`, owner.token, {
    address: viewer.account.address,
  });
  await denied(`/v1/assets/${asset.digest}/content`, viewer.token);
  checks.push(
    "readers cannot redelegate; explicit claim and asset revocation enforced independently",
  );
  console.log(
    `${checks.length} real-chain permission integration groups passed.`,
  );
} finally {
  await h.stop();
  saveReport("permissions-real-chain", {
    date: new Date().toISOString(),
    passed: checks.length === 8,
    checks,
    scope:
      "Isolated HTTP API, real cryptographic identities, PNG bytes and actual EVM. No chain mocks or production data; not browser UI acceptance.",
  });
}
