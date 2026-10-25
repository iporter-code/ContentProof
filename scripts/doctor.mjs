import { existsSync } from "node:fs";
const apiPort = process.env.PORT ?? 3001,
  webPort = process.env.WEB_PORT ?? 5173;
console.log(
  "Node",
  process.version,
  "dependencies",
  existsSync("node_modules") ? "installed" : "missing",
);
for (const url of [
  `http://127.0.0.1:${apiPort}/health/ready`,
  `http://127.0.0.1:${webPort}`,
]) {
  try {
    const r = await fetch(url);
    console.log(url, r.status);
  } catch {
    console.log(url, "offline");
  }
}
console.log(
  "Deployment",
  existsSync(
    `${process.env.DATA_DIR ?? (process.env.DEMO_MODE === "true" ? "data" : "data/app")}/deployment.json`,
  )
    ? "present (chain must also be running)"
    : "not deployed",
);
