import { describe, it, expect } from "vitest";
import { normalizeC2pa } from "../packages/c2pa/report.js";
import {
  c2paMedia,
  c2paSettings,
  verifyC2pa,
  C2PA_MAX_BYTES,
} from "../packages/c2pa/index.js";
const base = {
  sha256: "a".repeat(64),
  mediaType: "image/png" as const,
  policySha256: "b".repeat(64),
};
function native() {
  return {
    active_manifest: "m",
    manifests: {
      m: {
        signature_info: {
          issuer: "Synthetic",
          common_name: "Test only",
          alg: "Es256",
        },
      },
    },
    validation_state: "Trusted",
    validation_results: {
      activeManifest: {
        success: [
          { code: "claimSignature.validated" },
          { code: "assertion.dataHash.match" },
          { code: "signingCredential.trusted" },
        ],
        informational: [{ code: "signingCredential.ocsp.skipped" }],
        failure: [] as { code: string }[],
      },
    },
  };
}
describe("native C2PA outcome boundaries", () => {
  it("accepts explicit operator trust only with signature and hard binding", () => {
    expect(normalizeC2pa(native(), base)).toMatchObject({
      outcome: "pass",
      integrity: "valid",
      trust: "operator-trusted",
      revocation: "online-not-checked",
      identityAssertions: "not-checked",
    });
  });
  it("does not treat an embedded certificate as trusted", () => {
    expect(
      normalizeC2pa(native(), { ...base, policySha256: null }),
    ).toMatchObject({ outcome: "incomplete", trust: "not-configured" });
  });
  it("keeps cryptographic validity separate from untrusted signer", () => {
    const n = native();
    n.validation_state = "Valid";
    n.validation_results.activeManifest.failure.push({
      code: "signingCredential.untrusted",
    });
    expect(normalizeC2pa(n, base)).toMatchObject({
      outcome: "incomplete",
      integrity: "valid",
      trust: "untrusted",
    });
  });
  it.each([
    "assertion.dataHash.mismatch",
    "claimSignature.mismatch",
    "signingCredential.revoked",
    "assertion.action.malformed",
  ])("fails closed for %s", (code) => {
    const n = native();
    n.validation_results.activeManifest.failure.push({ code });
    expect(normalizeC2pa(n, base).outcome).toBe("fail");
  });
  it("requires active manifest and validated signature", () => {
    const n = native();
    n.validation_results.activeManifest.success =
      n.validation_results.activeManifest.success.filter(
        (x) => x.code !== "claimSignature.validated",
      );
    expect(normalizeC2pa(n, base).outcome).toBe("incomplete");
    expect(() =>
      normalizeC2pa({ ...n, active_manifest: "missing" }, base),
    ).toThrow();
  });
  it("requires actual file binding, not only assertion hashes", () => {
    const n = native();
    n.validation_results.activeManifest.success[1].code =
      "assertion.hashedURI.match";
    expect(normalizeC2pa(n, base).integrity).toBe("unknown");
  });
  it("propagates ingredient failures and legacy validation failures", () => {
    const n = native();
    expect(
      normalizeC2pa(
        {
          ...n,
          validation_results: {
            ...n.validation_results,
            ingredientDeltas: [
              {
                validationDeltas: {
                  success: [],
                  informational: [],
                  failure: [{ code: "assertion.dataHash.mismatch" }],
                },
              },
            ],
          },
        },
        base,
      ).outcome,
    ).toBe("fail");
    expect(
      normalizeC2pa(
        { ...n, validation_status: [{ code: "claimSignature.mismatch" }] },
        base,
      ).outcome,
    ).toBe("fail");
  });
  it("rejects unknown report shapes and states", () => {
    expect(() =>
      normalizeC2pa({ validation_state: "Trusted" }, base),
    ).toThrow();
    expect(() =>
      normalizeC2pa({ ...native(), validation_state: "future-state" }, base),
    ).toThrow();
  });
  it("explicitly disables remote manifests, OCSP, redirects and identity resolvers", () => {
    expect(c2paSettings()).toMatchObject({
      core: {
        decode_identity_assertions: false,
        allowed_network_hosts: [],
        allow_redirects: false,
      },
      verify: {
        remote_manifest_fetch: false,
        ocsp_fetch: false,
        verify_trust: true,
        verify_timestamp_trust: true,
      },
      trust: { anchors: [] },
    });
  });
  it("uses content bytes rather than a client extension", () => {
    expect(
      c2paMedia(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])).mediaType,
    ).toBe("image/png");
    expect(() => c2paMedia(Buffer.from("malicious.exe"))).toThrow(
      "UNSUPPORTED",
    );
  });
  it("rejects over-limit input before starting the verifier", async () => {
    await expect(
      verifyC2pa(new Uint8Array(C2PA_MAX_BYTES + 1)),
    ).rejects.toThrow("SIZE_LIMIT");
  });
});
