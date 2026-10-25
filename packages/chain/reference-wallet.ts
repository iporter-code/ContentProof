import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey } from "viem/accounts";
export function referenceWallet(root: string, demo: boolean) {
  mkdirSync(root, { recursive: true });
  const marker = resolve(root, "chain-mode.json"),
    keyFile = resolve(root, "node.key"),
    mode = demo ? "demo" : "private";
  if (existsSync(marker)) {
    const saved = JSON.parse(readFileSync(marker, "utf8"));
    if (saved.version !== 1 || saved.mode !== mode)
      throw Error("CHAIN_MODE_MISMATCH");
  } else if (
    demo &&
    (existsSync(keyFile) || existsSync(resolve(root, "chain-db")))
  )
    throw Error("DEMO_PRIVATE_DIRECTORY_FORBIDDEN");
  if (!demo && !existsSync(keyFile) && existsSync(resolve(root, "chain-db")))
    throw Error("RELAYER_KEY_RECOVERY_REQUIRED");
  if (!existsSync(marker))
    writeFileSync(marker, JSON.stringify({ version: 1, mode }), {
      flag: "wx",
      mode: 0o600,
    });
  if (demo)
    return {
      mnemonic: "test test test test test test test test test test test junk",
      totalAccounts: 10,
      defaultBalance: 10000,
    };
  if (!existsSync(keyFile))
    writeFileSync(keyFile, generatePrivateKey(), { flag: "wx", mode: 0o600 });
  const secretKey = readFileSync(keyFile, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(secretKey))
    throw Error("INVALID_RELAYER_KEY");
  return { accounts: [{ secretKey, balance: "0x3635c9adc5dea00000" }] };
}
