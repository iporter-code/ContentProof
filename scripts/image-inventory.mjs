import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
if (process.platform !== "linux")
  throw Error("RUN_INSIDE_PRODUCTION_LINUX_IMAGE");
const sharp = createRequire("/app/package.json")("sharp");
const out = "/tmp/contentproof-image-inventory";
mkdirSync(out + "/licenses", { recursive: true });
const checksum = (b) => createHash("sha256").update(b).digest("hex");
const raw = execFileSync(
  "dpkg-query",
  ["-W", "-f=${binary:Package}\t${Version}\t${source:Package}\n"],
  { encoding: "utf8", maxBuffer: 8000000 },
);
const packages = [];
for (const line of raw.trim().split("\n")) {
  const [name, version, source] = line.split("\t");
  const paths = [
    `/usr/share/doc/${name}/copyright`,
    `/usr/share/doc/${name.split(":")[0]}/copyright`,
  ];
  const path = paths.find((p) => existsSync(p));
  let notice = null;
  if (path) {
    const bytes = readFileSync(path),
      target = `licenses/${name.replace(/[^A-Za-z0-9._+-]/g, "_")}-copyright`;
    writeFileSync(out + "/" + target, bytes);
    notice = {
      path: target,
      sha256: checksum(bytes),
      licenseLabels: [
        ...new Set(
          [...bytes.toString("utf8").matchAll(/^License:\s*(.+)$/gm)].map(
            (m) => m[1],
          ),
        ),
      ],
    };
  }
  packages.push({ name, version, source, notice });
}
const extras = [];
for (const [name, path] of [
  ["node", "/usr/local/LICENSE"],
  ["sharp", "/app/node_modules/sharp/LICENSE"],
  ["libvips", "/app/node_modules/@img/sharp-libvips-linux-x64/LICENSE"],
]) {
  if (!existsSync(path)) continue;
  const target = `licenses/${name}-LICENSE`,
    bytes = readFileSync(path);
  copyFileSync(path, out + "/" + target);
  extras.push({ name, path: target, sha256: checksum(bytes) });
}
// npm 10 sbom validates absent development packages even with --omit=dev in
// this pruned image. Inventory the manifests actually shipped instead of
// claiming that a lockfile-only list represents the installed filesystem.
const components = [];
function installed(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = folder + "/" + entry.name;
    if (entry.name.startsWith("@")) {
      installed(path);
      continue;
    }
    if (!existsSync(path + "/package.json")) continue;
    const bytes = readFileSync(path + "/package.json"),
      pkg = JSON.parse(bytes);
    if (!pkg.name || !pkg.version) continue;
    components.push({
      type: "library",
      name: pkg.name,
      version: pkg.version,
      "bom-ref": path.slice(5),
      purl:
        "pkg:npm/" +
        pkg.name.split("/").map(encodeURIComponent).join("/") +
        "@" +
        encodeURIComponent(pkg.version),
      licenses:
        typeof pkg.license === "string"
          ? [{ license: { name: pkg.license } }]
          : [],
      properties: [
        { name: "installedPath", value: path.slice(5) },
        { name: "manifestSHA256", value: checksum(bytes) },
      ],
    });
    if (existsSync(path + "/node_modules")) installed(path + "/node_modules");
  }
}
installed("/app/node_modules");
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: "urn:uuid:" + randomUUID(),
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [
      {
        vendor: "ContentProof",
        name: "installed-image-inventory",
        version: "1.0.0",
      },
    ],
  },
  components,
};
writeFileSync(out + "/SBOM.linux.cdx.json", JSON.stringify(sbom, null, 2));
const report = {
  date: new Date().toISOString(),
  scope:
    "Exact installed Linux production image package and copyright-file collection, plus Node and sharp/libvips notices. Inventory only; not legal review, source-offer fulfillment or proof of compliance.",
  node: process.version,
  os: readFileSync("/etc/os-release", "utf8"),
  nativeVersions: sharp.versions,
  packages,
  missingCopyright: packages.filter((p) => !p.notice).map((p) => p.name),
  extras,
  npmComponents: components.length,
  npmScope:
    "All package manifests physically present after npm prune, including bundled/extraneous files. Relationships are not inferred; this is not a lockfile dependency graph.",
};
writeFileSync(out + "/image-inventory.json", JSON.stringify(report, null, 2));
console.log(
  `${packages.length} OS packages, ${packages.filter((p) => p.notice).length} copyright files, ${report.npmComponents} production npm components; native versions recorded.`,
);
