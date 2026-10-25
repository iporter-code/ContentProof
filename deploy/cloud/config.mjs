import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export function initializeCloudConfig(path, endpoint) {
  if (isIP(endpoint) !== 4) throw Error("INVALID_PUBLIC_IPV4");
  if (existsSync(path)) {
    const content = readFileSync(path, "utf8");
    const values = Object.fromEntries(
      content
        .split(/\r?\n/)
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => {
          const index = line.indexOf("=");
          return [
            line.slice(0, index),
            line.slice(index + 1).replace(/^(['"])(.*)\1$/, "$2"),
          ];
        }),
    );
    for (const name of [
      "HOST",
      "PORT",
      "DATA_DIR",
      "AUTH_AUDIENCE",
      "ALLOWED_ORIGINS",
      "REGISTRATION_MODE",
    ])
      if (!values[name]) throw Error("EXISTING_CONFIGURATION_REQUIRES_REVIEW");
    if (
      values.DEMO_MODE !== "false" ||
      !["open", "closed"].includes(values.REGISTRATION_MODE)
    )
      throw Error("EXISTING_CONFIGURATION_REQUIRES_REVIEW");
    if (values.PORT !== "3001" || values.HOST !== "127.0.0.1")
      throw Error("CLOUD_PROXY_CONFIGURATION_REQUIRES_REVIEW");
    if (!Object.hasOwn(values, "TRUSTED_PROXIES")) {
      writeFileSync(
        path,
        content +
          (content.endsWith("\n") ? "" : "\n") +
          "TRUSTED_PROXIES=127.0.0.1/32\n",
        { mode: 0o640 },
      );
    }
    return { created: false };
  }
  writeFileSync(
    path,
    `NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=256
HOST=127.0.0.1
PORT=3001
RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
DATA_DIR=/var/lib/contentproof/app
STORAGE_KEY_FILE=/etc/contentproof/storage.key
DEMO_MODE=false
AUTH_AUDIENCE=https://${endpoint}
ALLOWED_ORIGINS=https://${endpoint}
TRUSTED_PROXIES=127.0.0.1/32
REGISTRATION_MODE=open
MEDIA_CONCURRENCY=1
MEDIA_QUEUE_LIMIT=4
CP_C2PA_INSTALL_DIR=/opt/contentproof/current/native/c2pa
`,
    { mode: 0o640, flag: "wx" },
  );
  return { created: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify(initializeCloudConfig(process.argv[2], process.argv[3])),
  );
