import assert from "node:assert/strict";
import sharp from "sharp";
import { LocalHarness, saveReport } from "./local-harness.js";
const h = new LocalHarness("demo-engine", 3099, 8599),
  checks: string[] = [];
h.env.DEMO_MODE = "true";
try {
  await h.start();
  for (const index of [1, 2, 3]) {
    const { token } = await h.call("/v1/demo/login", "", { index });
    assert(token);
    assert((await h.call("/v1/profile", token)).address);
  }
  checks.push(
    "explicit demo mode registers and authenticates all three public demo identities",
  );
  const { token } = await h.call("/v1/demo/login", "", { index: 1 }),
    form = new FormData();
  const bytes = await sharp({
    create: { width: 24, height: 18, channels: 3, background: "#497962" },
  })
    .png()
    .toBuffer();
  form.append("file", new Blob([new Uint8Array(bytes)]), "demo-test.png");
  const asset = await h.call("/v1/assets", token, form),
    draft = await h.call("/v1/drafts/import", token, {
      assetDigest: asset.digest,
      fields: { title: "隔离演示验收" },
    });
  await h.call(`/v1/drafts/${draft.id}/prepare`, token, {});
  const sig = await h.call(`/v1/demo/sign/${draft.id}`, token, {}),
    claim = await h.call(`/v1/drafts/${draft.id}/signatures`, token, sig);
  await h.confirmed(
    (await h.call(`/v1/claims/${claim.id}/anchor`, token, {})).jobId,
    token,
  );
  checks.push(
    "demo upload, expected public-account signature and real anchoring remain available on the unified engine",
  );
  await h.stop();
  await h.start();
  assert.equal(
    (await h.call(`/v1/claims/${claim.id}`, token)).chain.anchor,
    "confirmed",
  );
  checks.push(
    "explicit demo chain preserves signed records across full restart",
  );
  console.log(`${checks.length} isolated demo compatibility groups passed.`);
} finally {
  await h.stop();
  saveReport("demo-engine", {
    date: new Date().toISOString(),
    passed: checks.length === 3,
    checks,
    scope:
      "Explicit DEMO_MODE in a fresh isolated directory; never production keys/data.",
  });
}
