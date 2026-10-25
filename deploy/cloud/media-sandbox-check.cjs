// Trusted synthetic acceptance worker; never added to the production catalog.
const fs = require("node:fs"),
  net = require("node:net");
process.once("message", async (input) => {
  if (input.params.angle === 90) process.exit(7);
  if (input.params.angle === 180) return;
  const denied = ["/etc/contentproof", "/var/lib/contentproof", "/root"].every(
    (path) => {
      try {
        fs.accessSync(path, fs.constants.R_OK);
        return false;
      } catch (e) {
        return ["EACCES", "EPERM"].includes(e.code);
      }
    },
  );
  let writeDenied = false;
  const path = `/opt/contentproof/.worker-probe-${process.pid}`;
  try {
    fs.writeFileSync(path, "synthetic", { flag: "wx" });
    fs.unlinkSync(path);
  } catch (e) {
    writeDenied = ["EROFS", "EACCES", "EPERM"].includes(e.code);
  }
  const networkDenied = await new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port: 3001 });
    s.setTimeout(1000);
    s.once("timeout", () => {
      s.destroy();
      resolve(false);
    });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", (e) =>
      resolve(["EAFNOSUPPORT", "EACCES", "EPERM"].includes(e.code)),
    );
  });
  const report = {
    uid: process.getuid(),
    protectedPathsDenied: denied,
    writeDenied,
    networkDenied,
    secretEnvironmentEmpty: !Object.keys(process.env).some((k) =>
      /^(STORAGE_KEY|RELAYER_PRIVATE_KEY|VAULT_|CP_BACKUP_PASSWORD|NODE_OPTIONS|NODE_PATH)/.test(
        k,
      ),
    ),
  };
  process.send({ ok: true, result: Buffer.from(JSON.stringify(report)) });
});
process.on("disconnect", () => process.exit(0));
