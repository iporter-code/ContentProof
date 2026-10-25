import { it, expect } from "vitest";
import {
  reviewPrepared,
  reviewedClaimId,
  type SigningIntent,
} from "../apps/web/src/integrity.js";
import { makeFull } from "./helpers.js";
import {
  prepare,
  claimId,
  hashBytes,
  salt,
  type PrivateManifest,
} from "../packages/protocol/index.js";

function context(m: PrivateManifest) {
  const intent: SigningIntent = {
    issuer: m.core.issuer,
    keyEpoch: m.core.keyEpoch,
    domain: m.domain,
    operation: m.core.operation,
    assetDigest: m.core.assetDigest,
    mediaType: m.core.mediaType,
    byteLength: m.core.byteLength,
    engineDigest: m.core.engineDigest,
    fields: Object.fromEntries(m.privateFields.map((f) => [f.path, f.value])),
    parents: m.privateParents.map(({ claimId, assetDigest, role }) => ({
      claimId,
      assetDigest,
      role,
    })),
  };
  return {
    intent,
    response: {
      core: m.core,
      domain: m.domain,
      fields: m.privateFields,
      parents: m.privateParents,
    },
  };
}
it("browser commitment calculation agrees with protocol vectors including canonical nested JSON and empty trees", async () => {
  for (const fields of [
    [],
    [{ path: "title", value: { z: ["中文", 3], a: true }, salt: salt() }],
  ]) {
    const m = await makeFull({ fields });
    const { intent, response } = context(m);
    expect(reviewedClaimId(reviewPrepared(response, intent))).toBe(claimId(m));
  }
});
it("refuses server-substituted metadata even if the server recomputes a valid commitment", async () => {
  const m = await makeFull();
  const { intent, response } = context(m);
  const fields = m.privateFields.map((f) => ({
    ...f,
    value: "server substituted",
  }));
  const updated = prepare(m.core, fields, []);
  expect(() =>
    reviewPrepared(
      { ...response, core: updated.core, fields: updated.fields },
      intent,
    ),
  ).toThrow("本地草稿");
});
it("refuses omitted or additional fields and salts that do not match the signed root", async () => {
  const m = await makeFull();
  const { intent, response } = context(m);
  for (const fields of [
    [],
    [...m.privateFields, { path: "extra", value: "unexpected", salt: salt() }],
    m.privateFields.map((f) => ({ ...f, salt: salt() })),
  ])
    expect(() => reviewPrepared({ ...response, fields }, intent)).toThrow();
});
it("binds ordered parents and operation parameters to the locally selected inputs", async () => {
  const a = await makeFull(),
    b = await makeFull({ bytes: Buffer.from("other input") });
  const m = await makeFull({
    fields: [
      { path: "operation.params", value: { left: 0, top: 1 }, salt: salt() },
    ],
    parents: [a, b].map((p, i) => ({
      claimId: claimId(p),
      assetDigest: p.core.assetDigest as `0x${string}`,
      role: `input-${i}`,
      salt: salt(),
    })),
  });
  const { intent, response } = context(m);
  expect(reviewedClaimId(reviewPrepared(response, intent))).toBe(claimId(m));
  const swapped = prepare(
    m.core,
    m.privateFields,
    [...m.privateParents].reverse(),
  );
  expect(() =>
    reviewPrepared(
      { ...response, core: swapped.core, parents: swapped.parents },
      intent,
    ),
  ).toThrow();
  const changed = prepare(
    m.core,
    [{ ...m.privateFields[0], value: { left: 9, top: 1 } }],
    m.privateParents,
  );
  expect(() =>
    reviewPrepared(
      { ...response, core: changed.core, fields: changed.fields },
      intent,
    ),
  ).toThrow();
});
it("refuses substituted files, issuers, epochs, engines and signing domains", async () => {
  const m = await makeFull();
  const { intent, response } = context(m);
  for (const patch of [
    { assetDigest: hashBytes(Buffer.from("other")) },
    { byteLength: 1 },
    { issuer: "0x0000000000000000000000000000000000000001" },
    { keyEpoch: "2" },
    { mediaType: "image/jpeg" },
  ])
    expect(() =>
      reviewPrepared({ ...response, core: { ...m.core, ...patch } }, intent),
    ).toThrow();
  expect(() =>
    reviewPrepared(
      { ...response, domain: { ...m.domain, chainId: 1 } },
      intent,
    ),
  ).toThrow();
  expect(() =>
    reviewPrepared(
      {
        ...response,
        domain: {
          ...m.domain,
          verifyingContract: "0x0000000000000000000000000000000000000001",
        },
      },
      intent,
    ),
  ).toThrow();
});
