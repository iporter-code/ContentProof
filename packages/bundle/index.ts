import { zipSync } from "fflate";
import yauzl from "yauzl";
import {
  claimId,
  jcs,
  manifestSchema,
  strictJSON,
  type Manifest,
} from "../protocol/index.js";
export interface Bundle {
  target: string;
  manifests: Map<string, Manifest>;
  files: Map<string, Uint8Array>;
}
const MAX_TOTAL = 128 * 1024 * 1024,
  MAX_ENTRIES = 3000;
function safePath(path: string) {
  if (
    !/^(bundle\.json|manifests\/0x[0-9a-f]{64}\.json|media\/0x[0-9a-f]{64})$/.test(
      path,
    )
  )
    throw new Error("UNSAFE_ZIP_PATH");
}
export function exportBundle(bundle: Bundle): Uint8Array {
  if (!bundle.manifests.has(bundle.target)) throw new Error("MISSING_TARGET");
  const entries: Record<string, Uint8Array> = {};
  for (const [id, m] of bundle.manifests) {
    if (claimId(m) !== id) throw new Error("CLAIM_ID_MISMATCH");
    entries[`manifests/${id}.json`] = jcs(m);
  }
  for (const [digest, bytes] of bundle.files)
    entries[`media/${digest}`] = bytes;
  const list = Object.keys(entries).sort();
  entries["bundle.json"] = jcs({
    protocol: "contentproof-bundle/1",
    target: bundle.target,
    entries: list,
  });
  if (
    Object.values(entries).reduce((n, b) => n + b.length, 0) > MAX_TOTAL ||
    Object.keys(entries).length > MAX_ENTRIES
  )
    throw new Error("BUNDLE_LIMIT");
  if (Object.values(entries).some((b) => b.length > 32 * 1024 * 1024))
    throw Error("BUNDLE_ENTRY_LIMIT");
  const zip = zipSync(entries, { level: 0 });
  if (zip.length > MAX_TOTAL) throw Error("BUNDLE_SIZE_LIMIT");
  return zip;
}
export async function importBundle(bytes: Uint8Array): Promise<Bundle> {
  if (bytes.length > MAX_TOTAL) throw new Error("BUNDLE_SIZE_LIMIT");
  const files = await new Promise<Map<string, Buffer>>((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, validateEntrySizes: true },
      (err, zip) => {
        if (err || !zip) {
          reject(err ?? new Error("INVALID_ZIP"));
          return;
        }
        const result = new Map<string, Buffer>();
        let total = 0,
          count = 0,
          failed = false;
        const fail = (e: unknown) => {
          if (!failed) {
            failed = true;
            zip.close();
            reject(e);
          }
        };
        zip.on("error", fail);
        zip.on("entry", (entry) => {
          try {
            safePath(entry.fileName);
            if (result.has(entry.fileName))
              throw new Error("DUPLICATE_ZIP_ENTRY");
            if (
              ++count > MAX_ENTRIES ||
              (total += entry.uncompressedSize) > MAX_TOTAL ||
              entry.uncompressedSize > 32 * 1024 * 1024
            )
              throw new Error("ZIP_LIMIT");
            if (
              entry.compressedSize &&
              entry.uncompressedSize / entry.compressedSize > 1000
            )
              throw new Error("ZIP_RATIO_LIMIT");
            if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
              throw new Error("ZIP_SYMLINK");
            zip.openReadStream(entry, (error, stream) => {
              if (error || !stream) {
                fail(error);
                return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              stream.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > entry.uncompressedSize || size > 32 * 1024 * 1024) {
                  stream.destroy(new Error("ZIP_STREAM_LIMIT"));
                  return;
                }
                chunks.push(chunk);
              });
              stream.on("error", fail);
              stream.on("end", () => {
                if (failed) return;
                result.set(entry.fileName, Buffer.concat(chunks));
                zip.readEntry();
              });
            });
          } catch (e) {
            fail(e);
          }
        });
        zip.on("end", () => {
          if (!failed) resolve(result);
        });
        zip.readEntry();
      },
    );
  });
  const raw = files.get("bundle.json");
  if (!raw) throw new Error("MISSING_BUNDLE_INDEX");
  const index = strictJSON(raw.toString("utf8")) as {
    protocol: string;
    target: string;
    entries: string[];
  };
  if (
    index.protocol !== "contentproof-bundle/1" ||
    !/^0x[0-9a-f]{64}$/.test(index.target) ||
    !Array.isArray(index.entries) ||
    index.entries.length !== files.size - 1 ||
    new Set(index.entries).size !== index.entries.length
  )
    throw new Error("INVALID_BUNDLE_INDEX");
  const manifests = new Map<string, Manifest>(),
    media = new Map<string, Uint8Array>();
  for (const path of index.entries) {
    safePath(path);
    const content = files.get(path);
    if (!content || path === "bundle.json")
      throw new Error("BUNDLE_ENTRY_MISSING");
    if (path.startsWith("manifests/")) {
      const m = manifestSchema.parse(
        strictJSON(content.toString("utf8")),
      ) as Manifest;
      const id = path.slice(10, -5);
      if (claimId(m) !== id) throw new Error("CLAIM_ID_MISMATCH");
      manifests.set(id, m);
    } else media.set(path.slice(6), content);
  }
  if (!manifests.has(index.target)) throw new Error("TARGET_NOT_FOUND");
  return { target: index.target, manifests, files: media };
}
