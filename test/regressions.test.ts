import { it, expect } from "vitest";
import sharp from "sharp";
import { makeFull } from "./helpers.js";
import {
  claimId,
  disclose,
  verify,
  checkDisclosure,
  salt,
  type PrivateManifest,
  type Manifest,
} from "../packages/protocol/index.js";
import { inspect } from "../packages/media/index.js";
import { policySchema, checkPolicy } from "../packages/protocol/policy.js";
const online = async () => ({
  anchor: "confirmed" as const,
  identity: "active" as const,
});
it("BUG04 signature failure preserves correct disclosure classification", async () => {
  const m = disclose(await makeFull()),
    id = claimId(m);
  m.signature = `0x${"00".repeat(65)}`;
  expect(checkDisclosure(m)).toBe("complete");
  const r = await verify(id, {
    manifests: new Map([[id, m]]),
    files: new Map(),
  });
  expect(r.outcome).toBe("fail");
  expect(r.checks.signature).toBe("invalid");
  expect(r.checks.disclosure).toBe("complete");
});
it("BUG05 invalid parent is not counted as verified", async () => {
  const p = await makeFull(),
    c = await makeFull({
      parents: [
        {
          claimId: claimId(p),
          assetDigest: p.core.assetDigest as `0x${string}`,
          role: "input",
          salt: salt(),
        },
      ],
    }),
    bad = disclose(p);
  bad.signature = `0x${"00".repeat(65)}`;
  const r = await verify(claimId(c), {
    manifests: new Map([
      [claimId(c), disclose(c)],
      [claimId(p), bad],
    ]),
    files: new Map([[p.core.assetDigest, Buffer.from("test-image-bytes")]]),
    observe: online,
  });
  expect(r.outcome).toBe("fail");
  expect(r.graph.verifiedSlots).toBe(0);
});
it("BUG07 explicit issuer policy applies without a network observer", async () => {
  const m = disclose(await makeFull()),
    policy = policySchema.parse({ trustedIssuers: [] });
  expect(checkPolicy(m, policy)).toBe(false);
  const r = await verify(claimId(m), {
    manifests: new Map([[claimId(m), m]]),
    files: new Map(),
    policy,
  });
  expect(r.outcome).toBe("fail");
  expect(r.reasons.some((x) => x.code === "POLICY_REJECTED")).toBe(true);
  expect(() => policySchema.parse({ trustedIssuers: "anyone" })).toThrow();
});
it("BUG08 rejects PNG with readable metadata but truncated image data", async () => {
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 4, background: "green" },
  })
    .png()
    .toBuffer();
  await expect(inspect(bytes.subarray(0, 64))).rejects.toThrow();
  expect((await inspect(bytes)).width).toBe(64);
});
it("BUG03 exactly 1000 nodes followed by an already visited parent remain valid", async () => {
  const manifests = new Map<string, Manifest>();
  let layer: PrivateManifest[] = [];
  for (let i = 0; i < 500; i++) {
    const m = await makeFull();
    layer.push(m);
    manifests.set(claimId(m), disclose(m));
  }
  const first = layer[0];
  while (layer.length > 1) {
    const next: PrivateManifest[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 === layer.length) {
        next.push(layer[i]);
        continue;
      }
      const m = await makeFull({
        parents: layer.slice(i, i + 2).map((m, index) => ({
          claimId: claimId(m),
          assetDigest: m.core.assetDigest as `0x${string}`,
          role: `input-${index}`,
          salt: salt(),
        })),
      });
      next.push(m);
      manifests.set(claimId(m), disclose(m));
    }
    layer = next;
  }
  const root = await makeFull({
    parents: [...layer, first].map((m, index) => ({
      claimId: claimId(m),
      assetDigest: m.core.assetDigest as `0x${string}`,
      role: `input-${index}`,
      salt: salt(),
    })),
  });
  manifests.set(claimId(root), disclose(root));
  expect(manifests.size).toBe(1000);
  const r = await verify(claimId(root), {
    reproduce: async () => "reproduced",
    manifests,
    files: new Map([[root.core.assetDigest, Buffer.from("test-image-bytes")]]),
    observe: online,
  });
  expect(r.graph.nodes).toBe(1000);
  expect(r.outcome).toBe("pass");
  // This is a correctness regression with 1000 real signatures, not a 30-second
  // performance requirement. Allow fixture creation on slower/loaded hosts.
}, 60000);
