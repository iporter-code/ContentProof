import headers from "../../configs/browser-security.json" with { type: "json" };

export const browserSecurityHeaders: Readonly<Record<string, string>> = headers;
