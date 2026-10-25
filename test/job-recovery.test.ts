import { it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const observation = vi.hoisted(() => ({ anchor: "absent" }));
vi.mock("../packages/chain/index.js", async (original) => ({
  ...(await original<any>()),
  observe: async () => ({ anchor: observation.anchor, identity: "active" }),
}));
mkdirSync("data/test-job-recovery", { recursive: true });
process.env.DATA_DIR = mkdtempSync(resolve("data/test-job-recovery/run-"));
process.env.NODE_ENV = "test";
const { app } = await import("../apps/api/main.js");
const store = await import("../apps/api/store.js");
const { demoAccount } = await import("../packages/chain/index.js");
const { makeFull } = await import("./helpers.js");
const { claimId } = await import("../packages/protocol/index.js");
afterAll(() => app.close());
it("an orphaned registration can be retried without stale tx data or resetting an active lease", async () => {
  const account = demoAccount(1),
    full = await makeFull(),
    id = claimId(full),
    owner = account.address.toLowerCase();
  store.run("INSERT INTO assets VALUES(?,?)", full.core.assetDigest, "{}");
  store.run(
    "INSERT INTO asset_owners VALUES(?,?)",
    full.core.assetDigest,
    owner,
  );
  store.run("INSERT INTO asset_acl VALUES(?,?)", full.core.assetDigest, owner);
  store.run("INSERT INTO claims VALUES(?,?,?)", id, owner, store.encrypt(full));
  store.run("INSERT INTO claim_acl VALUES(?,?)", id, owner);
  const req = async (
    url: string,
    payload?: Record<string, unknown>,
    token?: string,
  ) =>
    (
      await app.inject({
        url,
        method: payload === undefined ? "GET" : "POST",
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    ).json();
  const challenge = (
    await req("/v1/auth/challenge", { address: account.address })
  ).data;
  const token = (
    await req("/v1/auth/verify", {
      id: challenge.id,
      signature: await account.signMessage({ message: challenge.message }),
    })
  ).data.token;
  store.run(
    "INSERT INTO jobs(id,owner,claimId,state,txHash,result,attempts,leaseUntil) VALUES(?,?,?,'confirmed',?,?,4,9999999999999)",
    "fa8e8ad1-89fa-4bf6-b779-8f905e7c4bd8",
    owner,
    id,
    "0x" + "aa".repeat(32),
    JSON.stringify({ blockNumber: "15" }),
  );
  const orphan = (
    await req("/v1/jobs/fa8e8ad1-89fa-4bf6-b779-8f905e7c4bd8", undefined, token)
  ).data;
  expect(orphan.state).toBe("orphaned");
  observation.anchor = "confirmed";
  const restored = (
    await req("/v1/jobs/fa8e8ad1-89fa-4bf6-b779-8f905e7c4bd8", undefined, token)
  ).data;
  expect(restored.state).toBe("confirmed");
  expect(restored.registrationStatus).toBe("confirmed");
  observation.anchor = "withdrawn";
  expect(
    (
      await req(
        "/v1/jobs/fa8e8ad1-89fa-4bf6-b779-8f905e7c4bd8",
        undefined,
        token,
      )
    ).data.state,
  ).toBe("withdrawn");
  observation.anchor = "pending";
  expect(
    (
      await req(
        "/v1/jobs/fa8e8ad1-89fa-4bf6-b779-8f905e7c4bd8",
        undefined,
        token,
      )
    ).data.state,
  ).toBe("pending");
  observation.anchor = "absent";
  await req("/v1/jobs/fa8e8ad1-89fa-4bf6-b779-8f905e7c4bd8", undefined, token);
  expect((await req(`/v1/claims/${id}/anchor`, {}, token)).data.jobId).toBe(
    "fa8e8ad1-89fa-4bf6-b779-8f905e7c4bd8",
  );
  const queued = store.one(
    "SELECT * FROM jobs WHERE id='fa8e8ad1-89fa-4bf6-b779-8f905e7c4bd8'",
  )!;
  expect(queued.state).toBe("queued");
  expect(queued.txHash).toBeNull();
  expect(queued.result).toBeNull();
  expect(queued.attempts).toBe(0);
  expect(queued.leaseUntil).toBe(0);
  store.run(
    "UPDATE jobs SET state='submitted',attempts=1,leaseUntil=9999999999999 WHERE id='fa8e8ad1-89fa-4bf6-b779-8f905e7c4bd8'",
  );
  await req(`/v1/claims/${id}/anchor`, {}, token);
  expect(
    store.one(
      "SELECT * FROM jobs WHERE id='fa8e8ad1-89fa-4bf6-b779-8f905e7c4bd8'",
    )!.state,
  ).toBe("submitted");
  expect(
    store.one(
      "SELECT * FROM jobs WHERE id='fa8e8ad1-89fa-4bf6-b779-8f905e7c4bd8'",
    )!.attempts,
  ).toBe(1);
});
