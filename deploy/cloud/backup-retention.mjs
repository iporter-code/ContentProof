import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Dry-run by default. Only complete timestamp-named backups are candidates.
export function pruneBackups(
  root,
  { days = 30, minCopies = 7, apply = false, now = Date.now() } = {},
) {
  if (
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > 36500 ||
    !Number.isSafeInteger(minCopies) ||
    minCopies < 1 ||
    minCopies > 100000 ||
    !Number.isFinite(now)
  )
    throw Error("INVALID_BACKUP_RETENTION_POLICY");
  const base = realpathSync(resolve(root));
  const completed = readdirSync(base, { withFileTypes: true })
    .flatMap((entry) => {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !/^\d{8}T\d{6}Z$/.test(entry.name)
      )
        return [];
      const name = entry.name,
        stamp = Date.parse(
          `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T${name.slice(9, 11)}:${name.slice(11, 13)}:${name.slice(13, 15)}Z`,
        );
      if (
        !Number.isFinite(stamp) ||
        new Date(stamp).toISOString().slice(0, 19).replace(/[-:]/g, "") +
          "Z" !==
          name
      )
        return [];
      const path = resolve(base, name),
        header = resolve(path, "backup.json"),
        manifest = resolve(path, "manifest.enc");
      if (!existsSync(header) || !existsSync(manifest)) return [];
      if (
        ![header, manifest].every((p) => {
          const s = lstatSync(p);
          return s.isFile() && !s.isSymbolicLink();
        })
      )
        return [];
      try {
        if (lstatSync(header).size > 4096) return [];
        const value = JSON.parse(readFileSync(header, "utf8"));
        if (
          value.version !== 1 ||
          !/^[a-f0-9]{32}$/.test(value.salt) ||
          lstatSync(manifest).size < 28
        )
          return [];
      } catch {
        return [];
      }
      return [{ name, path, stamp }];
    })
    .sort((a, b) => b.stamp - a.stamp);
  const eligible = completed
    .slice(minCopies)
    .filter((row) => row.stamp < now - days * 86400000);
  if (apply)
    for (const row of eligible) {
      // Recheck the resolved target immediately before recursive removal.
      const target = realpathSync(row.path),
        s = lstatSync(row.path);
      if (
        target !== row.path ||
        !target.startsWith(base + sep) ||
        s.isSymbolicLink() ||
        !s.isDirectory()
      )
        throw Error("UNSAFE_BACKUP_RETENTION_TARGET");
      rmSync(target, { recursive: true });
    }
  return {
    apply,
    completeBackups: completed.length,
    minimumCopies: minCopies,
    retentionDays: days,
    candidates: eligible.map((row) => row.name),
    removed: apply ? eligible.length : 0,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify(
      pruneBackups(process.argv[2], {
        days: Number(process.env.BACKUP_RETENTION_DAYS ?? 30),
        minCopies: Number(process.env.BACKUP_MIN_COPIES ?? 7),
        apply: process.env.BACKUP_PRUNE === "true",
      }),
    ),
  );
