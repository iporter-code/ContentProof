import { readFileSync, realpathSync, statSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ProcessJobs } from "./process-jobs.js";
import { mediaPool } from "./resources.js";
import { z } from "zod";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^0x[0-9a-f]{64}$/),
  checksum = z.string().regex(/^[0-9a-f]{64}$/);
const safeRelative = z
  .string()
  .max(1024)
  .refine(
    (s) =>
      s.length > 0 &&
      !s.includes("\\") &&
      !s.startsWith("/") &&
      !s
        .split("/")
        .some((p) => !p || p === "." || p === ".." || p.includes(":")),
  );
const catalogSchema = z.strictObject({
  version: z.literal(1),
  engines: z
    .array(
      z.strictObject({
        engineDigest: digest,
        directory: safeRelative,
        descriptorSha256: checksum,
      }),
    )
    .max(16),
});
const descriptorSchema = z.strictObject({
  version: z.literal(1),
  engineDigest: digest,
  platform: z.string(),
  arch: z.string(),
  worker: safeRelative,
  versions: z.record(z.string(), z.string()),
  files: z.record(safeRelative, checksum),
});
function inside(root: string, name: string) {
  const path = realpathSync(resolve(root, name));
  if (!path.startsWith(root + sep)) throw Error("MEDIA_ARCHIVE_UNSAFE_PATH");
  return path;
}
function limited(path: string, limit: number) {
  if (statSync(path).size > limit) throw Error("MEDIA_ARCHIVE_LIMIT");
  return readFileSync(path);
}
export function archivedWorker(
  engineDigest: string,
  catalogFile = process.env.CP_MEDIA_ENGINES_FILE,
): URL | undefined {
  if (!catalogFile) return;
  const catalogPath = realpathSync(catalogFile),
    root = realpathSync(resolve(catalogPath, ".."));
  const catalog = catalogSchema.parse(
    JSON.parse(limited(catalogPath, 65536).toString("utf8")),
  );
  const matching = catalog.engines.filter(
    (e) => e.engineDigest === engineDigest,
  );
  if (!matching.length) return;
  if (matching.length !== 1) throw Error("MEDIA_ARCHIVE_AMBIGUOUS");
  const entry = matching[0],
    directory = inside(root, entry.directory),
    bytes = limited(inside(directory, "engine.json"), 1024 * 1024);
  if (hash(bytes) !== entry.descriptorSha256)
    throw Error("MEDIA_ARCHIVE_INTEGRITY_FAILED");
  const descriptor = descriptorSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    descriptor.engineDigest !== engineDigest ||
    descriptor.platform !== process.platform ||
    descriptor.arch !== process.arch
  )
    throw Error("MEDIA_ARCHIVE_PLATFORM_MISMATCH");
  if (
    !Object.hasOwn(descriptor.files, descriptor.worker) ||
    Object.keys(descriptor.files).length > 3000
  )
    throw Error("MEDIA_ARCHIVE_INVALID_DESCRIPTOR");
  let count = 0,
    total = 0;
  function inventory(folder: string, prefix = "") {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error("MEDIA_ARCHIVE_UNSAFE_PATH");
      const name = prefix + entry.name,
        path = inside(directory, name);
      if (entry.isDirectory()) inventory(path, name + "/");
      else {
        if (
          ++count > 3001 ||
          (total += statSync(path).size) > 512 * 1024 * 1024
        )
          throw Error("MEDIA_ARCHIVE_LIMIT");
        if (name !== "engine.json" && !Object.hasOwn(descriptor.files, name))
          throw Error("MEDIA_ARCHIVE_INTEGRITY_FAILED");
      }
    }
  }
  inventory(directory);
  for (const [name, sum] of Object.entries(descriptor.files))
    if (hash(limited(inside(directory, name), 128 * 1024 * 1024)) !== sum)
      throw Error("MEDIA_ARCHIVE_INTEGRITY_FAILED");
  return pathToFileURL(inside(directory, descriptor.worker));
}
export async function executeArchived(
  engineDigest: string,
  operation: string,
  inputs: Uint8Array[],
  params: object,
): Promise<Buffer | undefined> {
  const worker = archivedWorker(engineDigest);
  if (!worker) return;
  const jobs = new ProcessJobs(worker, mediaPool);
  try {
    return Buffer.from(
      await jobs.run<Buffer>({ method: "execute", operation, inputs, params }),
    );
  } finally {
    jobs.close();
  }
}
