import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
export function Operations() {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const [alerts, metrics] = await Promise.all([
        api("/v1/system/alerts"),
        api("/v1/system/metrics"),
      ]);
      if (request !== generation.current) return;
      setData({ alerts, metrics });
      setError("");
    } catch (e) {
      if (request === generation.current) setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [load]);
  async function acknowledge(id: string) {
    setBusy(true);
    try {
      await api(`/v1/system/alerts/${id}/ack`, {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">OPERATIONS / 运行状态</div>
          <h1>让持续故障及时可见。</h1>
        </div>
        <button className="secondary" onClick={() => void load()}>
          刷新状态
        </button>
      </div>
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      <section className="panel">
        <h2>当前运行</h2>
        {data ? (
          <dl>
            <dt>未恢复告警</dt>
            <dd>{data.alerts.open}</dd>
            <dt>正在处理的请求</dt>
            <dd>{data.metrics.inFlight}</dd>
            <dt>图片处理 / 排队</dt>
            <dd>
              {data.metrics.media.active} / {data.metrics.media.queued}
            </dd>
            <dt>应用内存</dt>
            <dd>{(data.metrics.memory.rss / 1024 / 1024).toFixed(1)} MB</dd>
            <dt>运行时长</dt>
            <dd>{Math.floor(data.metrics.uptimeSeconds / 60)} 分钟</dd>
          </dl>
        ) : (
          <p>正在读取运行状态…</p>
        )}
        <p className="muted">
          持续异常会记录在本系统中；恢复后保留历史。图片任务由独立进程处理。
        </p>
      </section>
      <section className="panel">
        <h2>最近告警</h2>
        {data?.alerts.alerts.length === 0 ? (
          <p>暂无告警记录。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>情况</th>
                  <th>最近时间</th>
                  <th>状态</th>
                  <th>处理</th>
                </tr>
              </thead>
              <tbody>
                {data?.alerts.alerts.map((a: any) => (
                  <tr key={a.id}>
                    <td>
                      {a.description}
                      <small>
                        {a.severity === "error" ? "严重" : "提醒"} · 持续{" "}
                        {a.occurrences} 次
                      </small>
                    </td>
                    <td>{new Date(a.lastSeen).toLocaleString()}</td>
                    <td>
                      {a.resolvedAt
                        ? "已恢复"
                        : a.acknowledgedAt
                          ? "已确认，等待恢复"
                          : "待处理"}
                    </td>
                    <td>
                      {!a.resolvedAt &&
                      !a.acknowledgedAt &&
                      data.alerts.operator ? (
                        <button
                          disabled={busy}
                          onClick={() => void acknowledge(a.id)}
                        >
                          确认知悉
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <small>
          显示最近50条。确认知悉由运维审核人操作，不会改变故障本身。
        </small>
      </section>
    </>
  );
}
