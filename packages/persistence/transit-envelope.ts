import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { vaultConnection, vaultRequest } from "../config/vault-client.js";
import {
  readTransitEnvelope,
  transitEnvelopeSchema,
  decryptTransitEnvelope,
} from "../config/vault-transit.js";
import { noLinks, durable } from "./external-rotation.js";
import { acquireLock } from "./locks.js";
export async function provisionTransitEnvelope(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  file = resolve(file);
  noLinks(file);
  if (existsSync(file)) throw Error("TRANSIT_ENVELOPE_REQUIRES_NEW_FILE");
  const connection = vaultConnection(env),
    mount = env.VAULT_TRANSIT_MOUNT ?? "transit",
    key = env.VAULT_TRANSIT_KEY ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(mount) || !/^[A-Za-z0-9_-]+$/.test(key))
    throw Error("INVALID_VAULT_TRANSIT_KEY");
  const release = acquireLock(`${file}.envelope-control`, "maintenance");
  try {
    const info = await vaultRequest(`/v1/${mount}/keys/${key}`, env);
    if (
      info?.data?.type !== "aes256-gcm96" ||
      info.data.derived !== false ||
      info.data.exportable !== false
    )
      throw Error("VAULT_TRANSIT_UNSUPPORTED_KEY_CONFIGURATION");
    const result = await vaultRequest(
      `/v1/${mount}/datakey/wrapped/${key}`,
      env,
      { bits: 256 },
    );
    const envelope = transitEnvelopeSchema.parse({
      version: 1,
      provider: "vault-transit",
      address: connection.url.href,
      namespace: connection.namespace,
      mount,
      key,
      ciphertext: result?.data?.ciphertext,
    });
    durable(file, JSON.stringify(envelope));
    return {
      provider: envelope.provider,
      created: true,
      cipherVersion: Number(envelope.ciphertext.split(":")[1].slice(1)),
    };
  } finally {
    release();
  }
}
export async function rewrapTransitEnvelope(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  file = resolve(file);
  noLinks(file);
  const release = acquireLock(`${file}.envelope-control`, "maintenance");
  try {
    const bytes = readFileSync(file),
      old = readTransitEnvelope(file),
      before = await decryptTransitEnvelope(old, env);
    const result = await vaultRequest(
      `/v1/${old.mount}/rewrap/${old.key}`,
      env,
      { ciphertext: old.ciphertext },
    );
    const next = transitEnvelopeSchema.parse({
      ...old,
      ciphertext: result?.data?.ciphertext,
    });
    const fromVersion = Number(old.ciphertext.split(":")[1].slice(1)),
      toVersion = Number(next.ciphertext.split(":")[1].slice(1));
    if (toVersion <= fromVersion)
      throw Error("VAULT_TRANSIT_NEW_KEK_VERSION_REQUIRED");
    if (!before.equals(await decryptTransitEnvelope(next, env)))
      throw Error("VAULT_TRANSIT_REWRAP_CHANGED_DATA_KEY");
    noLinks(file);
    if (!readFileSync(file).equals(bytes))
      throw Error("VAULT_TRANSIT_ENVELOPE_CHANGED_OUTSIDE_REWRAP");
    const tag = randomBytes(8).toString("hex"),
      backup = `${file}.backup-${tag}`,
      stage = `${file}.rewrap-${tag}`;
    noLinks(backup);
    noLinks(stage);
    durable(backup, bytes.toString("utf8"));
    durable(stage, JSON.stringify(next));
    renameSync(stage, file);
    return {
      provider: next.provider,
      rewrapped: true,
      fromVersion,
      toVersion,
      backup,
    };
  } finally {
    release();
  }
}
