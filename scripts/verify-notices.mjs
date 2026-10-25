import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const npm = JSON.parse(readFileSync("docs/LICENSE_INVENTORY.json", "utf8"));
const provenance = JSON.parse(
  readFileSync("docs/LICENSE_SOURCES.json", "utf8"),
);
const gitHash = (b) =>
  createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
function checked(record) {
  assert(
    /^licenses\/[A-Za-z0-9_.@/-]+$/.test(record.path) &&
      !record.path.includes(".."),
    "UNSAFE_NOTICE_EVIDENCE_PATH",
  );
  const bytes = readFileSync("docs/" + record.path);
  assert.equal(hash(bytes), record.sha256, "NOTICE_EVIDENCE_HASH_MISMATCH");
  if (record.gitBlob)
    assert.equal(gitHash(bytes), record.gitBlob, "NOTICE_GIT_BLOB_MISMATCH");
  return bytes;
}
let evidenceCount = 0;
for (const record of [...provenance.sources, ...provenance.unresolved]) {
  if (record.path) checked(record);
  for (const item of record.evidence ?? []) {
    const proof = JSON.parse(checked(item).toString("utf8"));
    assert.equal(proof.name, record.name);
    assert.equal(proof.version, record.version);
    assert.equal(proof.published.gitHead, proof.commit);
    for (const file of proof.files)
      assert.equal(gitHash(Buffer.from(file.content)), file.gitBlob);
    if (record.sourceKind === "canonical-versioned-license") {
      assert.equal(
        record.url,
        "https://www.mozilla.org/media/MPL/2.0/index.txt",
      );
      assert.equal(proof.published.license, "MPL-2.0");
      const pkg = proof.files.find((f) => /(?:^|\/)package.json$/.test(f.path));
      assert(pkg, "MISSING_LICENSE_DECLARATION");
      const meta = JSON.parse(pkg.content);
      assert.equal(meta.name, record.name);
      assert.equal(meta.version, record.version);
      assert.equal(meta.license, "MPL-2.0");
    }
    if (record.sourceKind === "identical-published-source") {
      assert.equal(proof.licenseAddition.commit, record.commit);
      const files = proof.licenseAddition.matchingFiles;
      assert(files.some((f) => f.path === "package.json"));
      assert(files.some((f) => f.path === "index.js"));
      for (const file of files)
        assert.equal(file.publishedBlob, file.licensedBlob);
    }
    evidenceCount++;
  }
}
for (const candidate of provenance.candidates ?? []) {
  checked(candidate);
  if (candidate.historicalAuthor) checked(candidate.historicalAuthor);
  assert(
    !provenance.sources.some(
      (s) => s.name === candidate.name && s.version === candidate.version,
    ),
    "UNRESOLVED_CANDIDATE_COUNTED_AS_COMPLETE",
  );
}
for (const component of npm.components) {
  for (const path of component.texts) {
    assert(
      /^licenses\/[A-Za-z0-9_.@/-]+$/.test(path) && !path.includes(".."),
      "UNSAFE_NOTICE_PATH",
    );
    readFileSync("docs/" + path);
  }
  for (const source of component.sources ?? []) {
    const target =
      source.path ??
      component.texts.find((p) =>
        source.kind
          ? p.endsWith("embedded-" + source.file)
          : p.includes("/upstream/"),
      );
    assert(target && component.texts.includes(target));
    assert.equal(hash(readFileSync("docs/" + target)), source.sha256);
  }
}
assert.deepEqual(
  [...new Set(npm.missingText)].sort(),
  provenance.unresolved.map((p) => `${p.name}@${p.version}`).sort(),
  "LICENSE_GAPS_AND_PROVENANCE_DISAGREE",
);
const image = JSON.parse(readFileSync("docs/IMAGE_INVENTORY.json", "utf8"));
let verified = 0;
for (const notice of [
  ...image.packages.map((p) => p.notice).filter(Boolean),
  ...image.extras,
]) {
  assert(/^image-licenses\/[A-Za-z0-9_.+-]+$/.test(notice.path));
  assert.equal(hash(readFileSync("docs/" + notice.path)), notice.sha256);
  verified++;
}
assert.deepEqual(
  npm.missingText,
  npm.components
    .filter((p) => !p.texts.length)
    .map((p) => `${p.name}@${p.version}`),
);
console.log(
  `${npm.components.length} npm component notice references, ${evidenceCount} applicability evidence records and ${verified} image notice hashes verified; ${npm.missingText.length} explicit gaps remain.`,
);
