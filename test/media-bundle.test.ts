import { it, expect } from "vitest";
import sharp from "sharp";
import { zipSync } from "fflate";
import { inspect, execute } from "../packages/media/index.js";
import { exportBundle, importBundle } from "../packages/bundle/index.js";
import { claimId, disclose, hashBytes } from "../packages/protocol/index.js";
import { makeFull } from "./helpers.js";
const image = () =>
  sharp({
    create: { width: 64, height: 48, channels: 4, background: "#426959" },
  })
    .png()
    .toBuffer();
it("inspects real PNG bytes and rejects format spoofing", async () => {
  expect((await inspect(await image())).width).toBe(64);
  await expect(inspect(Buffer.from("<svg/>"))).rejects.toThrow();
});
it("native image loaders accept PNG/JPEG but block other formats even when inspect is bypassed", async () => {
  const png = await image();
  const jpeg = await sharp(png).jpeg().toBuffer();
  expect((await inspect(jpeg)).mediaType).toBe("image/jpeg");
  const tiff = await sharp(png).tiff().toBuffer();
  await expect(sharp(tiff).metadata()).rejects.toThrow(/blocked|unsupported/i);
  await expect(
    sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
      ),
    ).metadata(),
  ).rejects.toThrow(/blocked|unsupported/i);
});
it("executes real repeatable crop, resize, rotation and composition", async () => {
  const bytes = await image();
  for (const [op, params] of [
    ["crop", { left: 2, top: 3, width: 20, height: 20 }],
    ["resize", { width: 32, height: 24 }],
    ["rotate", { angle: 90 }],
  ] as const) {
    const a = await execute(op, [bytes], params),
      b = await execute(op, [bytes], params);
    expect(hashBytes(a)).toBe(hashBytes(b));
  }
  const overlay = await sharp({
    create: { width: 8, height: 8, channels: 4, background: "orange" },
  })
    .png()
    .toBuffer();
  expect(
    (
      await inspect(
        await execute("compose", [bytes, overlay], { left: 4, top: 4 }),
      )
    ).width,
  ).toBe(64);
});
it("rejects unsafe operations and bounds", async () => {
  const b = await image();
  await expect(
    execute("crop", [b], { left: 60, top: 0, width: 20, height: 10 }),
  ).rejects.toThrow();
  await expect(execute("rotate", [b], { angle: 45 })).rejects.toThrow();
  await expect(
    execute("resize", [b], { width: 5000, height: 5000 }),
  ).rejects.toThrow();
});
it("round-trips a real ZIP without hidden field leakage", async () => {
  const bytes = await image(),
    m = await makeFull({ bytes }),
    id = claimId(m);
  const zip = exportBundle({
    target: id,
    manifests: new Map([[id, disclose(m, ["private.note"])]]),
    files: new Map([[m.core.assetDigest, bytes]]),
  });
  expect(Buffer.from(zip).includes(Buffer.from("secret"))).toBe(false);
  const b = await importBundle(zip);
  expect(b.target).toBe(id);
  expect(Buffer.from(b.files.get(m.core.assetDigest)!)).toEqual(bytes);
});
it("rejects traversal, symlinks-as-names and unknown paths", async () => {
  for (const p of ["../evil", "/tmp/evil", "C:\\evil", "media/../../evil"])
    await expect(
      importBundle(zipSync({ [p]: Buffer.from("x") })),
    ).rejects.toThrow();
});
it("rejects missing index and undeclared ZIP entries", async () => {
  await expect(
    importBundle(zipSync({ ["media/0x" + "a".repeat(64)]: Buffer.from("x") })),
  ).rejects.toThrow();
});
