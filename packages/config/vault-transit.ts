import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { vaultConnection, vaultRequest } from "./vault-client.js";
export const transitEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  provider: z.literal("vault-transit"),
  address: z.string().url(),
  namespace: z.string(),
  mount: z.string().regex(/^[A-Za-z0-9_-]+$/),
  key: z.string().regex(/^[A-Za-z0-9_-]+$/),
  ciphertext: z
    .string()
    .regex(/^vault:v[1-9][0-9]{0,8}:[A-Za-z0-9+/]+={0,2}$/)
    .max(4096),
});
export type TransitEnvelope = z.infer<typeof transitEnvelopeSchema>;
export function readTransitEnvelope(file: string): TransitEnvelope {
  try {
    const s = statSync(file);
    if (!s.isFile() || s.size > 8192) throw Error();
    return transitEnvelopeSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw Error("INVALID_VAULT_TRANSIT_ENVELOPE");
  }
}
export async function decryptTransitEnvelope(
  envelope: TransitEnvelope,
  env: NodeJS.ProcessEnv,
) {
  envelope = transitEnvelopeSchema.parse(envelope);
  const connection = vaultConnection(env);
  if (
    envelope.address !== connection.url.href ||
    envelope.namespace !== connection.namespace
  )
    throw Error("VAULT_TRANSIT_PROVIDER_MISMATCH");
  const response = await vaultRequest(
    `/v1/${envelope.mount}/decrypt/${envelope.key}`,
    env,
    { ciphertext: envelope.ciphertext },
  );
  const value = response?.data?.plaintext;
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw Error("VAULT_TRANSIT_INVALID_DATA_KEY");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value)
    throw Error("VAULT_TRANSIT_INVALID_DATA_KEY");
  return key;
}
