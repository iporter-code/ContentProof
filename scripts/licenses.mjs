import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
const upstream = existsSync("docs/LICENSE_SOURCES.json")
  ? JSON.parse(readFileSync("docs/LICENSE_SOURCES.json", "utf8")).sources
  : [];
const bom = JSON.parse(
    readFileSync("docs/SBOM.cdx.json", "utf8").replace(/^\uFEFF/, ""),
  ),
  root = resolve("node_modules"),
  rows = [];
mkdirSync("docs/licenses", { recursive: true });
for (const component of bom.components ?? []) {
  const path = component.properties?.find(
      (p) => p.name === "cdx:npm:package:path",
    )?.value,
    folder = path ? resolve(path) : null;
  if (!folder || !folder.startsWith(root + sep))
    throw Error("INVALID_DEPENDENCY_PATH");
  const licenses =
    (component.licenses ?? [])
      .map((l) => l.license?.id ?? l.license?.name ?? l.expression ?? "unknown")
      .join(" OR ") || "UNKNOWN";
  const texts = [];
  if (existsSync(folder))
    for (const name of readdirSync(folder))
      if (
        /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name) &&
        statSync(resolve(folder, name)).isFile()
      ) {
        const target = `${component.name.replace(/[^A-Za-z0-9._-]/g, "_")}@${component.version}-${name}`;
        copyFileSync(resolve(folder, name), resolve("docs/licenses", target));
        texts.push(`licenses/${target}`);
      }
  const installedText = texts.length > 0;
  const sources = [];
  // Some packages put their complete original terms in a README or source
  // header rather than a standalone LICENSE. Preserve the whole original file.
  if (!installedText && existsSync(folder))
    for (const name of readdirSync(folder)) {
      if (!/^(readme(?:\.[a-z]+)?|[a-z0-9_.-]+\.js)$/i.test(name)) continue;
      const file = resolve(folder, name);
      if (!statSync(file).isFile() || statSync(file).size > 300000) continue;
      const bytes = readFileSync(file),
        content = bytes.toString("utf8");
      const complete =
        /Permission is hereby granted[\s\S]+THE SOFTWARE IS PROVIDED/i.test(
          content,
        ) ||
        /Redistribution and use[\s\S]+THIS SOFTWARE IS PROVIDED/i.test(content);
      if (!complete || !/copyright/i.test(content)) continue;
      const target = `${component.name.replace(/[^A-Za-z0-9._-]/g, "_")}@${component.version}-embedded-${name}`;
      copyFileSync(file, resolve("docs/licenses", target));
      texts.push(`licenses/${target}`);
      sources.push({
        kind: "installed original file with full embedded license",
        file: name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      break;
    }
  for (const entry of upstream.filter(
    (s) => s.name === component.name && s.version === component.version,
  )) {
    if (!/^licenses\/upstream\/[A-Za-z0-9_.@-]+$/.test(entry.path))
      throw Error("INVALID_LICENSE_SOURCE_PATH");
    const bytes = readFileSync(resolve("docs", entry.path));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw Error("LICENSE_SOURCE_HASH_MISMATCH");
    texts.push(entry.path);
    sources.push({
      path: entry.path,
      url: entry.url,
      commit: entry.commit,
      sha256: entry.sha256,
      ...(entry.sourceKind ? { sourceKind: entry.sourceKind } : {}),
      ...(entry.evidence ? { evidence: entry.evidence } : {}),
    });
  }
  rows.push({
    name: component.name,
    version: component.version,
    license: licenses,
    texts,
    installedText,
    sources,
  });
}
writeFileSync(
  "docs/LICENSE_INVENTORY.json",
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      scope:
        "Installed production npm dependency graph. Does not include every OS/image package or replace legal review.",
      components: rows,
      missingText: rows
        .filter((r) => !r.texts.length)
        .map((r) => `${r.name}@${r.version}`),
      missingInstalledText: rows
        .filter((r) => !r.installedText)
        .map((r) => `${r.name}@${r.version}`),
    },
    null,
    2,
  ),
);
console.log(
  `Inventoried ${rows.length} production packages; ${rows.filter((r) => !r.texts.length).length} lack a collected complete license text.`,
);
