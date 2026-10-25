import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
const inventory = JSON.parse(
  readFileSync("docs/LICENSE_INVENTORY.json", "utf8"),
);
const results = existsSync("docs/LICENSE_SOURCES.json")
    ? JSON.parse(readFileSync("docs/LICENSE_SOURCES.json", "utf8")).sources
    : [],
  unresolved = [];
mkdirSync("docs/licenses/upstream", { recursive: true });
const request = async (url) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "ContentProof-license-inventory" },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return null;
      const text = await r.text();
      if (text.length > 2000000) throw Error("LICENSE_RESPONSE_TOO_LARGE");
      return text;
    } catch {
      if (attempt < 2)
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
};
for (const component of inventory.components.filter((c) => !c.texts.length)) {
  const { name, version } = component;
  const registry = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
  const data = await request(registry);
  if (!data) {
    unresolved.push({ name, version, reason: "Official registry unavailable" });
    continue;
  }
  const meta = JSON.parse(data),
    repository =
      typeof meta.repository === "string"
        ? meta.repository
        : meta.repository?.url;
  const repo = repository?.match(
    /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/,
  )?.[1];
  let commit = meta.gitHead;
  if (name === "@openzeppelin/contracts" && !commit) {
    const info = await request(
      "https://api.github.com/repos/OpenZeppelin/openzeppelin-contracts/commits/v" +
        version,
    );
    if (info) commit = JSON.parse(info).sha;
  }
  if (!repo || !/^[a-f0-9]{40}$/.test(commit ?? "")) {
    unresolved.push({
      name,
      version,
      reason:
        "Exact source repository/commit unavailable in published version metadata",
    });
    continue;
  }
  let found = false;
  const listing = await request(
    `https://api.github.com/repos/${repo}/git/trees/${commit}`,
  );
  const tree = listing ? JSON.parse(listing).tree : null;
  if (!Array.isArray(tree)) {
    unresolved.push({
      name,
      version,
      repository: repo,
      commit,
      reason:
        "Exact published source tree unavailable from official repository API",
    });
    console.log(`${name}@${version}: exact source tree unavailable`);
    continue;
  }
  const candidates = tree.filter(
    (x) =>
      x.type === "blob" &&
      /^(LICENSE|LICENCE|COPYING)(?:[.-].*)?$/i.test(x.path),
  );
  for (const item of candidates) {
    const file = item.path;
    const url = `https://github.com/${repo}/blob/${commit}/${file}`;
    const blob = await request(
      `https://api.github.com/repos/${repo}/git/blobs/${item.sha}`,
    );
    if (!blob) continue;
    const content = JSON.parse(blob);
    if (content.encoding !== "base64") continue;
    const text = Buffer.from(content.content, "base64").toString("utf8");
    if (
      text.length < 100 ||
      !/(?:permission|redistribution|license|licence)/i.test(text)
    )
      continue;
    const path = `licenses/upstream/${name.replace(/[^A-Za-z0-9._-]/g, "_")}@${version}-${file.replaceAll("/", "_")}`;
    writeFileSync("docs/" + path, text);
    results.push({
      name,
      version,
      path,
      url,
      commit,
      registry,
      sha256: createHash("sha256").update(text).digest("hex"),
      source:
        "Exact published gitHead; OpenZeppelin version tag resolved to immutable commit",
    });
    found = true;
    break;
  }
  if (!found)
    unresolved.push({
      name,
      version,
      repository: repo,
      commit,
      reason: "No standalone license text at checked exact-commit paths",
    });
  console.log(
    `${name}@${version}: ${found ? "pinned upstream text saved" : "unresolved"}`,
  );
}
writeFileSync(
  "docs/LICENSE_SOURCES.json",
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      scope:
        "Text collection only, not a legal compliance opinion. Original upstream texts are preserved without alteration.",
      sources: results,
      unresolved,
    },
    null,
    2,
  ),
);
console.log(
  `${results.length} pinned upstream texts; ${unresolved.length} unresolved.`,
);
