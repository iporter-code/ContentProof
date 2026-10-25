import { createMediaSandbox } from "../packages/media/sandbox-service.js";
if (
  process.platform !== "linux" ||
  process.env.LISTEN_PID !== String(process.pid) ||
  process.env.LISTEN_FDS !== "1" ||
  !process.env.CP_MEDIA_ENGINES_FILE
)
  throw Error("MEDIA_SANDBOX_SOCKET_ACTIVATION_REQUIRED");
const server = createMediaSandbox(process.env.CP_MEDIA_ENGINES_FILE);
server.listen({ fd: 3 });
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
console.log("Historical image sandbox listening on inherited local socket.");
