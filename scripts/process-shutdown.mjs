// Only handles a ChildProcess owned by this supervisor, never a discovered PID.
export async function stopOwnedProcess(
  child,
  name,
  { grace = 15000, terminate = 5000, kill = 5000 } = {},
) {
  const started = Date.now();
  let forced = false;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const wait = (milliseconds) =>
    new Promise((resolve) => {
      if (exited()) return resolve(true);
      const ended = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.removeListener("exit", ended);
        resolve(false);
      }, milliseconds);
      child.once("exit", ended);
    });
  if (!exited()) {
    if (name === "web") child.kill("SIGTERM");
    else if (child.connected) child.send("shutdown", () => {});
    else forced = true;
    if (!(await wait(grace))) {
      forced = true;
      child.kill("SIGTERM");
      if (!(await wait(terminate))) {
        child.kill("SIGKILL");
        await wait(kill);
      }
    }
  }
  return {
    name,
    pid: child.pid,
    milliseconds: Date.now() - started,
    code: child.exitCode,
    signal: child.signalCode,
    forced,
    passed:
      exited() &&
      !forced &&
      (child.exitCode === 0 ||
        (name === "web" && child.signalCode === "SIGTERM")),
  };
}
