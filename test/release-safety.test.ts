import { it, expect } from "vitest";
import { resolve } from "node:path";
import {
  assertPublicReleaseFile,
  assertNoConfiguredSecret,
} from "../scripts/release-safety.js";
it("excludes configured credential and key-envelope paths regardless of extension", () => {
  const token = resolve("private-token.txt"),
    envelope = resolve("configs/storage.envelope.json"),
    env = { VAULT_TOKEN_FILE: token, STORAGE_KEY_VAULT_TRANSIT_FILE: envelope };
  expect(() => assertPublicReleaseFile(token, env)).toThrow("SECRET_FILE");
  expect(() => assertPublicReleaseFile(envelope, env)).toThrow("SECRET_FILE");
  expect(() =>
    assertPublicReleaseFile(envelope + ".backup-abcdef", env),
  ).toThrow("SECRET_FILE");
  expect(() => assertPublicReleaseFile("docs/VAULT.md", env)).not.toThrow();
});
it("blocks plaintext configured keys even when the text changes hex casing", () => {
  const secret = "abcdef12".repeat(8);
  expect(() =>
    assertNoConfiguredSecret(
      JSON.stringify({ key: "0x" + secret.toUpperCase() }),
      { STORAGE_KEY: secret },
    ),
  ).toThrow("SECRET_CONTENT");
  expect(() =>
    assertNoConfiguredSecret("public instructions", { STORAGE_KEY: secret }),
  ).not.toThrow();
});
it("rejects configured tokens without placing their values in diagnostics", () => {
  const token = "synthetic-only-token-for-validation";
  expect(() =>
    assertNoConfiguredSecret("token=" + token, { VAULT_TOKEN: token }),
  ).toThrow(/^FORBIDDEN_RELEASE_SECRET_CONTENT$/);
});
