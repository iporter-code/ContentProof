import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AlertMonitor,
  diskPressureSignal,
  type AlertSignal,
} from "../../packages/operations/alerts.js";
import { all, one, run, audit, transaction } from "./store.js";
import { operator } from "./organizations.js";
import { getHeapStatistics } from "node:v8";
import { statfsSync } from "node:fs";
import { dataPath } from "../../packages/config/index.js";
const minimumFreeBytes = Number(
  process.env.STORAGE_MIN_FREE_BYTES ?? 512 * 1024 * 1024,
);
if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 1)
  throw Error("INVALID_STORAGE_MIN_FREE_BYTES");
export function recordAlert(signal: AlertSignal, active: boolean) {
  const now = Date.now();
  transaction(() => {
    const existing = one(
      "SELECT id FROM operator_alerts WHERE code=? AND resolvedAt IS NULL",
      signal.code,
    );
    if (!active) {
      if (existing)
        run(
          "UPDATE operator_alerts SET resolvedAt=? WHERE id=?",
          now,
          existing.id,
        );
      return;
    }
    if (existing)
      run(
        "UPDATE operator_alerts SET lastSeen=?,value=?,threshold=?,occurrences=occurrences+1 WHERE id=?",
        now,
        signal.value,
        signal.threshold,
        existing.id,
      );
    else
      run(
        "INSERT INTO operator_alerts(id,code,severity,description,value,threshold,firstSeen,lastSeen) VALUES(?,?,?,?,?,?,?,?)",
        randomUUID(),
        signal.code,
        signal.severity,
        signal.description,
        signal.value,
        signal.threshold,
        now,
        now,
      );
  });
}
export function registerOperations(
  app: FastifyInstance,
  owner: (req: any) => string,
  snapshot: () => {
    workerError: string | null;
    indexerError: string | null;
    workerAge: number;
    inFlight: number;
    mediaQueued: number;
  },
) {
  app.get("/v1/system/alerts", (req) => {
    const who = owner(req),
      input = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          before: z.coerce.number().int().positive().optional(),
        })
        .strict()
        .parse(req.query);
    return {
      data: {
        operator: operator(who),
        alerts: all(
          "SELECT rowid AS sequence,* FROM operator_alerts WHERE rowid<? ORDER BY rowid DESC LIMIT ?",
          input.before ?? Number.MAX_SAFE_INTEGER,
          input.limit,
        ),
        open: Number(
          one(
            "SELECT COUNT(*) AS n FROM operator_alerts WHERE resolvedAt IS NULL",
          )?.n ?? 0,
        ),
      },
    };
  });
  app.post<{ Params: { id: string } }>("/v1/system/alerts/:id/ack", (req) => {
    const who = owner(req);
    if (!operator(who)) throw Error("FORBIDDEN");
    const changed = run(
      "UPDATE operator_alerts SET acknowledgedAt=? WHERE id=? AND resolvedAt IS NULL",
      Date.now(),
      req.params.id,
    );
    if (!changed.changes) throw Error("ALERT_NOT_FOUND");
    audit(who, "alert-acknowledged", req.params.id);
    return { data: { acknowledged: true } };
  });
  const monitor = new AlertMonitor(recordAlert);
  const timer = setInterval(() => {
    try {
      const s = snapshot(),
        memory = process.memoryUsage(),
        ratio = memory.heapUsed / getHeapStatistics().heap_size_limit,
        disk = statfsSync(dataPath);
      monitor.sample([
        diskPressureSignal(disk.bavail * disk.bsize, minimumFreeBytes),
        {
          code: "ANCHOR_WORKER_STALLED",
          severity: "error",
          description: "登记任务处理长时间未返回",
          value: s.workerAge,
          threshold: 120000,
          unhealthy: s.workerAge > 120000 || !!s.workerError,
        },
        {
          code: "INDEXER_UNAVAILABLE",
          severity: "warning",
          description: "链状态索引持续读取失败",
          value: s.indexerError ? 1 : 0,
          threshold: 1,
          unhealthy: !!s.indexerError,
        },
        {
          code: "REQUEST_PRESSURE",
          severity: "warning",
          description: "请求并发持续接近上限",
          value: s.inFlight,
          threshold: 7,
          unhealthy: s.inFlight >= 7,
        },
        {
          code: "MEDIA_QUEUE_PRESSURE",
          severity: "warning",
          description: "图片任务持续排队",
          value: s.mediaQueued,
          threshold: 6,
          unhealthy: s.mediaQueued >= 6,
        },
        {
          code: "HEAP_PRESSURE",
          severity: "warning",
          description: "应用堆内存使用率持续偏高",
          value: ratio,
          threshold: 0.9,
          unhealthy: ratio >= 0.9,
        },
      ]);
    } catch {
      app.log.warn(
        { code: "ALERT_MONITOR_FAILED" },
        "Local alert monitor failed",
      );
    }
  }, 5000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
