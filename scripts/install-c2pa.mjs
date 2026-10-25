import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, dirname, sep, basename, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { unzipSync } from "fflate";
const configuration = JSON.parse(
  readFileSync("configs/native-tools.json", "utf8"),
).c2patool;
const target = `${process.platform}-${process.arch}`,
  source = configuration[target];
if (!source) throw Error("C2PA_BINARY_PLATFORM_UNSUPPORTED");
const root = resolve("data/tools", `c2patool-${configuration.version}`, target),
  out = resolve(root, "binary"),
  receipt = resolve(root, "provenance.json");
const sha = (b) => createHash("sha256").update(b).digest("hex");
if (existsSync(receipt)) {
  const old = JSON.parse(readFileSync(receipt, "utf8"));
  if (
    old.archiveSha256 !== source.sha256 ||
    old.version !== configuration.version ||
    sha(readFileSync(resolve(root, old.binary))) !== source.binarySha256
  )
    throw Error("C2PA_EXISTING_INSTALLATION_CHANGED");
  console.log(
    `Verified existing c2patool ${configuration.version} installation.`,
  );
} else {
  if (existsSync(out))
    throw Error("C2PA_INSTALLATION_DIRECTORY_EXISTS_WITHOUT_RECEIPT");
  mkdirSync(root, { recursive: true });
  const archiveOption = process.argv.indexOf("--archive");
  let bytes;
  if (archiveOption >= 0) {
    if (
      !process.argv[archiveOption + 1] ||
      statSync(process.argv[archiveOption + 1]).size > 64 * 1024 * 1024
    )
      throw Error("C2PA_LOCAL_ARCHIVE_INVALID");
    bytes = readFileSync(process.argv[archiveOption + 1]);
  } else {
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw Error(`C2PA_OFFICIAL_DOWNLOAD_${response.status}`);
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > 64 * 1024 * 1024)
        throw Error("C2PA_OFFICIAL_DOWNLOAD_LIMIT");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (bytes.length > 64 * 1024 * 1024 || sha(bytes) !== source.sha256)
    throw Error("C2PA_OFFICIAL_ARCHIVE_HASH_MISMATCH");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  if (source.url.endsWith(".zip")) {
    const files = unzipSync(bytes);
    let total = 0;
    for (const [name, content] of Object.entries(files)) {
      const file = resolve(out, name);
      if (
        name.includes("\\") ||
        !file.startsWith(out + sep) ||
        name.split("/").includes("..")
      )
        throw Error("C2PA_UNSAFE_OFFICIAL_ARCHIVE_PATH");
      total += content.length;
      if (total > 128 * 1024 * 1024) throw Error("C2PA_ARCHIVE_LIMIT");
      if (name.endsWith("/")) {
        mkdirSync(file, { recursive: true });
        continue;
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, { flag: "wx", mode: 0o700 });
    }
  } else {
    const archive = resolve(root, "official.tar.gz");
    writeFileSync(archive, bytes, { flag: "wx" });
    const listed = spawnSync("tar", ["-tzf", archive], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (listed.status !== 0) throw Error("C2PA_ARCHIVE_LIST_FAILED");
    for (const name of listed.stdout.trim().split("\n")) {
      if (
        name.startsWith("/") ||
        name.includes("\\") ||
        name.split("/").includes("..")
      )
        throw Error("C2PA_UNSAFE_OFFICIAL_ARCHIVE_PATH");
    }
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", out], {
      windowsHide: true,
    });
    if (extracted.status !== 0) throw Error("C2PA_ARCHIVE_EXTRACTION_FAILED");
  }
  const binaries = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const file = resolve(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (
        basename(file) ===
        (process.platform === "win32" ? "c2patool.exe" : "c2patool")
      )
        binaries.push(file);
    }
  }
  walk(out);
  if (binaries.length !== 1) throw Error("C2PA_OFFICIAL_BINARY_MISSING");
  const binarySha256 = sha(readFileSync(binaries[0]));
  if (binarySha256 !== source.binarySha256)
    throw Error("C2PA_OFFICIAL_BINARY_HASH_MISMATCH");
  writeFileSync(
    receipt,
    JSON.stringify(
      {
        version: configuration.version,
        source: source.url,
        commit: configuration.commit,
        archiveSha256: source.sha256,
        binary: relative(root, binaries[0]),
        binarySha256,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `Verified and installed official c2patool ${configuration.version} for ${target}; runtime files excluded from release.`,
  );
}
