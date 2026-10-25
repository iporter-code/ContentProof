import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const npm = JSON.parse(readFileSync("docs/LICENSE_INVENTORY.json", "utf8"));
for (const component of npm.components) {
  for (const path of component.texts) {
    assert(
      /^licenses\/[A-Za-z0-9_.@/-]+$/.test(path) && !path.includes(".."),
      "UNSAFE_NOTICE_PATH",
    );
    readFileSync("docs/" + path);
  }
  for (const source of component.sources ?? []) {
    const target = component.texts.find((p) =>
      source.kind
        ? p.endsWith("embedded-" + source.file)
        : p.includes("/upstream/"),
    );
    assert(target);
    assert.equal(hash(readFileSync("docs/" + target)), source.sha256);
  }
}
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
  `${npm.components.length} npm component notice references and ${verified} image notice hashes verified; ${npm.missingText.length} explicit gaps remain.`,
);
