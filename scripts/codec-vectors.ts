import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import assert from "node:assert/strict";
import { platform } from "node:os";
import {
  execute,
  inspect,
  engineDigest,
  type Params,
} from "../packages/media/index.js";
import { hashBytes } from "../packages/protocol/index.js";
import { saveReport } from "./local-harness.js";
const path = "configs/codec-vectors.json";
const actions: { operation: string; params: Params }[] = [
  { operation: "crop", params: { left: 3, top: 2, width: 31, height: 23 } },
  { operation: "resize", params: { width: 37, height: 29 } },
  { operation: "rotate", params: { angle: 90 } },
];
if (process.argv.includes("--create")) {
  const raw = Buffer.alloc(64 * 48 * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = (i * 7) % 256;
    raw[i + 1] = Math.floor(i / 64) % 256;
    raw[i + 2] = (i * 11) % 256;
    raw[i + 3] = (i / 4) % 3 ? 255 : 88;
  }
  const image = () =>
    sharp(raw, { raw: { width: 64, height: 48, channels: 4 } });
  const inputs = [
    { name: "rgba-png", bytes: await image().png().toBuffer() },
    {
      name: "baseline-jpeg",
      bytes: await image().removeAlpha().jpeg({ quality: 90 }).toBuffer(),
    },
    {
      name: "progressive-jpeg-444",
      bytes: await image()
        .removeAlpha()
        .jpeg({ quality: 90, progressive: true, chromaSubsampling: "4:4:4" })
        .toBuffer(),
    },
    {
      name: "exif-orientation-6",
      bytes: await image()
        .removeAlpha()
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer(),
    },
    {
      name: "icc-display-p3",
      bytes: await image().removeAlpha().withIccProfile("p3").jpeg().toBuffer(),
    },
    {
      name: "cmyk-jpeg",
      bytes: await image()
        .removeAlpha()
        .toColourspace("cmyk")
        .jpeg()
        .toBuffer(),
    },
  ];
  const vectors = [];
  for (const input of inputs) {
    const outputs = [];
    for (const action of actions)
      outputs.push({
        ...action,
        sha256: hashBytes(
          await execute(action.operation, [input.bytes], action.params),
        ),
      });
    vectors.push({
      name: input.name,
      input: input.bytes.toString("base64"),
      sha256: hashBytes(input.bytes),
      outputs,
    });
  }
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        policy:
          "Use stored pixel orientation, convert edits to sRGB PNG. Exact original bytes preserved on import.",
        vectors,
      },
      null,
      2,
    ),
  );
}
const fixture = JSON.parse(readFileSync(path, "utf8")),
  results = [];
for (const vector of fixture.vectors) {
  const bytes = Buffer.from(vector.input, "base64");
  assert.equal(hashBytes(bytes), vector.sha256);
  const metadata = await inspect(bytes);
  assert.equal(metadata.width, 64);
  assert.equal(metadata.height, 48);
  for (const action of vector.outputs) {
    const output = await execute(action.operation, [bytes], action.params);
    assert.equal(
      hashBytes(output),
      action.sha256,
      `${vector.name}:${action.operation}`,
    );
    assert.equal(
      hashBytes(await execute(action.operation, [bytes], action.params)),
      action.sha256,
    );
    results.push({
      input: vector.name,
      operation: action.operation,
      sha256: action.sha256,
      passed: true,
    });
  }
}
saveReport(`codecs-${platform()}`, {
  date: new Date().toISOString(),
  passed: true,
  platform: platform(),
  versions: sharp.versions,
  engineDigest,
  scope:
    "Six fixed synthetic codecs/profile/orientation inputs and three edits, each repeated twice. Not every JPEG/ICC encoder or arbitrary profile coverage.",
  results,
});
console.log(
  `${results.length} JPEG/PNG/profile/orientation vectors passed on ${platform()}.`,
);
