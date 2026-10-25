import { ProcessJobs } from "./process-jobs.js";
import { mediaPool } from "./resources.js";
import { executeArchived } from "./archives.js";
import { engineDigest, MAX_BYTES, type Params } from "./index.js";
import { hashBytes, ZERO, type Manifest } from "../protocol/index.js";
export { engineDigest, type Params };
const jobs = new ProcessJobs(
  new URL(
    import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
    import.meta.url,
  ),
  mediaPool,
);
export const stopMediaWorkers = () => jobs.close();
const unavailable = (error: unknown) =>
  error instanceof Error &&
  (/^MEDIA_WORKER_/.test(error.message) ||
    error.message === "MEDIA_RESOURCE_LIMIT");
export async function inspect(bytes: Uint8Array) {
  if (bytes.length < 1 || bytes.length > MAX_BYTES)
    throw Error("MEDIA_SIZE_LIMIT");
  return jobs.run<Awaited<ReturnType<typeof import("./index.js").inspect>>>({
    method: "inspect",
    bytes,
  });
}
export async function execute(
  operation: string,
  inputs: Uint8Array[],
  params: Params,
): Promise<Buffer> {
  if (
    inputs.length < 1 ||
    inputs.length > 2 ||
    inputs.some((b) => b.length < 1 || b.length > MAX_BYTES)
  )
    throw Error("MEDIA_INPUT_LIMIT");
  const output = await jobs.run<Buffer>({
    method: "execute",
    operation,
    inputs,
    params,
  });
  if (output.length < 1 || output.length > MAX_BYTES)
    throw Error("MEDIA_SIZE_LIMIT");
  return Buffer.from(output);
}
export async function reproduce(
  m: Manifest,
  parents: Manifest[],
  files: Map<string, Uint8Array>,
): Promise<"reproduced" | "declared-only" | "unavailable" | "mismatch"> {
  if (["import", "ai-declaration"].includes(m.core.operation)) {
    if (m.core.engineDigest !== ZERO) return "mismatch";
    const bytes = files.get(m.core.assetDigest);
    if (bytes) {
      try {
        if ((await inspect(bytes)).mediaType !== m.core.mediaType)
          return "mismatch";
      } catch (error) {
        if (unavailable(error)) return "unavailable";
        return "mismatch";
      }
    }
    return "declared-only";
  }
  if (parents.length !== m.core.parentCount) return "unavailable";
  const params = m.disclosure.fields.find(
      (f) => f.path === "operation.params",
    )?.value,
    inputs = parents.map((p) => files.get(p.core.assetDigest));
  if (!params || typeof params !== "object" || inputs.some((b) => !b))
    return "unavailable";
  if (m.core.engineDigest !== engineDigest) {
    try {
      const output = await executeArchived(
        m.core.engineDigest,
        m.core.operation,
        inputs as Uint8Array[],
        params,
      );
      return output
        ? hashBytes(output) === m.core.assetDigest
          ? "reproduced"
          : "mismatch"
        : "unavailable";
    } catch {
      return "unavailable";
    }
  }
  try {
    return hashBytes(
      await execute(m.core.operation, inputs as Uint8Array[], params),
    ) === m.core.assetDigest
      ? "reproduced"
      : "mismatch";
  } catch (error) {
    return unavailable(error) ? "unavailable" : "mismatch";
  }
}
