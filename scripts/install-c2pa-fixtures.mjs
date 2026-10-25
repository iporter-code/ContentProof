import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
const dir = "data/tools/c2pa-fixtures",
  path = dir + "/video.mp4";
const gitBlob = "a0c24886cc71a89d8b6fc8378b44cb6998dbffd9";
const sha256 =
  "e5acfbfbb0db93b1551520f2f692630dabd507555adc9386aa9595acf261d8c9";
const source = `https://api.github.com/repos/contentauth/c2pa-rs/git/blobs/${gitBlob}`;
mkdirSync(dir, { recursive: true });
let bytes;
if (existsSync(path)) bytes = readFileSync(path);
else {
  const response = await fetch(source, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error("C2PA_TEST_FIXTURE_DOWNLOAD_FAILED");
  const json = await response.json();
  if (json.size !== 797909 || json.encoding !== "base64")
    throw Error("C2PA_TEST_FIXTURE_METADATA_INVALID");
  bytes = Buffer.from(json.content, "base64");
}
if (createHash("sha256").update(bytes).digest("hex") !== sha256)
  throw Error("C2PA_TEST_FIXTURE_HASH_MISMATCH");
if (!existsSync(path)) writeFileSync(path, bytes, { flag: "wx" });
writeFileSync(
  dir + "/provenance.json",
  JSON.stringify(
    {
      source,
      gitBlob,
      sha256,
      bytes: bytes.length,
      purpose:
        "Official SDK test fixture; verification tests only; excluded from release.",
    },
    null,
    2,
  ),
);
console.log(
  "Verified official MP4 test fixture; runtime-only, excluded from release.",
);
