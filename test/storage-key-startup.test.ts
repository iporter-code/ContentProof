import { it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { resolve } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { loadStorageKey } from "../packages/persistence/storage-key.js";
function dir() {
  mkdirSync("data/test-storage-startup", { recursive: true });
  return mkdtempSync(resolve("data/test-storage-startup/run-"));
}
it("pins new local and configured keys and rejects missing or wrong keys on subsequent starts", () => {
  const root = dir(),
    key = loadStorageKey(root);
  expect(loadStorageKey(root)).toEqual(key);
  expect(existsSync(resolve(root, "storage-key.id"))).toBe(true);
  renameSync(resolve(root, "storage.key"), resolve(root, "saved.key"));
  expect(() => loadStorageKey(root)).toThrow("MISSING_RECOVERY");
  expect(existsSync(resolve(root, "storage.key"))).toBe(false);
  expect(() => loadStorageKey(root, randomBytes(32).toString("hex"))).toThrow(
    "MISMATCH",
  );
  expect(loadStorageKey(root, key.toString("hex"))).toEqual(key);
});
it("never generates a replacement key for legacy database or encrypted objects", () => {
  for (const kind of ["database", "objects"]) {
    const root = dir();
    if (kind === "database") {
      const db = new DatabaseSync(resolve(root, "contentproof.sqlite"));
      db.close();
    } else {
      mkdirSync(resolve(root, "objects"));
      writeFileSync(resolve(root, "objects", "sample"), "encrypted object");
    }
    expect(() => loadStorageKey(root)).toThrow("MISSING_RECOVERY");
    expect(existsSync(resolve(root, "storage.key"))).toBe(false);
  }
});
it("authenticates legacy ciphertext before recording a key identity", () => {
  const root = dir(),
    key = randomBytes(32),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update('{"record":1}'), cipher.final()]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString(
    "base64",
  );
  const db = new DatabaseSync(resolve(root, "contentproof.sqlite"));
  db.exec("CREATE TABLE drafts(json TEXT)");
  db.prepare("INSERT INTO drafts VALUES(?)").run(sealed);
  db.close();
  const original = readFileSync(resolve(root, "contentproof.sqlite"));
  expect(() => loadStorageKey(root, randomBytes(32).toString("hex"))).toThrow(
    "MISMATCH",
  );
  expect(existsSync(resolve(root, "storage-key.id"))).toBe(false);
  expect(loadStorageKey(root, key.toString("hex"))).toEqual(key);
  expect(readFileSync(resolve(root, "contentproof.sqlite"))).toEqual(original);
});
