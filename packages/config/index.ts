import { resolve } from "node:path";
export const demoMode = process.env.DEMO_MODE === "true";
export const dataPath = resolve(
  process.env.DATA_DIR ?? (demoMode ? "data" : "data/app"),
);
export const apiPort = Number(process.env.PORT ?? 3001);
export const webPort = Number(process.env.WEB_PORT ?? 5173);
export const rpcUrl =
  process.env.RPC_URL ?? `http://127.0.0.1:${process.env.CHAIN_PORT ?? 8545}`;
export const rpcUrls = [
  ...new Set([
    rpcUrl,
    ...(process.env.RPC_URLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ]),
];
if (
  rpcUrls.length > 5 ||
  rpcUrls.some((url) => !["http:", "https:"].includes(new URL(url).protocol))
)
  throw Error("INVALID_RPC_CONFIGURATION");
export const chainId = Number(process.env.CHAIN_ID ?? 31337);
export const audience =
  process.env.AUTH_AUDIENCE ?? `http://127.0.0.1:${apiPort}`;
export const origins = (
  process.env.ALLOWED_ORIGINS ??
  `http://127.0.0.1:${webPort},http://localhost:${webPort}`
).split(",");
export const confirmations = Number(process.env.CONFIRMATIONS ?? 1);
for (const n of [apiPort, webPort, chainId, confirmations])
  if (!Number.isSafeInteger(n) || n < 1) throw Error("INVALID_CONFIGURATION");
