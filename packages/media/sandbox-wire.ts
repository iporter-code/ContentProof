import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
export const MAX_SANDBOX_FRAME = 57 * 1024 * 1024;
export function sandboxFrame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_SANDBOX_FRAME) throw Error("MEDIA_SANDBOX_SIZE_LIMIT");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
}
// A connection carries exactly one length-delimited JSON message. No executable
// paths, environment variables or v8 object graphs are accepted from clients.
export function receiveSandboxFrame(
  socket: Socket,
  accept: (value: unknown) => void,
) {
  let chunks: Buffer[] = [],
    length = 0,
    expected: number | undefined,
    done = false;
  socket.on("data", (chunk: Buffer) => {
    if (done) return socket.destroy();
    length += chunk.length;
    if (length > MAX_SANDBOX_FRAME + 4) return socket.destroy();
    chunks.push(chunk);
    if (expected === undefined && length >= 4) {
      const head = Buffer.concat(chunks);
      chunks = [head];
      expected = head.readUInt32BE();
      if (!expected || expected > MAX_SANDBOX_FRAME) return socket.destroy();
    }
    if (expected === undefined || length < expected + 4) return;
    done = true;
    if (length !== expected + 4) return socket.destroy();
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).subarray(4).toString("utf8"));
    } catch {
      return socket.destroy();
    }
    chunks = [];
    accept(value);
  });
}
export async function sandboxRequest(
  path: string,
  value: unknown,
  timeout = 25000,
): Promise<any> {
  if (!isAbsolute(path) && !/^\\\\\.\\pipe\\[A-Za-z0-9-]+$/.test(path))
    throw Error("MEDIA_SANDBOX_INVALID_SOCKET");
  const frame = sandboxFrame(value);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (error?: Error, response?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(response);
    };
    const timer = setTimeout(
      () => finish(Error("MEDIA_SANDBOX_TIMEOUT")),
      timeout,
    );
    socket.once("connect", () => socket.write(frame));
    socket.once("error", () => finish(Error("MEDIA_SANDBOX_UNAVAILABLE")));
    socket.once("close", () => finish(Error("MEDIA_SANDBOX_PROTOCOL")));
    receiveSandboxFrame(socket, (response) => finish(undefined, response));
  });
}
