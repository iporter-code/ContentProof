import { it, expect } from "vitest";
import { zipSync } from "fflate";
import { importBundle } from "../packages/bundle/index.js";
import {
  claimId,
  disclose,
  verify,
  salt,
  strictJSON,
  type Manifest,
} from "../packages/protocol/index.js";
import { makeFull } from "./helpers.js";
it("rejects duplicate ZIP entry names before merging", async () => {
  const zip = Buffer.from(
    zipSync({
      "bundle.json": Buffer.from("{}"),
      "bundlf.json": Buffer.from("{}"),
    }),
  );
  const from = Buffer.from("bundlf.json"),
    to = Buffer.from("bundle.json");
  for (let i = 0; i < zip.length - from.length; i++)
    if (zip.subarray(i, i + from.length).equals(from)) to.copy(zip, i);
  await expect(importBundle(zip)).rejects.toThrow("DUPLICATE_ZIP_ENTRY");
});
it("rejects symbolic-link ZIP entries", async () => {
  const zip = Buffer.from(zipSync({ "bundle.json": Buffer.from("{}") }));
  const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const pos = zip.indexOf(sig);
  expect(pos).toBeGreaterThan(0);
  zip.writeUInt32LE((0xa1ff * 65536) >>> 0, pos + 38);
  await expect(importBundle(zip)).rejects.toThrow("ZIP_SYMLINK");
});
it("rejects excessive compression ratios before inflating", async () => {
  const zip = zipSync(
    { "bundle.json": new Uint8Array(2 * 1024 * 1024) },
    { level: 9 },
  );
  await expect(importBundle(zip)).rejects.toThrow("ZIP_RATIO_LIMIT");
});
it("bounds JSON depth and extra top-level tokens", () => {
  expect(() => strictJSON("[".repeat(66) + "0" + "]".repeat(66))).toThrow(
    "JSON_TOO_DEEP",
  );
  expect(() => strictJSON("{} {}")).toThrow();
});
it("bounds ancestry depth without unbounded recursion", async () => {
  const manifests = new Map<string, Manifest>();
  let previous = await makeFull();
  manifests.set(claimId(previous), disclose(previous));
  for (let i = 0; i < 66; i++) {
    const next = await makeFull({
      parents: [
        {
          claimId: claimId(previous),
          assetDigest: previous.core.assetDigest as `0x${string}`,
          role: "input",
          salt: salt(),
        },
      ],
    });
    manifests.set(claimId(next), disclose(next));
    previous = next;
  }
  const report = await verify(claimId(previous), {
    manifests,
    files: new Map([
      [previous.core.assetDigest, Buffer.from("test-image-bytes")],
    ]),
    observe: async () => ({ anchor: "confirmed", identity: "active" }),
  });
  expect(report.outcome).toBe("fail");
  expect(
    report.reasons.some(
      (r) => r.code === "INVALID_EVIDENCE" || r.code === "GRAPH_REJECTED",
    ),
  ).toBe(true);
});
