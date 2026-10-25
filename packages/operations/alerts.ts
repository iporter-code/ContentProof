export interface AlertSignal {
  code: string;
  severity: "warning" | "error";
  description: string;
  value: number;
  threshold: number;
  unhealthy: boolean;
}
export function diskPressureSignal(
  availableBytes: number,
  minimumBytes: number,
): AlertSignal {
  if (
    !Number.isSafeInteger(availableBytes) ||
    availableBytes < 0 ||
    !Number.isSafeInteger(minimumBytes) ||
    minimumBytes < 1
  )
    throw Error("INVALID_DISK_SPACE_BUDGET");
  return {
    code: "STORAGE_DISK_PRESSURE",
    severity: "warning",
    description: "数据磁盘可用空间持续低于保留预算",
    value: availableBytes,
    threshold: minimumBytes,
    unhealthy: availableBytes < minimumBytes,
  };
}
// Consecutive samples avoid oscillation. Persistence/delivery is injected so no
// external message is sent without an explicitly configured, authorized channel.
export class AlertMonitor {
  private streaks = new Map<string, { bad: number; good: number }>();
  constructor(
    private record: (signal: AlertSignal, active: boolean) => void,
    private failures = 3,
    private recovery = 2,
  ) {}
  sample(signals: AlertSignal[]) {
    for (const signal of signals) {
      const s = this.streaks.get(signal.code) ?? { bad: 0, good: 0 };
      if (signal.unhealthy) {
        s.bad++;
        s.good = 0;
        if (s.bad >= this.failures) this.record(signal, true);
      } else {
        s.good++;
        s.bad = 0;
        if (s.good >= this.recovery) this.record(signal, false);
      }
      this.streaks.set(signal.code, s);
    }
  }
}
