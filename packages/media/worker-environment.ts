// Image workers receive bytes and parameters over IPC, never application secrets.
export function workerEnvironment(source = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ])
    if (process.env[name]) env[name] = process.env[name];
  // Source workers need the tsx loader in development. NODE_OPTIONS and NODE_PATH
  // are deliberately not inherited; executable and worker paths are absolute.
  if (source && process.env.PATH) env.PATH = process.env.PATH;
  return env;
}
