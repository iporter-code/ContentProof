import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  hashBytes,
  jcs,
  strictJSON,
  merkleRoot,
  merkleProof,
  verifyProof,
  disclose,
  checkDisclosure,
  claimId,
  signer,
  verify,
  salt,
  EMPTY_ROOT,
  commitField,
} from "../packages/protocol/index.js";
import { makeFull } from "./helpers.js";
import { demoAccount } from "../packages/chain/index.js";
const online = async () => ({
  anchor: "confirmed" as const,
  identity: "active" as const,
});
describe("canonical protocol and privacy", () => {
  it("matches standard SHA-256 and canonical key ordering", () => {
    expect(hashBytes(Buffer.from("abc"))).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(jcs({ z: 1, a: 2 }).toString()).toBe('{"a":2,"z":1}');
  });
  it.each([
    '{"a":1,"a":2}',
    '{"x":{"a":1,"a":3}}',
    '{"a":1e400}',
    '{"a":9007199254740993}',
    '{"a":"\\ud800"}',
    '{"a":1,}',
    "[1,]",
  ])("rejects ambiguous JSON %s", (text) =>
    expect(() => strictJSON(text)).toThrow(),
  );
  it("accepts valid surrogate pairs and escaped keys", () =>
    expect(strictJSON('{"x":"\\ud83d\\ude00","a\\\"":1}')).toEqual({
      x: "😀",
      'a"': 1,
    }));
  it("defines empty tree without an inclusion proof", () => {
    expect(merkleRoot([])).toBe(EMPTY_ROOT);
    expect(() => merkleProof([], 0)).toThrow();
  });
  it.each([1, 2, 3, 5, 128])(
    "verifies every indexed leaf in a %i leaf tree",
    (size) => {
      const leaves = Array.from({ length: size }, (_, i) =>
        hashBytes(Buffer.from(String(i))),
      );
      for (let i = 0; i < size; i++)
        expect(
          verifyProof(leaves[i], merkleProof(leaves, i), merkleRoot(leaves)),
        ).toBe(true);
    },
  );
  it("rejects modified leaves under randomized tree shapes", () =>
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 128 }),
        (values) => {
          const leaves = values.map((v) => hashBytes(Buffer.from(v))),
            root = merkleRoot(leaves);
          const proof = merkleProof(leaves, 0);
          return (
            verifyProof(leaves[0], proof, root) &&
            !verifyProof(
              hashBytes(Buffer.from("altered-" + values[0])),
              proof,
              root,
            )
          );
        },
      ),
      { numRuns: 100 },
    ));
  it("rejects extra siblings and invalid indices/counts", () => {
    const leaves = ["a", "b", "c"].map((x) => hashBytes(Buffer.from(x))),
      p = merkleProof(leaves, 2),
      r = merkleRoot(leaves);
    expect(
      verifyProof(leaves[2], { ...p, siblings: [...p.siblings, r] }, r),
    ).toBe(false);
    expect(verifyProof(leaves[2], { ...p, index: 3 }, r)).toBe(false);
    expect(verifyProof(leaves[2], { ...p, leafCount: 0 }, r)).toBe(false);
  });
  it("recovers EIP712 signer and binds domain", async () => {
    const m = await makeFull();
    expect(await signer(m)).toBe(demoAccount(1).address);
    const altered = structuredClone(m);
    altered.domain.chainId++;
    expect(claimId(altered)).not.toBe(claimId(m));
    expect(await signer(altered)).not.toBe(demoAccount(1).address);
  });
  it("preserves committed roots while hiding private fields", async () => {
    const m = await makeFull(),
      hidden = disclose(m, ["private.note"]);
    expect(checkDisclosure(hidden)).toBe("partial");
    expect(JSON.stringify(hidden)).not.toContain("secret");
    expect(hidden.core.claimsRoot).toBe(m.core.claimsRoot);
  });
  it("rejects changed values, paths, salt and duplicate proofs", async () => {
    const m = disclose(await makeFull());
    for (const change of [
      (x: any) => (x.disclosure.fields[0].value = "wrong"),
      (x: any) => (x.disclosure.fields[0].path = "wrong"),
      (x: any) => (x.disclosure.fields[0].salt = salt()),
      (x: any) => x.disclosure.fields.push(x.disclosure.fields[0]),
    ]) {
      const copy = structuredClone(m);
      change(copy);
      expect(() => checkDisclosure(copy)).toThrow();
    }
  });
  it("counts hidden parents without claiming complete ancestry", async () => {
    const parent = await makeFull(),
      child = await makeFull({
        parents: [
          {
            claimId: claimId(parent),
            assetDigest: parent.core.assetDigest as `0x${string}`,
            role: "input-0",
            salt: salt(),
          },
        ],
      });
    const hidden = disclose(child, [], [0]);
    const r = await verify(claimId(child), {
      manifests: new Map([[claimId(child), hidden]]),
      files: new Map([
        [child.core.assetDigest, Buffer.from("test-image-bytes")],
      ]),
      observe: online,
    });
    expect(r.checks.ancestry).toBe("withheld");
    expect(r.outcome).toBe("incomplete");
  });
  it("detects deleted parent slots and changed parent roots", async () => {
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
      });
    const copy = disclose(c);
    copy.disclosure.parents = [];
    expect(() => checkDisclosure(copy)).toThrow();
  });
  it("distinguishes missing evidence, invalid evidence, file corruption and offline", async () => {
    const m = await makeFull(),
      id = claimId(m),
      files = new Map([[m.core.assetDigest, Buffer.from("test-image-bytes")]]),
      manifests = new Map([[id, disclose(m)]]);
    expect(
      (await verify(id, { manifests, files, observe: online })).outcome,
    ).toBe("pass");
    expect((await verify(id, { manifests, files })).checks.anchor).toBe(
      "offline",
    );
    expect(
      (await verify(id, { manifests, files: new Map(), observe: online }))
        .outcome,
    ).toBe("incomplete");
    expect(
      (
        await verify(id, {
          manifests,
          files: new Map([[m.core.assetDigest, Buffer.from("bad")]]),
          observe: online,
        })
      ).outcome,
    ).toBe("fail");
    expect(
      (await verify(id, { manifests: new Map(), files })).checks.ancestry,
    ).toBe("missing");
  });
  it("does not trust revoked or withdrawn declarations", async () => {
    const m = await makeFull(),
      deps = {
        manifests: new Map([[claimId(m), disclose(m)]]),
        files: new Map([[m.core.assetDigest, Buffer.from("test-image-bytes")]]),
      };
    expect(
      (
        await verify(claimId(m), {
          ...deps,
          observe: async () => ({ anchor: "confirmed", identity: "revoked" }),
        })
      ).outcome,
    ).toBe("fail");
    expect(
      (
        await verify(claimId(m), {
          ...deps,
          observe: async () => ({ anchor: "withdrawn", identity: "active" }),
        })
      ).outcome,
    ).toBe("fail");
  });
  it("commitments do not depend on attached proof metadata", () => {
    const f = { path: "a", value: "x", salt: salt() };
    expect(commitField({ ...f, proof: {} } as any, 0)).toBe(commitField(f, 0));
  });
});
