import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { ResourcePool } from "./resources.js";
export class ProcessJobs {
  private children = new Set<ChildProcess>();
  private closing = false;
  constructor(
    private worker: URL,
    readonly pool: ResourcePool,
    private timeout = 20000,
  ) {}
  run<T>(input: Serializable): Promise<T> {
    if (this.closing) return Promise.reject(Error("MEDIA_WORKER_CLOSED"));
    return this.pool.run(
      () =>
        new Promise<T>((resolve, reject) => {
          if (this.closing) {
            reject(Error("MEDIA_WORKER_CLOSED"));
            return;
          }
          const source = this.worker.pathname.endsWith(".ts"),
            child = fork(this.worker, [], {
              serialization: "advanced",
              execArgv: [
                "--max-old-space-size=192",
                ...(source ? ["--import", "tsx"] : []),
              ],
              stdio: ["ignore", "ignore", "ignore", "ipc"],
              windowsHide: true,
            });
          this.children.add(child);
          let settled = false;
          const finish = (error?: Error, result?: T) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const complete = () => {
              this.children.delete(child);
              error ? reject(error) : resolve(result!);
            };
            if (child.exitCode !== null || child.signalCode !== null)
              complete();
            else {
              child.once("exit", complete);
              child.kill("SIGKILL");
            }
          };
          const timer = setTimeout(
            () => finish(Error("MEDIA_WORKER_TIMEOUT")),
            this.timeout,
          );
          child.once("error", () => finish(Error("MEDIA_WORKER_START_FAILED")));
          child.once("exit", () => finish(Error("MEDIA_WORKER_CRASH")));
          child.once("message", (message: any) => {
            if (message?.ok === true) finish(undefined, message.result);
            else
              finish(
                Error(
                  typeof message?.error === "string" &&
                    /^[A-Z_]{3,80}$/.test(message.error)
                    ? message.error
                    : "MEDIA_PROCESSING_FAILED",
                ),
              );
          });
          child.send(input, (error) => {
            if (error) finish(Error("MEDIA_WORKER_IPC_FAILED"));
          });
        }),
    );
  }
  close() {
    this.closing = true;
    for (const child of this.children) child.kill("SIGKILL");
  }
}
