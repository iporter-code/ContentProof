import { it, expect, vi, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const chainState = vi.hoisted(() => ({
  receipt: "reverted",
  anchor: "confirmed",
}));
vi.mock("../packages/chain/index.js", async (original) => {
  const actual = await original<any>();
  return {
    ...actual,
    domain: () => ({
      name: "ContentProof",
      version: "1",
      chainId: 31337,
      verifyingContract: "0x0000000000000000000000000000000000001234",
    }),
    deployment: () => ({
      chainId: 31337,
      identity: "0x0000000000000000000000000000000000000001",
      provenance: "0x0000000000000000000000000000000000001234",
      identityAbi: [],
      provenanceAbi: [],
    }),
    wallet: () => ({ writeContract: async () => `0x${"ab".repeat(32)}` }),
    nonce: async () => "0",
    observe: async () => ({ anchor: chainState.anchor, identity: "active" }),
    publicClient: {
      ...actual.publicClient,
      readContract: async ({ functionName }: any) =>
        functionName === "isKeyActive"
          ? true
          : ["0x0000000000000000000000000000000000000000", 0n, 0n, 0n],
      waitForTransactionReceipt: async () => ({ status: chainState.receipt }),
    },
  };
});
mkdirSync("data/test-audit-api", { recursive: true });
process.env.DATA_DIR = mkdtempSync(resolve("data/test-audit-api/run-"));
process.env.NODE_ENV = "test";
process.env.TRUSTED_PROXIES = "127.0.0.1/32";
const { app } = await import("../apps/api/main.js");
const store = await import("../apps/api/store.js");
const { demoAccount } = await import("../packages/chain/index.js");
const { makeFull } = await import("./helpers.js");
const { claimId, typedData } = await import("../packages/protocol/index.js");
const account = demoAccount(1),
  who = account.address.toLowerCase();
async function call(
  url: string,
  payload?: Record<string, unknown>,
  token?: string,
) {
  return app.inject({
    url,
    method: payload === undefined ? "GET" : "POST",
    payload,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
const challenge = (
  await call("/v1/auth/challenge", { address: account.address })
).json().data;
const token = (
  await call("/v1/auth/verify", {
    id: challenge.id,
    signature: await account.signMessage({ message: challenge.message }),
  })
).json().data.token;
afterAll(() => app.close());
it("browser security headers also cover static entry points, rejected requests and errors", async () => {
  const { browserSecurityHeaders } =
    await import("../packages/config/browser-security.js");
  const responses = [
    await app.inject({ url: "/login" }),
    await app.inject({ url: "/health/live" }),
    await app.inject({ url: "/v1/profile" }),
    await app.inject({ url: "/v1/not-a-route" }),
    await app.inject({
      url: "/v1/profile",
      headers: { origin: "https://untrusted.invalid" },
    }),
  ];
  expect(responses.map((r) => r.statusCode).slice(1)).toEqual([
    200, 401, 404, 403,
  ]);
  for (const response of responses)
    for (const [name, value] of Object.entries(browserSecurityHeaders))
      expect(response.headers[name.toLowerCase()]).toBe(value);
});
it("reverted enrollment and key authorization never publish profiles or epochs", async () => {
  const failed = await call("/v1/profile", { name: "test profile" }, token);
  expect(failed.json().error.code).toBe("TRANSACTION_REVERTED");
  expect(
    store.one("SELECT address FROM profiles WHERE address=?", who),
  ).toBeUndefined();
  store.run(
    "INSERT INTO profiles(address,name,epoch,created) VALUES(?,?,?,?)",
    who,
    "test profile",
    "1",
    new Date().toISOString(),
  );
  const c = (
    await call(
      "/v1/keys/challenge",
      { action: "authorize", epoch: "2", signer: account.address },
      token,
    )
  ).json().data;
  const r = await call(
    "/v1/keys/action",
    { id: c.id, signature: await account.signMessage({ message: c.message }) },
    token,
  );
  expect(r.json().error.code).toBe("TRANSACTION_REVERTED");
  expect(
    store.one("SELECT epoch FROM profiles WHERE address=?", who)?.epoch,
  ).toBe("1");
  expect(
    store.one("SELECT id FROM audit WHERE action='key-authorize'"),
  ).toBeUndefined();
});
it("reverted withdrawal returns an error and leaves the registration job unchanged", async () => {
  const full = await makeFull(),
    id = claimId(full),
    job = "cc4469ae-478a-4dd9-a142-7b016050eefa";
  store.run("INSERT INTO claims VALUES(?,?,?)", id, who, store.encrypt(full));
  store.run("INSERT INTO claim_acl VALUES(?,?)", id, who);
  store.run(
    "INSERT INTO jobs(id,owner,claimId,state) VALUES(?,?,?,'confirmed')",
    job,
    who,
    id,
  );
  const r = await call(
    `/v1/claims/${id}/withdraw`,
    { deadline: "2000000000", signature: `0x${"11".repeat(65)}` },
    token,
  );
  expect(r.statusCode).toBe(400);
  expect(r.json().error.code).toBe("TRANSACTION_REVERTED");
  expect(store.one("SELECT state FROM jobs WHERE id=?", job)?.state).toBe(
    "confirmed",
  );
});
it("revocation blocks cached preparations, signature submissions and new anchor requests", async () => {
  const full = await makeFull({ bytes: Buffer.from("revoked source") }),
    digest = full.core.assetDigest;
  store.run(
    "INSERT INTO assets VALUES(?,?)",
    digest,
    JSON.stringify({
      digest,
      size: full.core.byteLength,
      mediaType: "image/png",
      width: 1,
      height: 1,
    }),
  );
  store.run("INSERT INTO asset_acl VALUES(?,?)", digest, who);
  store.run("INSERT INTO asset_editors VALUES(?,?)", digest, who);
  writeFileSync(
    store.objectPath(digest),
    store.encryptObject(Buffer.from("revoked source")),
  );
  const d = (
    await call(
      "/v1/drafts/import",
      { assetDigest: digest, fields: { title: "local draft" } },
      token,
    )
  ).json().data;
  const p = (await call(`/v1/drafts/${d.id}/prepare`, {}, token)).json().data;
  expect(p.fields[0].path).toBe("title");
  const signature = await account.signTypedData(typedData(p.core, p.domain));
  store.run("DELETE FROM asset_acl WHERE digest=? AND owner=?", digest, who);
  expect((await call(`/v1/drafts/${d.id}/prepare`, {}, token)).statusCode).toBe(
    403,
  );
  expect(
    (await call(`/v1/drafts/${d.id}/signatures`, { signature }, token))
      .statusCode,
  ).toBe(403);
  const id = claimId(full);
  store.run("INSERT INTO claims VALUES(?,?,?)", id, who, store.encrypt(full));
  store.run("INSERT INTO claim_acl VALUES(?,?)", id, who);
  expect((await call(`/v1/claims/${id}/anchor`, {}, token)).statusCode).toBe(
    403,
  );
});
it("only trusted proxy addresses can separate client rate limits and health probes retain their budget", async () => {
  for (let i = 0; i < 180; i++)
    expect(
      (
        await app.inject({
          url: "/v1/identities",
          remoteAddress: "127.0.0.1",
          headers: { "x-forwarded-for": "198.51.100.11" },
        })
      ).statusCode,
    ).toBe(200);
  expect(
    (
      await app.inject({
        url: "/v1/identities",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "198.51.100.11" },
      })
    ).statusCode,
  ).toBe(429);
  expect(
    (
      await app.inject({
        url: "/v1/identities",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "198.51.100.12" },
      })
    ).statusCode,
  ).toBe(200);
  for (let i = 0; i < 181; i++)
    await app.inject({
      url: "/v1/identities",
      remoteAddress: "192.0.2.44",
      headers: { "x-forwarded-for": `198.51.100.${(i % 200) + 1}` },
    });
  expect(
    (
      await app.inject({
        url: "/v1/identities",
        remoteAddress: "192.0.2.44",
        headers: { "x-forwarded-for": "203.0.113.8" },
      })
    ).statusCode,
  ).toBe(429);
  expect(
    (await app.inject({ url: "/health/live", remoteAddress: "192.0.2.44" }))
      .statusCode,
  ).toBe(200);
});
