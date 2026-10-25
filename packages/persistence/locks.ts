import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
// Linux container PIDs are reused after restart. A PID alone can refer to an
// unrelated process in a later container, so bind it to kernel/start identity.
function processIdentity(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const namespace = readlinkSync(`/proc/${pid}/ns/pid`);
    return `${boot}:${namespace}:${started}`;
  } catch {
    return undefined;
  }
}
function live(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const { pid, identity } = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) throw Error("INVALID_LOCK");
    try {
      process.kill(pid, 0);
      const current = processIdentity(pid);
      if (identity && current && identity !== current) return false;
      return true;
    } catch (error: any) {
      return error.code !== "ESRCH";
    }
  } catch {
    throw Error("INVALID_RUNTIME_LOCK");
  }
}
export function acquireLock(
  root: string,
  name: "api" | "chain" | "maintenance",
  allowPendingRotation = false,
) {
  if (!allowPendingRotation && existsSync(`${resolve(root)}.key-rotation.json`))
    throw Error("KEY_ROTATION_RECOVERY_REQUIRED");
  mkdirSync(root, { recursive: true });
  const path = resolve(root, `.${name}.lock`),
    value = JSON.stringify({
      pid: process.pid,
      identity: processIdentity(process.pid),
      nonce: randomUUID(),
    });
  if (live(path)) throw Error(`DATA_DIRECTORY_BUSY_${name.toUpperCase()}`);
  if (existsSync(path)) unlinkSync(path);
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
  const release = () => {
    process.removeListener("exit", release);
    if (existsSync(path) && readFileSync(path, "utf8") === value)
      unlinkSync(path);
  };
  try {
    const peers = name === "maintenance" ? ["api", "chain"] : ["maintenance"];
    if (peers.some((peer) => live(resolve(root, `.${peer}.lock`))))
      throw Error("DATA_DIRECTORY_BUSY");
  } catch (error) {
    release();
    throw error;
  }
  process.once("exit", release);
  return release;
}
