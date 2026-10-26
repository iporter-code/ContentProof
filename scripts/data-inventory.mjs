import { lstat, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import policy from "../configs/data-retention.json" with { type: "json" };

// Reads metadata only. Never follows junctions, reads file contents or removes data.
const root = resolve("data"),
  directories = [];
for (const name of await readdir(root)) {
  const summary = {
    directory: `data/${name}`,
    bytes: 0,
    files: 0,
    skippedLinks: 0,
    policy: policy.directories[name] ?? policy.default,
  };
  const pending = [join(root, name)];
  while (pending.length) {
    const path = pending.pop();
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      summary.skippedLinks++;
      continue;
    }
    if (info.isDirectory()) {
      for (const child of await readdir(path)) pending.push(join(path, child));
    } else if (info.isFile()) {
      summary.bytes += info.size;
      summary.files++;
    }
  }
  directories.push(summary);
}
directories.sort((a, b) => b.bytes - a.bytes);
console.log(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      mode: policy.mode,
      totalBytes: directories.reduce((n, d) => n + d.bytes, 0),
      gitProtection: "data/ is ignored; Git does not back up these files",
      directories,
    },
    null,
    2,
  ),
);
