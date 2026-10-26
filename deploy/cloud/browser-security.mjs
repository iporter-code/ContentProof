import headers from "../../configs/browser-security.json" with { type: "json" };
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function nginxSecurityHeaders() {
  return (
    Object.entries(headers)
      .map(([name, value]) => {
        if (!/^[A-Za-z][A-Za-z-]+$/.test(name) || /["\\\r\n$]/.test(value))
          throw Error("INVALID_BROWSER_SECURITY_HEADER");
        return `add_header ${name} "${value}" always;`;
      })
      .join("\n") + "\n"
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv[2]) throw Error("SECURITY_SNIPPET_PATH_REQUIRED");
  writeFileSync(resolve(process.argv[2]), nginxSecurityHeaders(), {
    mode: 0o644,
  });
}
