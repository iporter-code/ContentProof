import { it, expect, afterAll } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  claimId,
  prepare,
  disclose,
  typedData,
  ZERO,
  hashBytes,
  salt,
} from "../packages/protocol/index.js";
import { importBundle } from "../packages/bundle/index.js";
mkdirSync("data/test-operations", { recursive: true });
process.env.DATA_DIR = mkdtempSync(resolve("data/test-operations/run-"));
const staleExport = resolve(
  process.env.DATA_DIR,
  "exports",
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.cpe.bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.tmp",
);
mkdirSync(resolve(process.env.DATA_DIR, "exports"));
writeFileSync(staleExport, "crashed encrypted output");
process.env.NODE_ENV = "test";
const admin = privateKeyToAccount(generatePrivateKey()),
  creator = privateKeyToAccount(generatePrivateKey()),
  viewer = privateKeyToAccount(generatePrivateKey());
process.env.OPERATOR_ADDRESSES = admin.address;
const { app } = await import("../apps/api/main.js");
const store = await import("../apps/api/store.js");
async function call(url: string, token = "", payload?: any) {
  const r = await app.inject({
    url,
    method: payload === undefined ? "GET" : "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload,
  });
  return { status: r.statusCode, data: r.json().data, error: r.json().error };
}
async function login(account: typeof admin) {
  const c = await call("/v1/auth/challenge", "", { address: account.address });
  return (
    await call("/v1/auth/verify", "", {
      id: c.data.id,
      signature: await account.signMessage({ message: c.data.message }),
    })
  ).data.token as string;
}
const adminToken = await login(admin),
  creatorToken = await login(creator),
  viewerToken = await login(viewer);
afterAll(async () => {
  await app.close();
});
it("organization approval, invitation acceptance, read/edit roles and suspension are enforced", async () => {
  const created = await call("/v1/organizations", creatorToken, {
    name: "测试机构",
    evidenceDigest: hashBytes(Buffer.from("credential-digest")),
  });
  expect(created.status).toBe(200);
  const id = created.data.id;
  expect(
    (
      await call(`/v1/operator/organizations/${id}/review`, creatorToken, {
        status: "approved",
        reason: "cannot self approve",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call(`/v1/operator/organizations/${id}/review`, adminToken, {
        status: "approved",
        reason: "本地人工核对测试凭证",
      })
    ).status,
  ).toBe(200);
  await call(`/v1/organizations/${id}/members`, creatorToken, {
    address: viewer.address,
    role: "viewer",
  });
  expect((await call(`/v1/organizations/${id}`, viewerToken)).status).toBe(403);
  await call(`/v1/organizations/${id}/accept`, viewerToken, {});
  const bytes = Buffer.from("owned-object"),
    digest = hashBytes(bytes);
  store.run(
    "INSERT INTO assets VALUES(?,?)",
    digest,
    JSON.stringify({
      digest,
      size: bytes.length,
      mediaType: "image/png",
      width: 1,
      height: 1,
    }),
  );
  store.run(
    "INSERT INTO asset_acl VALUES(?,?)",
    digest,
    creator.address.toLowerCase(),
  );
  store.run(
    "INSERT INTO asset_owners VALUES(?,?)",
    digest,
    creator.address.toLowerCase(),
  );
  writeFileSync(store.objectPath(digest), store.encryptObject(bytes));
  await call(`/v1/assets/${digest}/grant`, creatorToken, {
    address: viewer.address,
  });
  expect(store.assetAccess(digest, viewer.address.toLowerCase())).toBe(true);
  expect(store.assetEdit(digest, viewer.address.toLowerCase())).toBe(false);
  await call(`/v1/assets/${digest}/grant`, creatorToken, {
    address: viewer.address,
    permission: "edit",
  });
  expect(store.assetEdit(digest, viewer.address.toLowerCase())).toBe(true);
  await call(`/v1/assets/${digest}/revoke`, creatorToken, {
    address: viewer.address,
  });
  expect(store.assetAccess(digest, viewer.address.toLowerCase())).toBe(false);
  expect(
    (
      await call(`/v1/organizations/${id}/share`, creatorToken, {
        digest,
        permission: "edit",
      })
    ).status,
  ).toBe(200);
  expect(store.assetAccess(digest, viewer.address.toLowerCase())).toBe(true);
  expect(store.assetEdit(digest, viewer.address.toLowerCase())).toBe(false);
  expect(
    (
      await call(`/v1/assets/${digest}/grant`, viewerToken, {
        address: admin.address,
      })
    ).status,
  ).toBe(403);
  await call(`/v1/organizations/${id}/members`, creatorToken, {
    address: viewer.address,
    role: "editor",
  });
  expect(store.assetEdit(digest, viewer.address.toLowerCase())).toBe(true);
  expect(
    (
      await call(`/v1/organizations/${id}/members`, creatorToken, {
        address: creator.address,
        role: "viewer",
      })
    ).error.code,
  ).toBe("LAST_OWNER_REQUIRED");
  await call(`/v1/operator/organizations/${id}/review`, adminToken, {
    status: "suspended",
    reason: "模拟机构资质已失效",
  });
  expect(store.assetAccess(digest, viewer.address.toLowerCase())).toBe(false);
});
it("persistent export produces encrypted disk output, validates disclosure, scopes links and supports cancellation", async () => {
  expect(existsSync(staleExport)).toBe(false);
  const bytes = Buffer.from("export-test-bytes"),
    digest = hashBytes(bytes),
    p = prepare(
      {
        protocol: "contentproof/1",
        assetDigest: digest,
        mediaType: "image/png",
        byteLength: bytes.length,
        operation: "import",
        engineDigest: ZERO,
        issuer: creator.address,
        keyEpoch: "1",
        nonce: "0",
        deadline: "2000000000",
      },
      [{ path: "title", value: "export", salt: salt() }],
      [],
    );
  const domain = {
    name: "ContentProof",
    version: "1",
    chainId: 31337,
    verifyingContract: "0x0000000000000000000000000000000000001234",
  } as const;
  const full: any = {
    core: p.core,
    domain,
    signature: await creator.signTypedData(typedData(p.core, domain)),
    privateFields: p.fields,
    privateParents: p.parents,
  };
  full.disclosure = disclose(full).disclosure;
  const id = claimId(full),
    who = creator.address.toLowerCase();
  store.run(
    "INSERT INTO assets VALUES(?,?)",
    digest,
    JSON.stringify({
      digest,
      size: bytes.length,
      mediaType: "image/png",
      width: 1,
      height: 1,
    }),
  );
  store.run("INSERT INTO asset_acl VALUES(?,?)", digest, who);
  writeFileSync(store.objectPath(digest), store.encryptObject(bytes));
  store.run("INSERT INTO claims VALUES(?,?,?)", id, who, store.encrypt(full));
  store.run("INSERT INTO claim_acl VALUES(?,?)", id, who);
  // Issuing a claim does not authorize resharing someone else's source media.
  expect(
    (
      await call(`/v1/claims/${id}/grant`, creatorToken, {
        address: viewer.address,
        permission: "edit",
      })
    ).data.assetGranted,
  ).toBe(false);
  expect(store.assetAccess(digest, viewer.address.toLowerCase())).toBe(false);
  store.run("INSERT INTO asset_owners VALUES(?,?)", digest, who);
  await call(`/v1/claims/${id}/grant`, creatorToken, {
    address: viewer.address,
    permission: "edit",
  });
  expect(store.assetEdit(digest, viewer.address.toLowerCase())).toBe(true);
  await call(`/v1/claims/${id}/grant`, creatorToken, {
    address: viewer.address,
  });
  expect(store.assetAccess(digest, viewer.address.toLowerCase())).toBe(true);
  expect(store.assetEdit(digest, viewer.address.toLowerCase())).toBe(false);
  await call(`/v1/claims/${id}/revoke`, creatorToken, {
    address: viewer.address,
  });
  expect(store.assetAccess(digest, viewer.address.toLowerCase())).toBe(true);
  await call(`/v1/assets/${digest}/revoke`, creatorToken, {
    address: viewer.address,
  });
  expect(store.assetAccess(digest, viewer.address.toLowerCase())).toBe(false);
  expect(
    (
      await call("/v1/exports/preview", creatorToken, {
        target: id,
        hideFields: ["unknown"],
      })
    ).error.code,
  ).toBe("INVALID_DISCLOSURE_SELECTION");
  const job = (await call("/v1/exports", creatorToken, { target: id })).data;
  store.run(
    "UPDATE exports SET state='running',lease='crashed-worker',leaseUntil=0 WHERE id=?",
    job.id,
  );
  expect((await call(`/v1/exports/${job.id}`, viewerToken)).status).toBe(404);
  let status: any;
  for (let i = 0; i < 60; i++) {
    status = (await call(`/v1/exports/${job.id}`, creatorToken)).data;
    if (["completed", "failed"].includes(status.state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(status.state).toBe("completed");
  const encrypted = readFileSync(
    resolve(process.env.DATA_DIR!, "exports", `${job.id}.cpe`),
  );
  expect(encrypted.subarray(0, 12).toString()).toBe("CP-OBJECT-1\0");
  expect(encrypted.includes(bytes)).toBe(false);
  const res = await app.inject({
      url: `/v1/exports/${job.id}/content`,
      headers: { authorization: `Bearer ${creatorToken}` },
    }),
    bundle = await importBundle(res.rawPayload);
  expect(bundle.target).toBe(id);
  expect(Buffer.from(bundle.files.get(digest)!)).toEqual(bytes);
  const link = (await call(`/v1/exports/${job.id}/link`, creatorToken, {}))
    .data;
  expect((await app.inject({ url: link.url })).statusCode).toBe(200);
  store.run("DELETE FROM asset_acl WHERE digest=? AND owner=?", digest, who);
  expect((await app.inject({ url: link.url })).statusCode).toBe(403);
  store.run("INSERT INTO asset_acl VALUES(?,?)", digest, who);
  await call(`/v1/exports/${job.id}/cancel`, creatorToken, {});
  expect((await app.inject({ url: link.url })).statusCode).toBe(404);
});
it("cursor pages have no overlap and reject malformed cursors", async () => {
  const first = await call("/v1/assets/page?limit=1", creatorToken);
  expect(first.data.nextCursor).toBeTruthy();
  const next = await call(
    `/v1/assets/page?limit=1&cursor=${first.data.nextCursor}`,
    creatorToken,
  );
  expect(first.data.items[0].digest).not.toBe(next.data.items[0].digest);
  expect(
    (await call("/v1/assets/page?cursor=invalid", creatorToken)).status,
  ).toBe(400);
});
it("expired personal grants deny read/edit, pages, statistics and export without waiting for cleanup", async () => {
  const row = store.one(
    "SELECT id,encrypted FROM claims WHERE owner=? LIMIT 1",
    creator.address.toLowerCase(),
  )!;
  const full = store.decrypt<any>(row.encrypted),
    digest = full.core.assetDigest,
    who = viewer.address.toLowerCase();
  expect(
    (
      await call(`/v1/claims/${row.id}/grant`, creatorToken, {
        address: viewer.address,
        permission: "edit",
        expiresAt: Date.now() - 1,
      })
    ).error.code,
  ).toBe("INVALID_GRANT_EXPIRY");
  const expiresAt = Date.now() + 60000;
  expect(
    (
      await call(`/v1/claims/${row.id}/grant`, creatorToken, {
        address: viewer.address,
        permission: "edit",
        expiresAt,
      })
    ).data.expiresAt,
  ).toBe(expiresAt);
  expect(store.assetEdit(digest, who)).toBe(true);
  expect(store.getClaim(row.id, who).core.assetDigest).toBe(digest);
  expect(
    (await call("/v1/exports/preview", viewerToken, { target: row.id })).status,
  ).toBe(200);
  store.run(
    "UPDATE asset_grant_expiries SET expires=? WHERE digest=? AND owner=?",
    Date.now() - 1,
    digest,
    who,
  );
  store.run(
    "UPDATE claim_grant_expiries SET expires=? WHERE id=? AND owner=?",
    Date.now() - 1,
    row.id,
    who,
  );
  expect(store.assetAccess(digest, who)).toBe(false);
  expect(store.assetEdit(digest, who)).toBe(false);
  expect(() => store.getClaim(row.id, who)).toThrow("FORBIDDEN");
  expect(
    (await call("/v1/assets/page", viewerToken)).data.items.some(
      (a: any) => a.digest === digest,
    ),
  ).toBe(false);
  expect(
    (await call("/v1/claims/page", viewerToken)).data.items.some(
      (c: any) => c.id === row.id,
    ),
  ).toBe(false);
  expect((await call("/v1/stats", viewerToken)).data).toEqual({
    assets: 0,
    claims: 0,
  });
  expect(
    (await call("/v1/exports/preview", viewerToken, { target: row.id })).status,
  ).toBe(403);
  store.expireGrants();
  expect(
    store.one(
      "SELECT * FROM asset_grant_expiries WHERE digest=? AND owner=?",
      digest,
      who,
    ),
  ).toBeUndefined();
  expect(
    (
      await call(`/v1/claims/${row.id}/grant`, creatorToken, {
        address: creator.address,
        expiresAt,
      })
    ).error.code,
  ).toBe("CANNOT_EXPIRE_OWNER");
  expect(store.assetAccess(digest, creator.address.toLowerCase())).toBe(true);
  await call(`/v1/claims/${row.id}/grant`, creatorToken, {
    address: viewer.address,
  });
  expect(store.assetAccess(digest, who)).toBe(true);
  expect(store.assetEdit(digest, who)).toBe(false);
});
it("HTTP graph limit rejects a deep graph without returning duplicate node IDs", async () => {
  const { makeFull } = await import("./helpers.js");
  let previous = await makeFull();
  const who = creator.address.toLowerCase();
  function save(m: any) {
    const id = claimId(m);
    store.run("INSERT INTO claims VALUES(?,?,?)", id, who, store.encrypt(m));
    store.run("INSERT INTO claim_acl VALUES(?,?)", id, who);
    return id;
  }
  save(previous);
  for (let i = 0; i < 66; i++) {
    previous = await makeFull({
      parents: [
        {
          claimId: claimId(previous),
          assetDigest: previous.core.assetDigest as `0x${string}`,
          role: "input",
          salt: salt(),
        },
      ],
    });
    save(previous);
  }
  const response = await call(
    `/v1/claims/${claimId(previous)}/graph`,
    creatorToken,
  );
  expect(response.status).toBe(413);
  expect(response.error.code).toBe("GRAPH_LIMIT");
});
it("persistent alerts deduplicate sustained failures, enforce acknowledgement roles and retain recovery history", async () => {
  const { recordAlert } = await import("../apps/api/operations.js"),
    { AlertMonitor } = await import("../packages/operations/alerts.js");
  const monitor = new AlertMonitor(recordAlert),
    signal = {
      code: "TEST_WORKER_PRESSURE",
      severity: "warning" as const,
      description: "验收用持续故障",
      value: 8,
      threshold: 6,
      unhealthy: true,
    };
  monitor.sample([signal]);
  monitor.sample([signal]);
  expect(
    (await call("/v1/system/alerts", creatorToken)).data.alerts,
  ).toHaveLength(0);
  monitor.sample([signal]);
  monitor.sample([signal]);
  let list = (await call("/v1/system/alerts", creatorToken)).data;
  expect(list.alerts).toHaveLength(1);
  expect(list.alerts[0].occurrences).toBe(2);
  expect(list.open).toBe(1);
  const id = list.alerts[0].id;
  expect(
    (await call(`/v1/system/alerts/${id}/ack`, creatorToken, {})).status,
  ).toBe(403);
  expect(
    (await call(`/v1/system/alerts/${id}/ack`, adminToken, {})).data
      .acknowledged,
  ).toBe(true);
  monitor.sample([{ ...signal, unhealthy: false, value: 0 }]);
  monitor.sample([{ ...signal, unhealthy: false, value: 0 }]);
  list = (await call("/v1/system/alerts", adminToken)).data;
  expect(list.open).toBe(0);
  expect(list.alerts[0].resolvedAt).toBeTruthy();
  expect(list.alerts[0].acknowledgedAt).toBeTruthy();
});
it("rate limiting keeps a structured 429 response instead of turning it into an internal error", async () => {
  let response: any;
  for (let i = 0; i < 181; i++)
    response = await app.inject({
      url: "/v1/identities",
      remoteAddress: "192.0.2.20",
    });
  expect(response.statusCode).toBe(429);
  expect(response.json().error.code).toBe("RATE_LIMIT");
});
