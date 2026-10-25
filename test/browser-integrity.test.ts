import { it, expect, vi, afterEach } from "vitest";
import {
  fileDigest,
  verifyFile,
  reviewedTypedData,
  boundedAsset,
  grantExpiry,
  MAX_LOCAL_BYTES,
} from "../apps/web/src/integrity.js";
import { uploadVerified, signAndAnchor } from "../apps/web/src/api.js";
import { makeFull } from "./helpers.js";
import * as wallet from "../apps/web/src/wallet.js";
import * as consentStore from "../apps/web/src/consent-store.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("browser SHA256 matches a fixed vector and rejects changed bytes/lengths and oversized files", async () => {
  const blob = new Blob(["abc"]),
    digest =
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  expect(await fileDigest(blob)).toBe(digest);
  await verifyFile(blob, digest, 3);
  await expect(verifyFile(new Blob(["abd"]), digest, 3)).rejects.toThrow(
    "摘要",
  );
  await expect(verifyFile(blob, digest, 2)).rejects.toThrow();
  await expect(
    fileDigest(new Blob([new Uint8Array(MAX_LOCAL_BYTES + 1)])),
  ).rejects.toThrow("20MB");
});
it("browser bounds chunked downloads independently of Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(10));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(boundedAsset(new Response(stream), 3)).rejects.toThrow("超过");
  expect(cancelled).toBe(true);
  expect((await boundedAsset(new Response("abc"), 3)).size).toBe(3);
});
it("browser constructs signing types locally and binds them to the reviewed core", async () => {
  const m = await makeFull(),
    input = {
      core: m.core,
      domain: m.domain,
      typedData: { primaryType: "Unreviewed" },
    };
  const t = reviewedTypedData(input);
  expect(t.primaryType).toBe("Claim");
  expect(t.message.assetDigest).toBe(m.core.assetDigest);
  expect(() =>
    reviewedTypedData({ ...input, core: { ...m.core, parentCount: 2 } }),
  ).toThrow();
  expect(() =>
    reviewedTypedData({
      ...input,
      domain: { ...m.domain, verifyingContract: "wrong" },
    }),
  ).toThrow();
});
it("upload receipt must match the browser's original file hash", async () => {
  const items = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => items.get(k) ?? null,
  });
  vi.stubGlobal("fetch", async (_path: string, opts: any) => {
    expect(opts.body.get("expectedDigest")).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    return new Response(
      JSON.stringify({ data: { digest: "0xwrong", size: 3 } }),
    );
  });
  await expect(uploadVerified(new File(["abc"], "test.png"))).rejects.toThrow(
    "回执",
  );
});
it("mismatched signing bytes stop before consent and signature submission", async () => {
  const m = await makeFull(),
    paths: string[] = [];
  vi.spyOn(wallet, "signingAddress").mockReturnValue(
    m.core.issuer as `0x${string}`,
  );
  const intent = {
    issuer: m.core.issuer,
    keyEpoch: m.core.keyEpoch,
    domain: m.domain,
    operation: m.core.operation,
    assetDigest: m.core.assetDigest,
    mediaType: m.core.mediaType,
    byteLength: m.core.byteLength,
    engineDigest: m.core.engineDigest,
    fields: Object.fromEntries(m.privateFields.map((f) => [f.path, f.value])),
    parents: [],
  };
  vi.stubGlobal("sessionStorage", {
    setItem: vi.fn(),
    getItem: (k: string) =>
      k.startsWith("cp-signing-intent:") ? JSON.stringify(intent) : "token",
  });
  const consent = vi
    .spyOn(consentStore, "requestConsent")
    .mockResolvedValue(true);
  vi.stubGlobal("fetch", async (path: string) => {
    paths.push(path);
    return path.endsWith("/prepare")
      ? new Response(
          JSON.stringify({
            data: {
              core: m.core,
              domain: m.domain,
              fields: m.privateFields,
              parents: [],
            },
          }),
        )
      : new Response("different");
  });
  await expect(signAndAnchor("draft")).rejects.toThrow();
  expect(consent).not.toHaveBeenCalled();
  expect(paths.some((p) => p.endsWith("/content"))).toBe(true);
  expect(paths.some((p) => p.endsWith("/signatures"))).toBe(false);
});
it("expiry conversion refuses invalid or past dates rather than silently granting permanent access", () => {
  expect(grantExpiry("")).toBeNull();
  expect(() => grantExpiry("invalid")).toThrow();
  expect(() => grantExpiry("2000-01-01T00:00")).toThrow();
});
