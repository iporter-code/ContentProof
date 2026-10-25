import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
const require = createRequire(import.meta.url),
  sharp = require("sharp");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const digest =
  "0x" +
  hash(
    canonicalize({
      engine: "contentproof-sharp/1",
      versions: sharp.versions,
      output: {
        format: "png",
        compressionLevel: 9,
        adaptiveFiltering: false,
        palette: false,
      },
      colour: "srgb",
      autoOrient: false,
    }),
  );
const root = resolve(process.argv[2] ?? "data/media-engines"),
  target = resolve(
    root,
    `${process.platform}-${process.arch}-${digest.slice(2)}`,
  );
if (existsSync(target)) throw Error("MEDIA_ARCHIVE_ALREADY_EXISTS");
mkdirSync(target, { recursive: true, mode: 0o700 });
const copied = new Set();
function copyPackage(name, from, optional = false) {
  const resolver = createRequire(from);
  const folder = resolver.resolve
    .paths(name)
    ?.map((p) => resolve(p, name))
    .find((p) => existsSync(resolve(p, "package.json")));
  if (!folder) {
    if (optional) return;
    throw Error("MEDIA_ARCHIVE_DEPENDENCY_MISSING");
  }
  const meta = JSON.parse(
    readFileSync(resolve(folder, "package.json"), "utf8"),
  );
  if (copied.has(name)) return;
  copied.add(name);
  const dest = resolve(target, "node_modules", name);
  mkdirSync(dirname(dest), { recursive: true });
  // Native Linux packages contain library aliases. Freeze their actual bytes
  // instead of leaving mutable links in the archived execution environment.
  cpSync(folder, dest, {
    recursive: true,
    dereference: true,
    filter: (source) => !source.split(sep).includes(".bin"),
  });
  for (const dependency of Object.keys(meta.dependencies ?? {}))
    copyPackage(dependency, resolve(folder, "package.json"));
  for (const dependency of Object.keys(meta.optionalDependencies ?? {}))
    copyPackage(dependency, resolve(folder, "package.json"), true);
}
copyPackage("sharp", require.resolve("sharp/package.json"));
// A trusted, previously bundled worker can be supplied on production hosts
// without installing a compiler. Never take this path from an evidence bundle.
if (process.argv[3]) {
  const bytes = readFileSync(resolve(process.argv[3]));
  if (bytes.length > 8 * 1024 * 1024) throw Error("MEDIA_ARCHIVE_WORKER_LIMIT");
  writeFileSync(resolve(target, "worker.cjs"), bytes, { flag: "wx" });
} else {
  const { build } = await import("esbuild");
  await build({
    entryPoints: ["packages/media/worker.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["sharp"],
    outfile: resolve(target, "worker.cjs"),
  });
}
const files = {};
function inventory(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) throw Error("MEDIA_ARCHIVE_SYMLINK");
    if (entry.isDirectory()) inventory(p);
    else
      files[relative(target, p).split(sep).join("/")] = hash(readFileSync(p));
  }
}
inventory(target);
const descriptor = {
  version: 1,
  engineDigest: digest,
  platform: process.platform,
  arch: process.arch,
  worker: "worker.cjs",
  versions: sharp.versions,
  files,
};
writeFileSync(
  resolve(target, "engine.json"),
  JSON.stringify(descriptor, null, 2),
  { flag: "wx", mode: 0o600 },
);
const catalog = resolve(root, "catalog.json"),
  previous = existsSync(catalog)
    ? JSON.parse(readFileSync(catalog, "utf8"))
    : { version: 1, engines: [] };
previous.engines.push({
  engineDigest: digest,
  directory: relative(root, target).split(sep).join("/"),
  descriptorSha256: hash(readFileSync(resolve(target, "engine.json"))),
});
writeFileSync(catalog, JSON.stringify(previous, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    archived: true,
    engineDigest: digest,
    files: Object.keys(files).length,
    catalog: relative(process.cwd(), catalog).split(sep).join("/"),
  }),
);
