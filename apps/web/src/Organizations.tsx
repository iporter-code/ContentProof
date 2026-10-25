import React, { useEffect, useState } from "react";
import { api } from "./api";
export function Organizations() {
  const [data, setData] = useState<any>({ organizations: [], operator: false }),
    [reviews, setReviews] = useState<any[]>([]),
    [id, setId] = useState(""),
    [detail, setDetail] = useState<any>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState(""),
    [evidence, setEvidence] = useState(""),
    [address, setAddress] = useState(""),
    [role, setRole] = useState("viewer"),
    [digest, setDigest] = useState(""),
    [claimId, setClaimId] = useState(""),
    [permission, setPermission] = useState("read"),
    [reason, setReason] = useState("");
  async function refresh(selected = id) {
    const d = await api("/v1/organizations");
    setData(d);
    if (d.operator) setReviews(await api("/v1/operator/organizations"));
    if (selected) setDetail(await api(`/v1/organizations/${selected}`));
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
      setNotice("操作已保存");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">ORGANIZATIONS / 组织协作</div>
          <h1>审核身份，明确协作权限。</h1>
        </div>
      </header>
      <p className="lead">
        申请时提交线下资质材料的SHA-256摘要。审核员核验原材料后批准；钱包地址和自述名称不代表资质认证。
      </p>
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <section className="panel">
        <h2>申请机构</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(() =>
              api("/v1/organizations", { name, evidenceDigest: evidence }),
            );
          }}
        >
          <label>
            机构名称
            <input
              aria-label="机构名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
            />
          </label>
          <label>
            资质材料摘要
            <input
              aria-label="资质材料摘要"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              required
              pattern="0x[0-9a-f]{64}"
              placeholder="0x + 64位小写十六进制"
            />
          </label>
          <button disabled={busy}>提交审核</button>
        </form>
      </section>
      <section className="panel">
        <h2>我的机构与邀请</h2>
        {data.organizations.map((o: any) => (
          <div className="actions" key={o.id}>
            <span>
              {o.name} · {o.status} · {o.role}
            </span>
            {o.membershipStatus === "invited" ? (
              <button
                disabled={busy}
                onClick={() =>
                  void act(() => api(`/v1/organizations/${o.id}/accept`, {}))
                }
              >
                接受邀请
              </button>
            ) : (
              <button
                onClick={() => {
                  setId(o.id);
                  void refresh(o.id).catch((e) => setError(e.message));
                }}
              >
                查看与管理
              </button>
            )}
          </div>
        ))}
      </section>
      {detail && (
        <section className="panel">
          <h2>
            {detail.organization.name} · {detail.organization.status}
          </h2>
          <p className="mono">{id}</p>
          <h3>成员</h3>
          {detail.members.map((m: any) => (
            <p className="mono" key={m.address}>
              {m.address} · {m.role} · {m.status}
            </p>
          ))}
          <label>
            成员地址
            <input
              aria-label="成员地址"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <label>
            成员权限
            <select
              aria-label="成员权限"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {["viewer", "editor", "admin", "owner"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <div className="actions">
            {[false, true].map((remove) => (
              <button
                key={String(remove)}
                disabled={busy || !address}
                onClick={() =>
                  void act(() =>
                    api(`/v1/organizations/${id}/members`, {
                      address,
                      role,
                      remove,
                    }),
                  )
                }
              >
                {remove ? "移除成员" : "邀请或更新角色"}
              </button>
            ))}
          </div>
          <h3>共享自己的内容</h3>
          <label>
            素材摘要
            <input
              aria-label="共享素材摘要"
              value={digest}
              onChange={(e) => setDigest(e.target.value)}
            />
          </label>
          <label>
            声明ID（可选）
            <input
              aria-label="共享声明ID"
              value={claimId}
              onChange={(e) => setClaimId(e.target.value)}
            />
          </label>
          <select
            aria-label="共享权限"
            value={permission}
            onChange={(e) => setPermission(e.target.value)}
          >
            <option value="read">只读</option>
            <option value="edit">允许编辑角色使用</option>
          </select>
          <div className="actions">
            {[false, true].map((revoke) => (
              <button
                key={String(revoke)}
                disabled={busy || !digest}
                onClick={() =>
                  void act(() =>
                    api(`/v1/organizations/${id}/share`, {
                      digest,
                      ...(claimId ? { claimId } : {}),
                      permission,
                      revoke,
                    }),
                  )
                }
              >
                {revoke ? "撤销共享" : "共享给机构"}
              </button>
            ))}
          </div>
          <h3>审核记录</h3>
          {detail.reviews.map((r: any, i: number) => (
            <p key={i}>
              {r.created} · {r.status} · {r.reason}
              <br />
              <small className="mono">{r.reviewer}</small>
            </p>
          ))}
        </section>
      )}
      {data.operator && (
        <section className="panel">
          <h2>审核工作台</h2>
          <label>
            核验依据与原因
            <input
              aria-label="审核原因"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {reviews.map((o) => (
            <div key={o.id}>
              <h3>
                {o.name} · {o.status}
              </h3>
              <p className="mono">
                申请者：{o.applicant}
                <br />
                材料摘要：{o.evidenceDigest}
              </p>
              <div className="actions">
                {["approved", "rejected", "suspended"].map((status) => (
                  <button
                    key={status}
                    disabled={busy || reason.trim().length < 5}
                    onClick={() =>
                      void act(() =>
                        api(`/v1/operator/organizations/${o.id}/review`, {
                          status,
                          reason,
                        }),
                      )
                    }
                  >
                    {
                      (
                        {
                          approved: "批准",
                          rejected: "驳回",
                          suspended: "暂停",
                        } as Record<string, string>
                      )[status]
                    }
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
