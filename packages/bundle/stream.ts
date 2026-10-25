import { Zip, ZipPassThrough } from "fflate";
import type { Writable } from "node:stream";
import { once } from "node:events";
import { jcs } from "../protocol/index.js";
export interface StreamEntry {
  path: string;
  size: number;
  read: () => Uint8Array;
}
export async function writeBundle(
  target: string,
  entries: StreamEntry[],
  output: Writable,
  checkpoint: (progress: number) => void,
) {
  const index = jcs({
      protocol: "contentproof-bundle/1",
      target,
      entries: entries.map((e) => e.path).sort(),
    }),
    rows = [
      ...entries,
      { path: "bundle.json", size: index.length, read: () => index },
    ];
  const names = new Set<string>();
  let payload = 0,
    upperBound = 22;
  for (const e of rows) {
    if (
      !/^(bundle\.json|manifests\/0x[0-9a-f]{64}\.json|media\/0x[0-9a-f]{64})$/.test(
        e.path,
      ) ||
      names.has(e.path)
    )
      throw Error("INVALID_STREAM_ENTRY");
    names.add(e.path);
    if (e.size > 32 * 1024 * 1024) throw Error("BUNDLE_ENTRY_LIMIT");
    payload += e.size;
    upperBound += e.size + 30 + 46 + 16 + 2 * Buffer.byteLength(e.path);
  }
  if (
    rows.length > 3000 ||
    payload > 128 * 1024 * 1024 ||
    upperBound > 128 * 1024 * 1024
  )
    throw Error("BUNDLE_SIZE_LIMIT");
  let wait: Promise<unknown> | undefined, failed: Error | undefined;
  const zip = new Zip((error, chunk) => {
    if (error) {
      failed = error;
      return;
    }
    if (!output.write(chunk)) wait = once(output, "drain");
  });
  let done = 0;
  for (const entry of rows) {
    checkpoint(Math.floor((done / rows.length) * 99));
    const content = entry.read();
    if (content.length !== entry.size) throw Error("ENTRY_SIZE_CHANGED");
    const file = new ZipPassThrough(entry.path);
    zip.add(file);
    for (let offset = 0; offset < content.length; offset += 65536) {
      if (failed) throw failed;
      file.push(
        content.subarray(offset, offset + 65536),
        offset + 65536 >= content.length,
      );
      if (wait) {
        await wait;
        wait = undefined;
      }
      checkpoint(Math.floor((done / rows.length) * 99));
      await new Promise<void>((r) => setImmediate(r));
    }
    if (!content.length) file.push(new Uint8Array(), true);
    done++;
  }
  zip.end();
  if (wait) await wait;
  if (failed) throw failed;
  const finished = once(output, "finish");
  output.end();
  await finished;
}
