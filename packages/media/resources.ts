export class ResourcePool {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(
    readonly concurrency: number,
    readonly queueLimit: number,
  ) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiters.length >= this.queueLimit)
        throw Error("MEDIA_RESOURCE_LIMIT");
      await new Promise<void>((r) => this.waiters.push(r));
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
  status() {
    return {
      active: this.active,
      queued: this.waiters.length,
      concurrency: this.concurrency,
    };
  }
}
function mediaLimit(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw Error(`INVALID_${name}`);
  return value;
}
export const mediaPool = new ResourcePool(
  mediaLimit("MEDIA_CONCURRENCY", 2, 1, 4),
  mediaLimit("MEDIA_QUEUE_LIMIT", 8, 0, 16),
);
