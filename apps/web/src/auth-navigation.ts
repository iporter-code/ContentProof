export function loginDestination(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  const origin = "https://contentproof.invalid";
  try {
    const target = new URL(value, origin);
    if (
      target.origin !== origin ||
      target.pathname.startsWith("//") ||
      target.pathname === "/login" ||
      target.pathname.startsWith("/login/")
    )
      return "/";
    return target.pathname + target.search + target.hash;
  } catch {
    return "/";
  }
}
