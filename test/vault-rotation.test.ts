import { it, expect, vi, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
const renameFailure = vi.hoisted(() => ({ remaining: 0, attempts: 0 }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (
        String(args[1]).includes(".rollback-vault-") &&
        renameFailure.remaining > 0
      ) {
        renameFailure.remaining--;
        renameFailure.attempts++;
        throw Object.assign(Error("Synthetic Windows sharing violation"), {
          code: "EPERM",
        });
      }
      return fs.renameSync(...args);
    },
  };
});
import {
  prepareVaultRotation,
  recoverVaultRotation,
} from "../packages/persistence/vault-rotation.js";
import { acquireLock } from "../packages/persistence/locks.js";
import {
  loadConfiguredSecrets,
  readVaultReference,
} from "../packages/config/secrets.js";
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const seal = (b: Buffer, k: Buffer) => {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", k, iv),
    out = Buffer.concat([c.update(b), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), out]);
};
const open = (b: Buffer, k: Buffer) => {
  const d = createDecipheriv("aes-256-gcm", k, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
};
afterEach(() => {
  vi.unstubAllGlobals();
  renameFailure.remaining = 0;
  renameFailure.attempts = 0;
});
function fixture() {
  mkdirSync("data/test-vault-rotation", { recursive: true });
  const root = mkdtempSync(resolve("data/test-vault-rotation/run-")),
    source = resolve(root, "source"),
    ref = resolve(root, "storage.ref.json"),
    old = randomBytes(32),
    next = randomBytes(32),
    plain = Buffer.from("synthetic-image"),
    name = hash(plain);
  mkdirSync(resolve(source, "objects"), { recursive: true });
  mkdirSync(resolve(source, "exports"));
  writeFileSync(
    ref,
    JSON.stringify({ version: 1, path: "contentproof/storage", keyVersion: 1 }),
  );
  writeFileSync(resolve(root, "token"), "synthetic-token");
  writeFileSync(resolve(source, "storage-key.id"), hash(old));
  writeFileSync(
    resolve(source, "objects", name),
    Buffer.concat([Buffer.from("CP-OBJECT-1\0"), seal(plain, old)]),
  );
  writeFileSync(
    resolve(source, "exports/aa.cpe"),
    seal(Buffer.from("old-export"), old),
  );
  const db = new DatabaseSync(resolve(source, "contentproof.sqlite"));
  db.exec(
    "CREATE TABLE claims(id TEXT PRIMARY KEY,encrypted TEXT);CREATE TABLE drafts(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE exports(id TEXT PRIMARY KEY,input TEXT,state TEXT,lease TEXT,leaseUntil INTEGER)",
  );
  db.prepare("INSERT INTO claims VALUES(?,?)").run(
    "claim",
    seal(Buffer.from("private claim"), old).toString("base64"),
  );
  db.prepare("INSERT INTO drafts VALUES(?,?)").run(
    "draft",
    seal(Buffer.from("private draft"), old).toString("base64"),
  );
  db.prepare("INSERT INTO exports VALUES(?,?,?,NULL,0)").run(
    "export",
    seal(Buffer.from("private export input"), old).toString("base64"),
    "completed",
  );
  db.close();
  const keys = new Map<number, Buffer>([
    [1, old],
    [2, next],
    [3, randomBytes(32)],
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      const version = Number(new URL(String(url)).searchParams.get("version")),
        key = keys.get(version);
      return new Response(
        JSON.stringify(
          key
            ? {
                data: {
                  data: { key: key.toString("hex") },
                  metadata: { version, destroyed: false, deletion_time: "" },
                },
              }
            : { errors: ["not found"] },
        ),
        { status: key ? 200 : 404 },
      );
    }),
  );
  const env: NodeJS.ProcessEnv = {
    VAULT_ADDR: "https://vault.example",
    VAULT_TOKEN_FILE: resolve(root, "token"),
    STORAGE_KEY_VAULT_REF_FILE: ref,
  };
  return { root, source, ref, old, next, name, plain, keys, env };
}
type Fixture = ReturnType<typeof fixture>;
it("Vault recovery survives transient directory sharing violations", async () => {
  const f = fixture();
  await prepareVaultRotation(f.source, 2, f.env);
  renameFailure.remaining = 2;
  expect(
    (await recoverVaultRotation(f.source, "commit", f.env)).activeVersion,
  ).toBe(2);
  expect(renameFailure.attempts).toBe(2);
  readable(f, f.next);
});
it("persistent directory denial keeps the journal, reference and old readable data", async () => {
  const f = fixture();
  await prepareVaultRotation(f.source, 2, f.env);
  renameFailure.remaining = 100;
  await expect(
    recoverVaultRotation(f.source, "commit", f.env),
  ).rejects.toMatchObject({ code: "EPERM" });
  expect(renameFailure.attempts).toBe(6);
  expect(existsSync(`${f.source}.key-rotation.json`)).toBe(true);
  expect(readVaultReference(f.ref).keyVersion).toBe(1);
  readable(f, f.old);
});
function readable(f: Fixture, key: Buffer) {
  expect(readFileSync(resolve(f.source, "storage-key.id"), "utf8")).toBe(
    hash(key),
  );
  const db = new DatabaseSync(resolve(f.source, "contentproof.sqlite"));
  try {
    expect(
      open(
        Buffer.from(
          (db.prepare("SELECT encrypted FROM claims").get() as any).encrypted,
          "base64",
        ),
        key,
      ).toString(),
    ).toBe("private claim");
    expect(
      open(
        Buffer.from(
          (db.prepare("SELECT json FROM drafts").get() as any).json,
          "base64",
        ),
        key,
      ).toString(),
    ).toBe("private draft");
    expect(
      open(
        Buffer.from(
          (db.prepare("SELECT input FROM exports").get() as any).input,
          "base64",
        ),
        key,
      ).toString(),
    ).toBe("private export input");
  } finally {
    db.close();
  }
  const object = readFileSync(resolve(f.source, "objects", f.name));
  expect(
    open(object.subarray(Buffer.byteLength("CP-OBJECT-1\0")), key),
  ).toEqual(f.plain);
  expect(existsSync(resolve(f.source, "storage.key"))).toBe(false);
}
async function phase(
  f: Fixture,
  state: "prepared" | "data-gap" | "data-next" | "reference-next",
) {
  const j = JSON.parse(readFileSync(`${f.source}.key-rotation.json`, "utf8"));
  expect(j.source).toBe(f.source);
  expect(j.tag).toMatch(/^[a-f0-9]{16}$/);
  const rollback = `${f.source}.rollback-vault-${j.tag}`,
    stage = `${f.source}.rotate-vault-${j.tag}`;
  for (const path of [f.source, rollback, stage])
    expect(resolve(path).startsWith(f.root + sep)).toBe(true);
  // Only the synthetic crash-boundary setup retries transient Windows handles.
  // A real recovery assertion is never retried or converted into a pass.
  const move = async (from: string, to: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(from, to);
        return;
      } catch (error) {
        if (
          process.platform !== "win32" ||
          !["EPERM", "EACCES", "EBUSY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          ) ||
          attempt >= 8
        )
          throw error;
        await delay(50 * (attempt + 1));
      }
    }
  };
  if (state !== "prepared") await move(f.source, rollback);
  if (state === "data-next" || state === "reference-next")
    await move(stage, f.source);
  if (state === "reference-next") await move(`${f.ref}.rotate-${j.tag}`, f.ref);
  return j;
}
it.each(["prepared", "data-gap", "data-next", "reference-next"] as const)(
  "commits from the persisted %s boundary",
  async (state) => {
    const f = fixture();
    await prepareVaultRotation(f.source, 2, f.env);
    const j = await phase(f, state);
    const report = await recoverVaultRotation(f.source, "commit", f.env);
    expect(report.activeVersion).toBe(2);
    readable(f, f.next);
    expect(readVaultReference(f.ref).keyVersion).toBe(2);
    expect(existsSync(`${f.source}.key-rotation.json`)).toBe(false);
    const db = new DatabaseSync(resolve(f.source, "contentproof.sqlite"));
    expect((db.prepare("SELECT state FROM exports").get() as any).state).toBe(
      "expired",
    );
    db.close();
    expect(existsSync(resolve(f.source, "exports/aa.cpe"))).toBe(false);
    const metadata = readFileSync(report.referenceBackup, "utf8");
    for (const k of [f.old, f.next]) {
      expect(metadata).not.toContain(k.toString("hex"));
      expect(JSON.stringify(j)).not.toContain(k.toString("hex"));
    }
    expect(JSON.stringify(j)).not.toContain("synthetic-token");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([, options]) => options?.method === "GET"),
    ).toBe(true);
  },
);
it.each(["prepared", "data-gap", "data-next", "reference-next"] as const)(
  "rolls back from %s without the next key version",
  async (state) => {
    const f = fixture();
    await prepareVaultRotation(f.source, 2, f.env);
    await phase(f, state);
    f.keys.delete(2);
    expect(
      (await recoverVaultRotation(f.source, "rollback", f.env)).activeVersion,
    ).toBe(1);
    readable(f, f.old);
    expect(readVaultReference(f.ref).keyVersion).toBe(1);
    expect(existsSync(`${f.source}.key-rotation.json`)).toBe(false);
  },
);
it("pending recovery blocks both API and chain; active API blocks preparation", async () => {
  const f = fixture(),
    release = acquireLock(f.source, "api");
  await expect(prepareVaultRotation(f.source, 2, f.env)).rejects.toThrow(
    "DATA_DIRECTORY_BUSY",
  );
  release();
  await prepareVaultRotation(f.source, 2, f.env);
  for (const mode of ["api", "chain"] as const)
    expect(() => acquireLock(f.source, mode)).toThrow(
      "KEY_ROTATION_RECOVERY_REQUIRED",
    );
  await recoverVaultRotation(f.source, "rollback", f.env);
});
it("an unrelated reference, provider change or key mutation leaves recovery blocked", async () => {
  const f = fixture();
  await prepareVaultRotation(f.source, 2, f.env);
  writeFileSync(
    f.ref,
    JSON.stringify({ version: 1, path: "contentproof/storage", keyVersion: 3 }),
  );
  await expect(recoverVaultRotation(f.source, "commit", f.env)).rejects.toThrow(
    "REFERENCE_CHANGED_OUTSIDE",
  );
  writeFileSync(
    f.ref,
    JSON.stringify({ version: 1, path: "contentproof/storage", keyVersion: 1 }),
  );
  await expect(
    recoverVaultRotation(f.source, "commit", {
      ...f.env,
      VAULT_ADDR: "https://other.example",
    }),
  ).rejects.toThrow("PROVIDER_CHANGED");
  f.keys.set(2, randomBytes(32));
  await expect(recoverVaultRotation(f.source, "commit", f.env)).rejects.toThrow(
    "NEXT_KEY_CHANGED",
  );
  expect(existsSync(`${f.source}.key-rotation.json`)).toBe(true);
  readable(f, f.old);
});
it("remote unavailability does not publish metadata or alter canonical data", async () => {
  const f = fixture();
  await prepareVaultRotation(f.source, 2, f.env);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("private remote body", { status: 503 })),
  );
  await expect(recoverVaultRotation(f.source, "commit", f.env)).rejects.toThrow(
    /^VAULT_HTTP_503$/,
  );
  expect(readVaultReference(f.ref).keyVersion).toBe(1);
  expect(existsSync(`${f.source}.key-rotation.json`)).toBe(true);
  readable(f, f.old);
});
it("forbids repeated/decreasing versions and identical key material", async () => {
  const f = fixture();
  await expect(prepareVaultRotation(f.source, 1, f.env)).rejects.toThrow(
    "VERSION_MUST_INCREASE",
  );
  f.keys.set(2, f.old);
  await expect(prepareVaultRotation(f.source, 2, f.env)).rejects.toThrow(
    "DISTINCT_KEYS",
  );
  expect(existsSync(`${f.source}.key-rotation.json`)).toBe(false);
  readable(f, f.old);
});
it("an unknown storage marker prevents moving data or clearing the journal", async () => {
  const f = fixture();
  await prepareVaultRotation(f.source, 2, f.env);
  writeFileSync(resolve(f.source, "storage-key.id"), "ff".repeat(32));
  await expect(recoverVaultRotation(f.source, "commit", f.env)).rejects.toThrow(
    "DATA_STATE_UNKNOWN",
  );
  expect(existsSync(`${f.source}.key-rotation.json`)).toBe(true);
  expect(readVaultReference(f.ref).keyVersion).toBe(1);
});
it("metadata reference provider selects the exact pin and rejects competing selectors", async () => {
  const f = fixture(),
    env = { ...f.env };
  await loadConfiguredSecrets(env);
  expect(env.STORAGE_KEY).toBe(f.old.toString("hex"));
  expect(env.STORAGE_KEY_VAULT_REF_FILE).toBeUndefined();
  await expect(
    loadConfiguredSecrets({ ...f.env, STORAGE_KEY_VAULT_VERSION: "2" }),
  ).rejects.toThrow("AMBIGUOUS");
  writeFileSync(
    f.ref,
    JSON.stringify({ version: 1, path: "../escape", keyVersion: 1 }),
  );
  await expect(loadConfiguredSecrets({ ...f.env })).rejects.toThrow(
    "INVALID_VAULT_REFERENCE_FILE",
  );
});
it("rechecks the reference after remote reads before moving the data", async () => {
  const f = fixture();
  await prepareVaultRotation(f.source, 2, f.env);
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: Parameters<typeof fetch>) => {
      const result = await original(...args);
      writeFileSync(
        f.ref,
        JSON.stringify({
          version: 1,
          path: "contentproof/storage",
          keyVersion: 3,
        }),
      );
      return result;
    }),
  );
  await expect(recoverVaultRotation(f.source, "commit", f.env)).rejects.toThrow(
    "REFERENCE_CHANGED_OUTSIDE",
  );
  readable(f, f.old);
  expect(existsSync(`${f.source}.key-rotation.json`)).toBe(true);
});
