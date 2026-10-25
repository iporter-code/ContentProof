import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { platform } from "node:os";
import sharp from "sharp";
import { execute, engineDigest } from "../packages/media/index.js";
import { hashBytes } from "../packages/protocol/index.js";
import { dataPath } from "../packages/config/index.js";
async function image(width: number, height: number) {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[i] = (x * 7 + y * 3) % 256;
      raw[i + 1] = (x * 11 + y * 13) % 256;
      raw[i + 2] = (x * 19 + y * 5) % 256;
      raw[i + 3] = (x + y) % 3 ? 255 : 117;
    }
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}
const config = "configs/media-vectors.json";
if (process.argv.includes("--create")) {
  const a = await image(32, 24),
    b = await image(12, 8),
    cases = [
      { operation: "crop", params: { left: 3, top: 2, width: 17, height: 13 } },
      { operation: "resize", params: { width: 19, height: 17 } },
      { operation: "rotate", params: { angle: 90 } },
      { operation: "compose", params: { left: 7, top: 4 } },
    ];
  const vectors = [];
  for (const c of cases)
    vectors.push({
      ...c,
      sha256: hashBytes(
        await execute(
          c.operation,
          c.operation === "compose" ? [a, b] : [a],
          c.params,
        ),
      ),
    });
  writeFileSync(
    config,
    JSON.stringify(
      {
        version: 1,
        inputs: [a.toString("base64"), b.toString("base64")],
        vectors,
      },
      null,
      2,
    ),
  );
}
const fixture = JSON.parse(readFileSync(config, "utf8")),
  inputs = fixture.inputs.map((b: string) => Buffer.from(b, "base64")),
  results = [];
for (const vector of fixture.vectors) {
  const actual = hashBytes(
    await execute(
      vector.operation,
      vector.operation === "compose" ? inputs : [inputs[0]],
      vector.params,
    ),
  );
  if (actual !== vector.sha256)
    throw Error(`MEDIA_VECTOR_MISMATCH_${vector.operation}`);
  results.push({ operation: vector.operation, sha256: actual, passed: true });
}
mkdirSync(resolve(dataPath, "results"), { recursive: true });
writeFileSync(
  resolve(dataPath, `results/media-${platform()}.json`),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      node: process.version,
      platform: platform(),
      engineDigest,
      scope:
        "Four fixed RGBA PNG input/operation vectors only; not exhaustive codec/color-profile equivalence.",
      results,
    },
    null,
    2,
  ),
);
console.log(`${results.length} fixed media vectors passed on ${platform()}.`);
