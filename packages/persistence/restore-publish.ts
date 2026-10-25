import { existsSync, lstatSync, renameSync } from "node:fs";
import { resolve } from "node:path";
/** Publish a verified restore without replacing a concurrently created target.
 * Bounded retries handle transient sharing violations; the stage is retained
 * when access remains denied. No permission changes or copy/delete fallback. */
export async function publishRestore(stage: string, destination: string) {
  stage = resolve(stage);
  destination = resolve(destination);
  const prefix = `${destination}.restore-`;
  if (
    !stage.startsWith(prefix) ||
    !/^[a-f0-9]{16}$/.test(stage.slice(prefix.length))
  )
    throw Error("UNSAFE_RESTORE_STAGE");
  for (let attempt = 0; ; attempt++) {
    if (existsSync(destination)) throw Error("RESTORE_REQUIRES_NEW_DIRECTORY");
    const stat = lstatSync(stage);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw Error("UNSAFE_RESTORE_STAGE");
    try {
      renameSync(stage, destination);
      return;
    } catch (error) {
      if (
        !["EPERM", "EACCES", "EBUSY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        ) ||
        attempt >= 5
      )
        throw error;
      await new Promise((done) => setTimeout(done, 50 * (attempt + 1)));
    }
  }
}
