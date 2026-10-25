import { isIP } from "node:net";

export function trustedProxies(
  value = process.env.TRUSTED_PROXIES,
): string[] | false {
  if (!value?.trim()) return false;
  const entries = value.split(",").map((s) => s.trim());
  if (
    entries.some((entry) => {
      const [address, prefix, extra] = entry.split("/");
      const version = isIP(address);
      return (
        !version ||
        extra !== undefined ||
        (prefix !== undefined &&
          (!/^\d+$/.test(prefix) ||
            Number(prefix) > (version === 4 ? 32 : 128)))
      );
    })
  )
    throw Error("INVALID_TRUSTED_PROXIES");
  return entries;
}
