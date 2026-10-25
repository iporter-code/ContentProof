import sharp from "sharp";
// Enforce the PNG/JPEG boundary in native decoders as well as in inspect().
// Decoder selection cannot reach unrelated vulnerable format handlers.
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({
  operation: ["VipsForeignLoadJpegBuffer", "VipsForeignLoadPngBuffer"],
});
import { mediaPool } from "./resources.js";
import { executeArchived } from "./archives.js";
sharp.cache({ memory: 32, files: 16, items: 64 });
sharp.concurrency(2);
import {
  hashBytes,
  jcs,
  ZERO,
  type Hash,
  type Manifest,
} from "../protocol/index.js";
export const MAX_BYTES = 20 * 1024 * 1024,
  MAX_PIXELS = 20_000_000;
export const engineDigest = hashBytes(
  jcs({
    engine: "contentproof-sharp/1",
    versions: sharp.versions,
    output: {
      format: "png",
      compressionLevel: 9,
      adaptiveFiltering: false,
      palette: false,
    },
    colour: "srgb",
    autoOrient: false,
  }),
);
export interface Params {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  angle?: number;
}
export async function inspect(bytes: Uint8Array) {
  if (bytes.length === 0 || bytes.length > MAX_BYTES)
    throw new Error("MEDIA_SIZE_LIMIT");
  const png = Buffer.from(bytes)
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error("PNG_JPEG_ONLY");
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(bytes, {
      limitInputPixels: MAX_PIXELS,
      failOn: "error",
    }).metadata();
  } catch (error) {
    if (error instanceof Error && /pixel limit/i.test(error.message))
      throw Error("MEDIA_DIMENSION_LIMIT");
    throw error;
  }
  if (
    !meta.width ||
    !meta.height ||
    meta.width * meta.height > MAX_PIXELS ||
    (meta.pages ?? 1) !== 1
  )
    throw new Error("MEDIA_DIMENSION_LIMIT");
  // metadata alone accepts truncated pixel streams. Decode within the pixel budget.
  await mediaPool.run(() =>
    sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "warning" })
      .timeout({ seconds: 15 })
      .raw()
      .toBuffer(),
  );
  return {
    digest: hashBytes(bytes),
    mediaType: png ? ("image/png" as const) : ("image/jpeg" as const),
    size: bytes.length,
    width: meta.width,
    height: meta.height,
  };
}
const integer = (n: unknown, min: number, max: number) => {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max)
    throw new Error("INVALID_OPERATION_PARAMETER");
  return n;
};
export async function execute(
  operation: string,
  inputs: Uint8Array[],
  params: Params,
): Promise<Buffer> {
  if (inputs.length < 1 || inputs.length > 8) throw new Error("INPUT_COUNT");
  const metas = await Promise.all(inputs.map(inspect));
  let image = sharp(inputs[0], {
    limitInputPixels: MAX_PIXELS,
    failOn: "error",
  }).toColourspace("srgb");
  if (operation === "crop") {
    const left = integer(params.left, 0, metas[0].width - 1),
      top = integer(params.top, 0, metas[0].height - 1);
    const width = integer(params.width, 1, metas[0].width - left),
      height = integer(params.height, 1, metas[0].height - top);
    image = image.extract({ left, top, width, height });
  } else if (operation === "resize") {
    const width = integer(params.width, 1, 5000),
      height = integer(params.height, 1, 5000);
    if (width * height > MAX_PIXELS) throw new Error("PIXEL_LIMIT");
    image = image.resize(width, height, { fit: "fill", kernel: "lanczos3" });
  } else if (operation === "rotate") {
    const angle = integer(params.angle, 0, 270);
    if (angle % 90) throw new Error("RIGHT_ANGLE_ONLY");
    image = image.rotate(angle);
  } else if (operation === "compose") {
    if (inputs.length !== 2) throw new Error("COMPOSE_NEEDS_TWO_INPUTS");
    const left = integer(params.left, 0, metas[0].width - 1),
      top = integer(params.top, 0, metas[0].height - 1);
    if (
      left + metas[1].width > metas[0].width ||
      top + metas[1].height > metas[0].height
    )
      throw new Error("OVERLAY_OUT_OF_BOUNDS");
    image = image.composite([
      { input: Buffer.from(inputs[1]), left, top, blend: "over" },
    ]);
  } else throw new Error("UNSUPPORTED_OPERATION");
  if (operation !== "compose" && inputs.length !== 1)
    throw new Error("ONE_INPUT_REQUIRED");
  const out = await mediaPool.run(() =>
    image
      .timeout({ seconds: 15 })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer(),
  );
  await inspect(out);
  return out;
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
        const actual = await inspect(bytes);
        if (actual.mediaType !== m.core.mediaType) return "mismatch";
      } catch {
        return "mismatch";
      }
    }
    return "declared-only";
  }
  if (parents.length !== m.core.parentCount) return "unavailable";
  const params = m.disclosure.fields.find(
    (f) => f.path === "operation.params",
  )?.value;
  if (!params || typeof params !== "object") return "unavailable";
  const inputs = parents.map((p) => files.get(p.core.assetDigest));
  if (inputs.some((p) => !p)) return "unavailable";
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
  } catch {
    return "mismatch";
  }
}
