import { it, expect, vi, afterEach } from "vitest";
import {
  createVault,
  lockWallet,
  vaults,
  unlockVault,
  signingAddress,
} from "../apps/web/src/wallet.js";
import {
  createSigningDraft,
  signAndAnchor,
  confirmSigningNetwork,
} from "../apps/web/src/api.js";
import { makeFull } from "./helpers.js";
import { claimId, prepare, signer } from "../packages/protocol/index.js";
import { requestConsent } from "../apps/web/src/consent-store.js";
vi.mock("../apps/web/src/consent-store.js", () => ({
  requestConsent: vi.fn(),
}));
const storage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
    removeItem: (k: string) => map.delete(k),
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
  };
};
afterEach(() => {
  lockWallet();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  vi.stubGlobal("window", { dispatchEvent: () => true });
  const consent = vi.mocked(requestConsent).mockReset().mockResolvedValue(true);
  const vault = await createVault(
    "synthetic test",
    "synthetic-only-passphrase",
  );
  const full = await makeFull();
  full.core.issuer = vault.address;
  const fields = Object.fromEntries(
    full.privateFields.map((f) => [f.path, f.value]),
  );
  let tamper = false,
    submitted = 0;
  vi.stubGlobal("fetch", async (path: string, options: any) => {
    let data: any;
    if (path === "/v1/chain/status")
      data = {
        chainId: full.domain.chainId,
        provenance: full.domain.verifyingContract,
      };
    else if (path === "/v1/profile")
      data = { address: vault.address, profile: { epoch: "1" } };
    else if (path.endsWith("/import"))
      data = {
        id: "draft",
        assetDigest: full.core.assetDigest,
        engineDigest: full.core.engineDigest,
      };
    else if (path.endsWith("/prepare")) {
      const p = prepare(
        full.core,
        tamper
          ? full.privateFields.map((f) => ({ ...f, value: "substituted" }))
          : full.privateFields,
        [],
      );
      data = {
        core: p.core,
        domain: full.domain,
        fields: p.fields,
        parents: p.parents,
      };
    } else if (path.endsWith("/content"))
      return new Response("test-image-bytes");
    else if (path.endsWith("/signatures")) {
      submitted++;
      const signature = JSON.parse(options.body).signature;
      expect((await signer({ ...full, signature })).toLowerCase()).toBe(
        vault.address.toLowerCase(),
      );
      data = { id: claimId(full) };
    } else if (path.endsWith("/anchor")) data = { jobId: "job" };
    else data = { state: "confirmed" };
    return Response.json({ data });
  });
  const source = {
    digest: full.core.assetDigest,
    size: full.core.byteLength,
    mediaType: full.core.mediaType,
  };
  return {
    full,
    vault,
    consent,
    source,
    fields,
    tamper: () => {
      tamper = true;
    },
    submitted: () => submitted,
  };
}
it("client creates a local intent, signs matching content and checks the returned claim ID", async () => {
  const s = await setup();
  const d = await createSigningDraft(
    { operation: "import", assetDigest: s.source.digest, fields: s.fields },
    [s.source],
  );
  expect(await signAndAnchor(d.id)).toBe(claimId(s.full));
  expect(s.submitted()).toBe(1);
  expect(s.consent).toHaveBeenCalledTimes(2);
  expect(sessionStorage.getItem("cp-pending-draft")).toBeNull();
});
it("a valid substituted server commitment is rejected before consent or signature submission", async () => {
  const s = await setup();
  const d = await createSigningDraft(
    { operation: "import", assetDigest: s.source.digest, fields: s.fields },
    [s.source],
  );
  s.tamper();
  await expect(signAndAnchor(d.id)).rejects.toThrow("本地草稿");
  expect(s.submitted()).toBe(0);
  expect(s.consent).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem("cp-pending-draft")).toBe(d.id);
});
it("pinned networks cannot change silently and explicit replacement preserves local identities", async () => {
  const s = await setup();
  const network = {
    chainId: 31337,
    provenance: s.full.domain.verifyingContract,
  };
  await confirmSigningNetwork(network);
  await expect(
    confirmSigningNetwork({ ...network, chainId: 1 }),
  ).rejects.toThrow("网络已改变");
  await confirmSigningNetwork({ ...network, chainId: 1 }, true);
  const preserved = vaults().find((v) => v.address === s.vault.address);
  expect(preserved).toBeDefined();
  await unlockVault(preserved!, "synthetic-only-passphrase");
  expect(signingAddress()).toBe(s.vault.address);
});
it("explicit cancellation retains the draft and sends no signature; retry needs new consent", async () => {
  const s = await setup();
  const d = await createSigningDraft(
    { operation: "import", assetDigest: s.source.digest, fields: s.fields },
    [s.source],
  );
  s.consent.mockResolvedValueOnce(false);
  await expect(signAndAnchor(d.id)).rejects.toThrow("已取消");
  expect(s.submitted()).toBe(0);
  expect(sessionStorage.getItem("cp-pending-draft")).toBe(d.id);
  expect(await signAndAnchor(d.id)).toBe(claimId(s.full));
  expect(s.submitted()).toBe(1);
  expect(s.consent).toHaveBeenCalledTimes(3);
});
