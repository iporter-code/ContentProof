import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
const input = process.argv[2],
  output = process.argv[3],
  trace = process.argv[4];
if (!input || !output)
  throw Error("Use audit.json output.json [trace-directory]");
const bytes = readFileSync(input),
  audit = JSON.parse(bytes),
  loaded = new Set();
if (trace && existsSync(trace)) {
  for (const file of readdirSync(trace).filter((f) => /^\d+\.jsonl$/.test(f)))
    for (const line of readFileSync(resolve(trace, file), "utf8")
      .split("\n")
      .filter(Boolean))
      loaded.add(JSON.parse(line).path.split(sep).join("/"));
}
const rows = Object.entries(audit.vulnerabilities).map(([name, finding]) => {
  const nodes = finding.nodes ?? [],
    observed = nodes.filter((node) =>
      [...loaded].some((file) =>
        file.startsWith(resolve(node).split(sep).join("/") + "/"),
      ),
    );
  const bundled = nodes.some(
    (node) =>
      node === "node_modules/ganache" ||
      node.startsWith("node_modules/ganache/"),
  );
  return {
    name,
    severity: finding.severity,
    nodes,
    observedExternalModulePaths: observed,
    classification: bundled
      ? "bundled-runtime-review-required"
      : "dependency-review-required",
    advisories: finding.via
      .filter((v) => typeof v === "object")
      .map((v) => ({ url: v.url, title: v.title, affectedRange: v.range })),
    disposition: bundled
      ? "Ganache webpack bundles may embed additional copies. Missing external-module observations do not establish non-reachability. Do not override bundled cryptography or migrate an existing chain automatically."
      : "Review exact caller and compatible patched version.",
  };
});
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(
  output,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      scope:
        "Installed production audit and opt-in CommonJS observations during synthetic actual-chain integration. Does not cover every ESM import, bundled function or attacker input.",
      auditSha256: createHash("sha256").update(bytes).digest("hex"),
      summary: audit.metadata.vulnerabilities,
      observedCommonJsFiles: loaded.size,
      rows,
    },
    null,
    2,
  ),
);
console.log(
  `${rows.length} dependency findings classified; no unobserved code declared safe.`,
);
