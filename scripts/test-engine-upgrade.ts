import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  prepare,
  typedData,
  disclose,
  claimId,
  hashBytes,
  salt,
  ZERO,
  verify,
  type Manifest,
  type PrivateManifest,
  type Core,
} from "../packages/protocol/index.js";
import { engineDigest, execute, inspect } from "../packages/media/index.js";
import { reproduce, stopMediaWorkers } from "../packages/media/isolated.js";
import { exportBundle, importBundle } from "../packages/bundle/index.js";
const root = resolve("data/dependency-upgrade-2026-10-25"),
  file = resolve(root, "historical-media.zip");
mkdirSync(root, { recursive: true });
if (process.argv[2] === "capture") {
  const account = privateKeyToAccount(generatePrivateKey()),
    manifests = new Map<string, Manifest>(),
    files = new Map<string, Uint8Array>();
  let sequence = 0;
  const domain = {
    name: "ContentProof",
    version: "1",
    chainId: 31337,
    verifyingContract: "0x0000000000000000000000000000000000001234",
  } as const;
  async function signed(
    bytes: Uint8Array,
    operation: Core["operation"],
    parents: PrivateManifest[] = [],
    params?: object,
  ) {
    const meta = await inspect(bytes),
      p = prepare(
        {
          protocol: "contentproof/1",
          assetDigest: meta.digest,
          mediaType: meta.mediaType,
          byteLength: meta.size,
          issuer: account.address,
          keyEpoch: "1",
          nonce: String(sequence++),
          deadline: "2000000000",
          operation,
          engineDigest: parents.length ? engineDigest : ZERO,
        },
        [
          { path: "title", value: operation, salt: salt() },
          ...(params
            ? [{ path: "operation.params", value: params, salt: salt() }]
            : []),
        ],
        parents.map((m, i) => ({
          claimId: claimId(m),
          assetDigest: m.core.assetDigest as `0x${string}`,
          role: `input-${i}`,
          salt: salt(),
        })),
      );
    const m: PrivateManifest = {
      core: p.core,
      domain,
      signature: await account.signTypedData(typedData(p.core, domain)),
      privateFields: p.fields,
      privateParents: p.parents,
      disclosure: { fields: [], parents: [], fieldCommitments: [] },
    };
    m.disclosure = disclose(m).disclosure;
    manifests.set(claimId(m), disclose(m));
    files.set(meta.digest, bytes);
    return m;
  }
  const png = await sharp({
      create: { width: 64, height: 48, channels: 4, background: "#357b91" },
    })
      .png()
      .toBuffer(),
    jpeg = await sharp(png).jpeg({ quality: 87 }).toBuffer();
  const a = await signed(png, "import"),
    b = await signed(jpeg, "import");
  const cropParams = { left: 2, top: 3, width: 8, height: 8 },
    resizeParams = { width: 32, height: 24 },
    rotateParams = { angle: 90 },
    composeParams = { left: 1, top: 1 };
  const crop = await signed(
    await execute("crop", [jpeg], cropParams),
    "crop",
    [b],
    cropParams,
  );
  const resize = await signed(
    await execute("resize", [png], resizeParams),
    "resize",
    [a],
    resizeParams,
  );
  const rotate = await signed(
    await execute(
      "rotate",
      [files.get(resize.core.assetDigest)!],
      rotateParams,
    ),
    "rotate",
    [resize],
    rotateParams,
  );
  const final = await signed(
    await execute(
      "compose",
      [files.get(rotate.core.assetDigest)!, files.get(crop.core.assetDigest)!],
      composeParams,
    ),
    "compose",
    [rotate, crop],
    composeParams,
  );
  writeFileSync(
    file,
    exportBundle({ target: claimId(final), manifests, files }),
    { flag: "wx" },
  );
  writeFileSync(
    resolve(root, "historical-media.json"),
    JSON.stringify(
      {
        engineDigest,
        versions: sharp.versions,
        nodes: manifests.size,
        zipSha256: hashBytes(readFileSync(file)),
      },
      null,
      2,
    ),
  );
  console.log(
    "Captured historical PNG/JPEG graph with all four real image operations.",
  );
} else {
  const bundle = await importBundle(readFileSync(file));
  process.env.CP_MEDIA_ENGINES_FILE = resolve(
    "data/media-engines/catalog.json",
  );
  try {
    const report = await verify(bundle.target, {
      ...bundle,
      reproduce,
      observe: async () => ({ anchor: "confirmed", identity: "active" }),
    });
    assert.equal(report.outcome, "pass", JSON.stringify(report));
    assert.equal(report.graph.nodes, 6);
    assert.equal(report.checks.transformation, "reproduced");
    writeFileSync(
      resolve(root, "historical-media-verification.json"),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          passed: true,
          scope:
            "Actual historical media/signatures/reproduction; chain observation is a test stub",
          currentEngineDigest: engineDigest,
          report,
        },
        null,
        2,
      ),
    );
    console.log(
      "Historical signed media graph reproduces through the pinned archive.",
    );
  } finally {
    stopMediaWorkers();
  }
}
