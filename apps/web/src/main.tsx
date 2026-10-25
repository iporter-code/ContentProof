import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ConsentHost } from "./ConsentHost";
import { requestConsent } from "./consent-store";
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  NavLink,
  Navigate,
  useNavigate,
  useParams,
  useLocation,
} from "react-router-dom";
import {
  api,
  token,
  download,
  downloadBundle,
  signAndAnchor,
  createSigningDraft,
  confirmSigningNetwork,
  uploadVerified,
  waitForJob,
} from "./api";
import { grantExpiry } from "./integrity";
import "./style.css";
import { LoginScreen } from "./LoginScreen";
import { loginDestination } from "./auth-navigation";
import { Organizations } from "./Organizations";
import { Operations } from "./Operations";
const GraphCanvas = React.lazy(() => import("./GraphCanvas"));
import {
  lockWallet,
  signingAddress,
  signText,
  signTyped,
  vaults,
  createVault,
  unlockVault,
} from "./wallet";
type Claim = { id: string; core: any; owner: string };
const short = (s: string = "") =>
  s ? `${s.slice(0, 10)}…${s.slice(-6)}` : "—";
const operations: Record<string, string> = {
  import: "素材导入",
  crop: "裁剪",
  resize: "缩放",
  rotate: "旋转",
  compose: "多图合成",
  "ai-declaration": "AI生成声明",
};
const words: Record<string, string> = {
  match: "文件匹配",
  mismatch: "校验不匹配",
  valid: "签名有效",
  invalid: "校验失败",
  unchecked: "尚未检查",
  confirmed: "已上链确认",
  absent: "未找到登记",
  offline: "链服务离线",
  pending: "等待确认",
  withdrawn: "声明已撤回",
  active: "密钥有效",
  retired: "密钥已停用",
  revoked: "密钥已撤销",
  unknown: "身份未知",
  complete: "完整披露",
  partial: "部分披露",
  "complete-declared-graph": "已覆盖全部声明关系",
  withheld: "部分来源已隐藏",
  missing: "来源证据缺失",
  reproduced: "操作复算一致",
  "declared-only": "仅签名声明",
  unavailable: "无法复算",
  "not-provided": "未提供文件",
  pass: "满足验证条件",
  fail: "验证失败",
  incomplete: "证据或检查不完整",
};
function Badge({ value }: { value: string }) {
  const good = [
      "match",
      "valid",
      "confirmed",
      "active",
      "complete",
      "complete-declared-graph",
      "reproduced",
      "pass",
    ].includes(value),
    bad = ["mismatch", "invalid", "fail", "revoked", "withdrawn"].includes(
      value,
    );
  return (
    <span className={`badge ${good ? "good" : bad ? "bad" : "warn"}`}>
      {good ? "✓" : bad ? "×" : "◌"} {words[value] ?? value}
    </span>
  );
}
function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const generation = useRef(0);
  const [data, setData] = useState<T>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true);
  const load = useCallback(() => {
    const current = ++generation.current;
    setError("");
    setBusy(true);
    fn()
      .then((value) => {
        if (current === generation.current) setData(value);
      })
      .catch((e) => {
        if (current === generation.current) {
          setData(undefined);
          setError(e.message);
        }
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
  }, deps);
  useEffect(() => {
    load();
    return () => {
      generation.current++;
    };
  }, [load]);
  return { data, error, load, busy };
}
function usePaged<T>(path: string) {
  const [data, setData] = useState<T[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    generation = useRef(0);
  async function fetchPage(reset: boolean) {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const page = await api(
        `${path}/page?limit=50${!reset && cursor ? `&cursor=${cursor}` : ""}`,
      );
      if (current !== generation.current) return;
      setData((old) => (reset ? page.items : [...old, ...page.items]));
      setCursor(page.nextCursor);
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  const load = useCallback(() => {
    void fetchPage(true);
  }, [path]);
  useEffect(() => {
    load();
    return () => {
      generation.current++;
    };
  }, [load]);
  return {
    data,
    error,
    load,
    busy,
    hasMore: !!cursor,
    more: () => void fetchPage(false),
  };
}
function Notice({ error }: { error?: string }) {
  return error ? (
    <div className="notice" role="alert">
      {error}
    </div>
  ) : null;
}
function Image({
  digest,
  className = "",
}: {
  digest: string;
  className?: string;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true,
      object = "";
    fetch(`/v1/assets/${digest}/content`, {
      headers: { Authorization: `Bearer ${token()}` },
    })
      .then((r) => {
        if (!r.ok) throw Error();
        return r.blob();
      })
      .then((blob) => {
        object = URL.createObjectURL(blob);
        if (live) setUrl(object);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (object) URL.revokeObjectURL(object);
    };
  }, [digest]);
  return url ? (
    <img className={className} src={url} alt="已授权内容素材" />
  ) : (
    <div className="image-placeholder">素材预览</div>
  );
}
function Head({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
      </div>
      {children}
    </header>
  );
}
function App() {
  const [identity, setIdentity] = useState(""),
    [ready, setReady] = useState(false);
  const location = useLocation();
  useEffect(() => {
    const reset = () => {
      lockWallet();
      setReady(false);
      setIdentity("");
    };
    const locked = () => {
      setReady(false);
      setIdentity("");
    };
    window.addEventListener("cp-session-expired", reset);
    window.addEventListener("cp-locked", locked);
    // A page reload locks the in-memory signer. A leftover bearer token alone
    // must not make the workspace appear logged in.
    lockWallet();
    return () => {
      window.removeEventListener("cp-session-expired", reset);
      window.removeEventListener("cp-locked", locked);
    };
  }, []);
  useEffect(() => {
    document.title = ready ? "内容证链 · ContentProof" : "登录 · 内容证链";
  }, [ready]);
  const loginPage =
    location.pathname === "/login" || location.pathname === "/login/";
  if (!ready) {
    if (!loginPage)
      return (
        <Navigate
          to="/login"
          replace
          state={{ from: location.pathname + location.search + location.hash }}
        />
      );
    return (
      <LoginScreen
        onReady={() => {
          const address = signingAddress();
          if (!address || !token()) throw Error("身份状态已改变，请重新登录");
          setIdentity(address);
          setReady(true);
        }}
      />
    );
  }
  if (loginPage)
    return <Navigate to={loginDestination(location.state?.from)} replace />;
  return <Workspace key={identity} identity={identity} />;
}
function Workspace({ identity }: { identity: string }) {
  const location = useLocation();
  const net = useLoad(() => api("/v1/chain/status"), [location.pathname]);
  return (
    <div className="shell" data-consent-background>
      <aside>
        <Link className="brand" to="/">
          <span className="brand-mark">证</span>
          <span>
            内容证链<small>CONTENTPROOF</small>
          </span>
        </Link>
        <div className="workspace-label">
          证据工作空间 <span>LOCAL</span>
        </div>
        <nav>
          {[
            ["/", "◈", "总览"],
            ["/assets", "▧", "素材库"],
            ["/editor", "⌘", "编辑与签名"],
            ["/claims", "◇", "声明记录"],
            ["/verify", "◎", "独立验证"],
            ["/identities", "⊙", "身份与密钥"],
            ["/organizations", "♧", "组织与权限"],
            ["/operations", "◉", "运行状态"],
            ["/demo", "↗", "攻击实验"],
          ].map(([url, icon, label]) => (
            <NavLink key={url} to={url} end={url === "/"}>
              <span>{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="aside-note">
          <span className="live-dot" /> 私有 EVM · 具体状态见链连接
          <p>来源有据，隐私有界。</p>
          <small>签名证明声明来源，不证明内容符合事实。</small>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <span>
            工作空间 /{" "}
            {location.pathname === "/"
              ? "总览"
              : location.pathname.split("/")[1]}
          </span>
          <div>
            <span className="network">
              {net.data?.height
                ? `● 区块 #${net.data.height}`
                : "○ 链连接待检查"}
            </span>
            <span className="mono">{short(identity)}</span>
            <button
              className="secondary"
              onClick={() => {
                void api("/v1/auth/logout", {}).catch(() => {});
                lockWallet();
              }}
            >
              锁定并退出
            </button>
          </div>
        </div>
        <main>
          <Routes key={identity}>
            <Route path="/organizations" element={<Organizations />} />
            <Route path="/operations" element={<Operations />} />
            <Route path="/" element={<Dashboard />} />
            <Route path="/assets" element={<Assets />} />
            <Route path="/editor" element={<Editor />} />
            <Route path="/claims" element={<Claims />} />
            <Route path="/claims/:id" element={<ClaimDetail />} />
            <Route path="/claims/:id/graph" element={<Graph />} />
            <Route path="/claims/:id/disclose" element={<Disclosure />} />
            <Route path="/verify" element={<Verify />} />
            <Route path="/identities" element={<Identities />} />
            <Route path="/demo" element={<Demo />} />
            <Route
              path="*"
              element={
                <p>
                  页面不存在。<Link to="/">返回总览</Link>
                </p>
              }
            />
          </Routes>
        </main>
        <footer>
          ContentProof / 2026 · 自定义 sidecar 证据协议{" "}
          <span>精确字节校验 · EIP-712 签名 · SHA-256 承诺</span>
        </footer>
      </div>
    </div>
  );
}
function Dashboard() {
  const stats = useLoad(() => api("/v1/stats"));
  const assets = useLoad<any[]>(() => api("/v1/assets")),
    claims = useLoad<Claim[]>(() => api("/v1/claims"));
  return (
    <>
      <Head eyebrow="OVERVIEW / 工作空间" title="让内容流转，有迹可循。">
        <Link className="button" to="/editor">
          新建内容声明 ↗
        </Link>
      </Head>
      <p className="lead">
        从原始素材到最终发布，核验文件、编辑关系和每一次披露。
      </p>
      <div className="stats">
        <Stat number={stats.data?.assets ?? "—"} label="授权素材" />
        <Stat number={stats.data?.claims ?? "—"} label="可访问声明" />
        <Stat number="用户持钥" label="签名方式" />
        <Stat number="SHA-256" label="精确文件指纹" />
      </div>
      <section className="hero-panel">
        <div>
          <div className="eyebrow">EVIDENCE, NOT ASSUMPTIONS</div>
          <h2>
            不只验证文件。
            <br />
            也看见证据的边界。
          </h2>
          <p>
            部分披露、缺失来源与验证失败，始终分开呈现。
            <br />
            每个结果都有可追溯的检查理由。
          </p>
          <Link to="/verify" className="text-link">
            打开验证中心 →
          </Link>
        </div>
        <div className="hero-graph">
          <div>
            ▧ 原始素材 <span>签名声明</span>
          </div>
          <i>↓</i>
          <div>
            ⌘ 受控编辑 <span>操作可复算</span>
          </div>
          <i>↓</i>
          <div className="hero-final">
            ◎ 发布证据 <span>按需披露</span>
          </div>
        </div>
      </section>
      <div className="section-title">
        <h2>最近的内容声明</h2>
        <div className="actions">
          <button
            className="secondary"
            disabled={claims.busy}
            onClick={() => {
              claims.load();
              stats.load();
            }}
          >
            刷新声明
          </button>
          <Link to="/claims">查看全部 →</Link>
        </div>
      </div>
      <Notice error={claims.error || assets.error || stats.error} />
      <ClaimTable
        claims={claims.data ?? []}
        busy={claims.busy}
        error={claims.error}
      />
      <section className="steps">
        {[
          ["01", "导入与编辑", "对文件建立精确指纹，绑定输入、操作和输出。"],
          ["02", "签名与登记", "签名者对声明负责，链上保留承诺与登记状态。"],
          ["03", "披露与核验", "隐藏私有字段，导出可在服务之外检查的证据。"],
        ].map(([n, t, d]) => (
          <div key={n}>
            <small>{n}</small>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </section>
    </>
  );
}
function Stat({ number, label }: { number: React.ReactNode; label: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{number}</strong>
      <small>当前工作空间</small>
    </div>
  );
}
function ClaimTable({
  claims,
  busy = false,
  error = "",
}: {
  claims: Claim[];
  busy?: boolean;
  error?: string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>声明 / 文件</th>
            <th>操作类型</th>
            <th>签名者</th>
            <th>来源数量</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {claims.map((c) => (
            <tr key={c.id}>
              <td>
                <Link to={`/claims/${c.id}`} className="mono">
                  {short(c.id)}
                </Link>
                <small>{short(c.core.assetDigest)}</small>
              </td>
              <td>{operations[c.core.operation]}</td>
              <td className="mono">{short(c.core.issuer)}</td>
              <td>{c.core.parentCount} 个父素材</td>
              <td>
                <Link to={`/claims/${c.id}`}>查看 ↗</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!claims.length && busy && (
        <div className="empty" role="status">
          正在加载内容声明…
        </div>
      )}
      {!claims.length && !busy && error && (
        <div className="empty">声明加载失败，请刷新页面重试。</div>
      )}
      {!claims.length && !busy && !error && (
        <div className="empty">
          当前身份还没有可访问的已签署声明。上传图片后，还需完成签署；取消时保存的草稿不会出现在这里。
          <Link to="/editor">前往编辑与签名，创建或恢复草稿 →</Link>
        </div>
      )}
    </div>
  );
}
function Claims() {
  const { data, error, hasMore, more, busy } = usePaged<Claim>("/v1/claims");
  return (
    <>
      <Head eyebrow="CLAIMS / 声明记录" title="每个版本，都有依据。" />
      <Notice error={error} />
      <ClaimTable claims={data ?? []} busy={busy} error={error} />
      {hasMore && (
        <button disabled={busy} onClick={more}>
          加载更多声明
        </button>
      )}
    </>
  );
}
function Assets() {
  const {
    data,
    error,
    load,
    hasMore,
    more,
    busy: loading,
  } = usePaged<any>("/v1/assets");
  const [busy, setBusy] = useState(false),
    [err, setErr] = useState("");
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setErr("");
    try {
      await uploadVerified(file);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Head eyebrow="ASSETS / 授权素材" title="从一份原始文件开始。" />
      <label className="dropzone">
        <input
          aria-label="上传图片"
          type="file"
          accept="image/png,image/jpeg"
          disabled={busy}
          onChange={(e) => void upload(e.target.files?.[0])}
        />
        <strong>
          {busy ? "正在本地校验摘要并保存…" : "＋ 选择图片，建立内容指纹"}
        </strong>
        <span>PNG / JPEG · 最大20MB / 2000万像素 · 原文件字节保持不变</span>
      </label>
      <Notice error={err || error} />
      <div className="asset-grid">
        {data?.map((a) => (
          <article className="asset-card" key={a.digest}>
            <Image digest={a.digest} />
            <div>
              <span>
                {a.width} × {a.height}
              </span>
              <span>{(a.size / 1024).toFixed(1)} KB</span>
            </div>
            <code>{short(a.digest)}</code>
            {a.canEdit === false ? (
              <small>只读素材，需要编辑授权</small>
            ) : (
              <Link to={`/editor?asset=${a.digest}`}>创建来源声明 →</Link>
            )}
          </article>
        ))}
      </div>
      {hasMore && (
        <button disabled={loading} onClick={more}>
          加载更多素材
        </button>
      )}
    </>
  );
}
function Editor() {
  const navigate = useNavigate();
  const assets = useLoad<any[]>(() => api("/v1/assets")),
    claims = useLoad<Claim[]>(() => api("/v1/claims"));
  const [op, setOp] = useState("import"),
    [asset, setAsset] = useState(
      new URLSearchParams(location.search).get("asset") ?? "",
    ),
    [parents, setParents] = useState(["", ""]),
    [params, setParams] = useState({
      left: 0,
      top: 0,
      width: 256,
      height: 256,
      angle: 90,
    }),
    [title, setTitle] = useState(""),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      setBusy("正在执行图片操作…");
      const fields: Record<string, unknown> = {
        title: title || "未命名内容",
        "source.statement":
          op === "ai-declaration"
            ? "AI属性由签名者声明"
            : "素材来源由签名者声明",
      };
      if (prompt) fields["ai.prompt"] = prompt;
      const body = ["import", "ai-declaration"].includes(op)
        ? {
            assetDigest: asset || assets.data?.[0]?.digest,
            operation: op,
            fields,
          }
        : {
            parents: op === "compose" ? parents : [parents[0]],
            operation: op,
            params:
              op === "crop"
                ? {
                    left: params.left,
                    top: params.top,
                    width: params.width,
                    height: params.height,
                  }
                : op === "resize"
                  ? { width: params.width, height: params.height }
                  : op === "rotate"
                    ? { angle: params.angle }
                    : { left: params.left, top: params.top },
            fields,
          };
      const sources = ["import", "ai-declaration"].includes(op)
        ? [assets.data?.find((a) => a.digest === body.assetDigest)].filter(
            Boolean,
          )
        : (body.parents ?? []).map((id) => {
            const claim = claims.data?.find((c) => c.id === id);
            if (!claim) throw Error("请重新选择父声明");
            return {
              id: claim.id,
              digest: claim.core.assetDigest,
              size: claim.core.byteLength,
              mediaType: claim.core.mediaType,
            };
          });
      const draft = await createSigningDraft(body, sources);
      setBusy("正在签名并等待真实链确认…");
      const id = await signAndAnchor(draft.id);
      navigate(`/claims/${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <Head eyebrow="EDITOR / 编辑与签名" title="记录一次真实的内容变化。" />
      <div className="two-col">
        <form className="panel form" onSubmit={submit}>
          <label>
            操作类型
            <select value={op} onChange={(e) => setOp(e.target.value)}>
              {Object.entries(operations).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            内容标题
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="例如：校园活动发布海报"
            />
          </label>
          {["import", "ai-declaration"].includes(op) ? (
            <label>
              原始素材
              <select
                value={asset || assets.data?.[0]?.digest || ""}
                onChange={(e) => setAsset(e.target.value)}
              >
                {!assets.data?.length && <option>请先上传素材</option>}
                {assets.data?.map((a) => (
                  <option key={a.digest} value={a.digest}>
                    {short(a.digest)} · {a.width}×{a.height}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              {[0, ...(op === "compose" ? [1] : [])].map((i) => (
                <label key={i}>
                  输入素材 {i + 1}
                  {i === 1 ? "（上层）" : "（底层）"}
                  <select
                    required
                    value={parents[i]}
                    onChange={(e) =>
                      setParents((p) =>
                        p.map((x, n) => (n === i ? e.target.value : x)),
                      )
                    }
                  >
                    <option value="">选择已签名声明</option>
                    {claims.data?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {operations[c.core.operation]} {short(c.id)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <div className="form-grid">
                {(op === "rotate"
                  ? ["angle"]
                  : op === "resize"
                    ? ["width", "height"]
                    : op === "compose"
                      ? ["left", "top"]
                      : ["left", "top", "width", "height"]
                ).map((k) => (
                  <label key={k}>
                    {
                      (
                        {
                          left: "左侧坐标",
                          top: "顶部坐标",
                          width: "宽度",
                          height: "高度",
                          angle: "旋转角度",
                        } as Record<string, string>
                      )[k]
                    }
                    <input
                      required
                      type="number"
                      min="0"
                      step={k === "angle" ? 90 : 1}
                      value={params[k as keyof typeof params]}
                      onChange={(e) =>
                        setParams((p) => ({
                          ...p,
                          [k]: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            </>
          )}
          {op === "ai-declaration" && (
            <label>
              提示词（可在导出时隐藏）
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                maxLength={2000}
              />
            </label>
          )}
          <Notice error={error} />
          <button disabled={!!busy || !assets.data?.length} type="submit">
            {busy || "执行、签名并上链 →"}
          </button>
          <small>
            使用当前解锁身份在浏览器内签名；服务端不持有用户私钥。签名绑定文件、操作和父节点。
          </small>
          {sessionStorage.getItem("cp-pending-draft") && (
            <button
              type="button"
              className="secondary"
              disabled={!!busy}
              onClick={async () => {
                setBusy("正在恢复草稿…");
                try {
                  const id = await signAndAnchor(
                    sessionStorage.getItem("cp-pending-draft")!,
                  );
                  navigate(`/claims/${id}`);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy("");
                }
              }}
            >
              恢复上次未完成的签署
            </button>
          )}
        </form>
        <section className="panel explanatory">
          <div className="eyebrow">执行证据</div>
          <h2>
            编辑动作与
            <br />
            来源声明分开核验。
          </h2>
          <ol>
            <li>导入保留原文件，生成 SHA-256 指纹。</li>
            <li>裁剪、缩放、旋转和合成由真实图片引擎执行。</li>
            <li>参数、引擎版本和有序输入被同一签名绑定。</li>
            <li>证据完整时，可在独立验证器中重算输出。</li>
          </ol>
          <p>“AI生成”标签是签名者声明。系统不会将它冒充模型服务方认证。</p>
        </section>
      </div>
    </>
  );
}
function ClaimDetail() {
  const { id = "" } = useParams(),
    { data, error, load } = useLoad(() => api(`/v1/claims/${id}`), [id]);
  const [err, setErr] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [address, setAddress] = useState(""),
    [sharePermission, setSharePermission] = useState("read");
  const expiryInput = useRef<HTMLInputElement>(null);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      setErr("");
      setNotice("");
      await fn();
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <>
        <Notice error={error} />
        {error ? (
          <p>
            声明暂不可访问，请核对当前身份及授权状态。
            <Link to="/claims">返回声明记录 →</Link>
          </p>
        ) : (
          <p>读取声明…</p>
        )}
      </>
    );
  const m = data.manifest;
  return (
    <>
      <Head eyebrow="CLAIM / 声明详情" title={operations[m.core.operation]}>
        <Link className="button" to={`/claims/${id}/disclose`}>
          设置披露与导出 ↗
        </Link>
      </Head>
      <Notice error={err || error} />
      {notice && (
        <div className="notice neutral" role="status">
          {notice}
        </div>
      )}
      <div className="two-col">
        <section className="panel">
          <Image digest={m.core.assetDigest} className="detail-image" />
          <div className="tag-row">
            <Badge value={data.chain.anchor} />
            <Badge value={data.chain.identity} />
          </div>
          <p className="muted">
            {m.core.byteLength.toLocaleString()} 字节 · {m.core.mediaType}
          </p>
        </section>
        <section className="panel">
          <h2>签署与登记</h2>
          <dl>
            {[
              ["声明ID", id],
              ["文件指纹", m.core.assetDigest],
              ["签名者", m.core.issuer],
              ["密钥世代", m.core.keyEpoch],
              ["链ID", m.domain.chainId],
              ["登记区块", data.chain.blockNumber ?? "尚未确认"],
              ["字段根", m.core.claimsRoot],
              ["父节点根", m.core.parentsRoot],
            ].map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd className="mono">{v}</dd>
              </React.Fragment>
            ))}
          </dl>
          <div className="actions">
            <Link className="button secondary" to={`/claims/${id}/graph`}>
              查看来源图 →
            </Link>
            {data.chain.anchor === "absent" && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const j = await api(`/v1/claims/${id}/anchor`, {});
                    setNotice(`锚定任务 ${j.jobId} 已排队，正在等待确认…`);
                    await waitForJob(j.jobId);
                    setNotice("登记已确认");
                  })
                }
              >
                重试登记
              </button>
            )}
            <button className="secondary" disabled={busy} onClick={load}>
              刷新链状态
            </button>
          </div>
        </section>
      </div>
      <section className="panel">
        <h2>已签署字段</h2>
        <dl>
          {m.disclosure.fields.map((f: any) => (
            <React.Fragment key={f.path}>
              <dt>{f.path}</dt>
              <dd>
                {typeof f.value === "string"
                  ? f.value
                  : JSON.stringify(f.value)}
              </dd>
            </React.Fragment>
          ))}
        </dl>
        <p className="muted">
          导入声明只能证明签名者作出该声明；不能证明画面事实或版权。
        </p>
      </section>
      <section className="panel">
        <h2>协作授权</h2>
        <p>
          授权另一身份读取声明。拥有输出素材时可同时授予素材阅读或编辑权限；上游声明需由各自签名者另行授权。
        </p>
        {data.grants?.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>接收身份</th>
                <th>到期时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {data.grants.map((g: any) => (
                <tr key={g.address}>
                  <td>{short(g.address)}</td>
                  <td>
                    {g.expiresAt === null
                      ? "长期"
                      : new Date(g.expiresAt).toLocaleString()}
                  </td>
                  <td>{g.active ? "有效" : "已到期"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="actions">
          <input
            aria-label="接收身份地址"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x… 接收身份地址"
          />
          <select
            aria-label="素材授权权限"
            value={sharePermission}
            onChange={(e) => setSharePermission(e.target.value)}
          >
            <option value="read">只读素材</option>
            <option value="edit">允许编辑素材</option>
          </select>
          <label>
            授权到期（留空为长期）
            <input
              type="datetime-local"
              aria-label="授权到期时间"
              ref={expiryInput}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const expiresAt = grantExpiry(expiryInput.current?.value ?? "");
                const result = await api(`/v1/claims/${id}/grant`, {
                  address,
                  permission: sharePermission,
                  expiresAt,
                });
                setNotice(
                  result.assetGranted
                    ? `声明和输出素材权限已更新${expiresAt ? "，到期后自动失效" : "（长期）"}`
                    : "声明权限已更新；输出素材须由其所有者另行授权",
                );
              })
            }
          >
            授权访问
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api(`/v1/claims/${id}/revoke`, { address });
                setNotice("声明访问已撤销；素材权限独立管理");
              })
            }
          >
            撤销声明访问
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api(`/v1/assets/${m.core.assetDigest}/revoke`, {
                  address,
                });
                setNotice("输出素材的阅读和编辑权限已撤销；已下载内容无法收回");
              })
            }
          >
            撤销素材访问
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={async () => {
              if (
                await requestConsent("撤回后在线验证将拒绝此声明，确认撤回？")
              )
                void act(() => withdrawClaim(id));
            }}
          >
            撤回声明
          </button>
        </div>
      </section>
    </>
  );
}
function Graph() {
  const { id = "" } = useParams(),
    { data, error } = useLoad<any[]>(() => api(`/v1/claims/${id}/graph`), [id]);
  const navigate = useNavigate();
  const levels = new Map<string, number>();
  function level(key: string, depth = 0): number {
    if (depth > 64) return 0;
    if (levels.has(key)) return levels.get(key)!;
    const n = data?.find((n) => n.id === key);
    const result = n?.parents.length
      ? 1 + Math.max(...n.parents.map((p: string) => level(p, depth + 1)))
      : 0;
    levels.set(key, result);
    return result;
  }
  const rows = new Map<number, number>();
  const nodes = (data ?? []).map((n) => {
    const l = level(n.id),
      row = rows.get(l) ?? 0;
    rows.set(l, row + 1);
    return {
      id: n.id,
      position: { x: l * 310, y: row * 145 },
      data: {
        label: (
          <div>
            <strong>
              {n.missing ? "证据缺失" : operations[n.core.operation]}
            </strong>
            <p>{short(n.id)}</p>
            <small>{n.missing ? "不可验证" : "签署的来源关系"}</small>
          </div>
        ),
      },
      style: {
        border: n.missing ? "1px dashed #c77733" : "1px solid #aec7bf",
        background: "#fff",
        borderRadius: 12,
        width: 240,
        padding: 14,
      },
    };
  });
  const edges = (data ?? []).flatMap((n) =>
    n.parents.map((p: string, i: number) => ({
      id: `${p}-${n.id}-${i}`,
      source: p,
      target: n.id,
      label: `输入 ${i + 1}`,
      style: { stroke: "#688b80" },
    })),
  );
  return (
    <>
      <Head eyebrow="PROVENANCE / 来源图" title="从来源，到每一个版本。">
        <Link to={`/claims/${id}`}>返回声明 →</Link>
      </Head>
      <Notice error={error} />
      <div className="graph">
        <React.Suspense fallback={<p>正在加载来源图…</p>}>
          <GraphCanvas
            nodes={nodes}
            edges={edges}
            onOpen={(nodeId) => navigate(`/claims/${nodeId}`)}
          />
        </React.Suspense>
      </div>
      <p className="muted">
        箭头按签署的输入顺序连接。双击节点查看声明。来源关系是签署声明，不等于对现实事件真实性背书。
      </p>
    </>
  );
}
function Disclosure() {
  const { id = "" } = useParams(),
    { data, error } = useLoad(() => api(`/v1/claims/${id}`), [id]);
  const controller = useRef<AbortController | null>(null);
  const [exportJob, setExportJob] = useState<any>();
  const [exportNotice, setExportNotice] = useState("");
  const [hidden, setHidden] = useState<string[]>([]),
    [parents, setParents] = useState<number[]>([]),
    [busy, setBusy] = useState(false),
    [err, setErr] = useState("");
  const toggle = <T,>(value: T, values: T[], set: (v: T[]) => void) =>
    set(
      values.includes(value)
        ? values.filter((x) => x !== value)
        : [...values, value],
    );
  return (
    <>
      <Head
        eyebrow="DISCLOSURE / 选择性披露"
        title="公开依据，保留必要隐私。"
      />
      <Notice error={error || err} />
      <div className="two-col">
        <section className="panel">
          <h2>隐藏哪些字段？</h2>
          <p>勾选后不导出字段原文及对应盐值，保留其承诺。</p>
          {data?.fields.map((path: string) => (
            <label className="check" key={path}>
              <input
                type="checkbox"
                checked={hidden.includes(path)}
                onChange={() => toggle(path, hidden, setHidden)}
              />
              <span>{path}</span>
              <Badge value={hidden.includes(path) ? "partial" : "complete"} />
            </label>
          ))}
          <h2>隐藏哪些父素材？</h2>
          {data?.manifest.disclosure.parents.map((p: any) => (
            <label className="check" key={p.index}>
              <input
                type="checkbox"
                checked={parents.includes(p.index)}
                onChange={() => toggle(p.index, parents, setParents)}
              />
              <span>
                输入 {p.index + 1} · {short(p.parent?.claimId)}
              </span>
            </label>
          ))}
          {data?.manifest.core.parentCount === 0 && (
            <p className="muted">导入声明没有父素材。</p>
          )}
        </section>
        <section className="panel explanatory">
          <div className="eyebrow">DISCLOSURE PREVIEW</div>
          <h2>
            {hidden.length + parents.length
              ? "部分证据将被隐藏"
              : "当前为完整披露"}
          </h2>
          <p>
            隐藏 {hidden.length} 类字段，隐藏 {parents.length}{" "}
            个当前声明的父槽位。字段隐藏规则会应用到已导出的全部上游声明。
          </p>
          <p>
            仍会公开：文件摘要、签名者地址、操作类型、字段数量、父节点数量与承诺。隐藏操作参数后将无法独立复算。
          </p>
          <Badge
            value={hidden.length + parents.length ? "partial" : "complete"}
          />
          <button
            disabled={busy || !data}
            onClick={async () => {
              setBusy(true);
              setErr("");
              controller.current = new AbortController();
              try {
                download(
                  await downloadBundle(
                    id,
                    hidden,
                    parents,
                    setExportJob,
                    controller.current.signal,
                  ),
                  `contentproof-${id.slice(2, 10)}.zip`,
                );
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy
              ? `构建证据包 ${exportJob?.progress ?? 0}%…`
              : "导出真实证据包 ↓"}
          </button>
          {busy && (
            <button
              className="secondary"
              onClick={() => controller.current?.abort()}
            >
              取消导出
            </button>
          )}
          {exportJob?.state === "completed" && (
            <button
              className="secondary"
              onClick={async () => {
                try {
                  const link = await api(
                    `/v1/exports/${exportJob.id}/link`,
                    {},
                  );
                  await navigator.clipboard.writeText(
                    new URL(link.url, location.origin).href,
                  );
                  setExportNotice(
                    "下载链接已复制，5分钟内有效；取消任务会撤销链接。",
                  );
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              复制临时下载链接
            </button>
          )}
          {exportJob?.state === "completed" && (
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await api(`/v1/exports/${exportJob.id}/cancel`, {});
                  sessionStorage.removeItem(`cp-export:${id}`);
                  setExportJob({ ...exportJob, state: "cancelled" });
                  setExportNotice("此导出及其下载链接已撤销，可重新导出。");
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              撤销此导出和链接
            </button>
          )}
          {exportNotice && <p role="status">{exportNotice}</p>}
          <small>
            被隐藏的父素材不随其隐藏路径导出；如果该素材同时由其他公开路径引用，它仍会作为公开来源出现。
          </small>
        </section>
      </div>
    </>
  );
}
function ReportView({ report: r }: { report: any }) {
  const labels: Record<string, string> = {
    file: "文件字节",
    signature: "声明签名",
    anchor: "链上登记",
    identity: "密钥状态",
    disclosure: "披露完整性",
    ancestry: "来源覆盖",
    transformation: "操作复算",
  };
  return (
    <section className="panel report">
      <div className="section-title">
        <h2>验证结果</h2>
        <Badge value={r.outcome} />
      </div>
      <p className="mono">{r.claimId}</p>
      <div className="check-grid">
        {Object.entries(r.checks).map(([k, v]) => (
          <div key={k}>
            <span>{labels[k]}</span>
            <Badge value={v as string} />
          </div>
        ))}
      </div>
      <p>
        遍历 {r.graph.nodes} 个声明 · 公开 {r.graph.disclosedSlots}/
        {r.graph.declaredSlots} 个来源槽位 · 隐藏 {r.graph.withheldSlots} · 缺失{" "}
        {r.graph.missingSlots}
      </p>
      {r.reasons.length > 0 && (
        <details open>
          <summary>检查理由（{r.reasons.length}）</summary>
          <ul>
            {r.reasons.map((x: any, i: number) => (
              <li key={i}>
                <code>{x.code}</code> · {x.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <button
        className="secondary"
        onClick={() =>
          download(
            new Blob([JSON.stringify(r, null, 2)], {
              type: "application/json",
            }),
            "verification-report.json",
          )
        }
      >
        下载报告 JSON ↓
      </button>
    </section>
  );
}
function Verify() {
  const [report, setReport] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function check(file?: File) {
    if (!file) return;
    setBusy(true);
    setReport(undefined);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      setReport(await api("/v1/verify", form));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Head eyebrow="VERIFY / 证据验证" title="让验证，发生在信任之前。" />
      <p className="lead">
        上传证据包，重新计算文件指纹、签名、承诺和编辑输出，并读取链上当前状态。
      </p>
      <label className="dropzone">
        <input
          aria-label="上传证据包"
          type="file"
          accept=".zip"
          disabled={busy}
          onChange={(e) => void check(e.target.files?.[0])}
        />
        <strong>
          {busy ? "正在执行实际校验…" : "◎ 选择 ZIP 证据包，开始验证"}
        </strong>
        <span>最大128MB · 不信任包中预置的验证结论</span>
      </label>
      <Notice error={error} />
      {report && <ReportView report={report} />}
      <NativeC2paVerify />
      <section className="panel">
        <h2>也可以离开业务服务验证</h2>
        <code className="command">
          npm run verify -- verify evidence.zip --json
        </code>
        <p>
          独立CLI不调用本业务API。离线模式仍检查密码学证据，并明确标注未查询最新链上状态。
        </p>
        <code className="command">
          npm run verify -- verify evidence.zip --offline --json
        </code>
      </section>
    </>
  );
}
function NativeC2paVerify() {
  const status = useLoad<{
    available: boolean;
    version: string;
    reason: string | null;
  }>(() => api("/v1/verify/c2pa/status"));
  const [report, setReport] =
      useState<import("../../../packages/c2pa/report.js").C2paReport>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function check(file?: File) {
    if (!file) return;
    setReport(undefined);
    setError("");
    if (file.size > 20 * 1024 * 1024) {
      setError("原生凭证验证的文件上限为20MB");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      setReport(await api("/v1/verify/c2pa", form));
    } catch (e) {
      const code = (e as Error).message;
      setError(
        (
          {
            C2PA_MEDIA_UNSUPPORTED: "当前仅支持PNG、JPEG、WAV和MP4文件",
            C2PA_ASSET_UNREADABLE:
              "无法读取此文件的凭证，文件可能损坏或格式不受支持",
            C2PA_VERIFIER_TIMEOUT: "验证超时，请尝试较小文件",
            C2PA_REPORT_INVALID: "验证器返回的证据不完整，未确认通过",
            C2PA_RUNTIME_INCOMPATIBLE: "本机验证器无法启动，请联系部署管理员",
            C2PA_ASSET_SIZE_LIMIT: "文件超出20MB上限",
            RESOURCE_BUSY: "验证任务繁忙，请稍后重试",
          } as Record<string, string>
        )[code] ?? code,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>原生 C2PA 内容凭证</h2>
      <p>
        检查文件内嵌的内容凭证、签名和文件绑定。支持PNG、JPEG、WAV、MP4，上限20MB。此处的证书身份独立于本系统的钱包身份。
      </p>
      {status.data?.available ? (
        <label className="dropzone">
          <input
            aria-label="上传原生C2PA文件"
            type="file"
            accept=".png,.jpg,.jpeg,.wav,.mp4"
            disabled={busy}
            onChange={(e) => void check(e.target.files?.[0])}
          />
          <strong>
            {busy ? "正在检查内容凭证…" : "选择文件，验证内嵌凭证"}
          </strong>
          <span>文件仅用于本次验证，不写入素材库</span>
        </label>
      ) : (
        <p role="status">
          {status.error
            ? "无法读取验证器状态，请稍后重试。"
            : status.data
              ? "本机尚未就绪，请由部署管理员安装或修复原生验证器。"
              : "正在检查验证器…"}
        </p>
      )}
      <Notice error={error} />
      {report && (
        <div aria-live="polite">
          <h3>
            {report.outcome === "pass"
              ? "本地信任策略通过（离线）"
              : report.outcome === "fail"
                ? "凭证校验未通过"
                : "凭证或信任证据不足"}
          </h3>
          <dl>
            <dt>文件完整性</dt>
            <dd>
              {report.integrity === "valid"
                ? "签名及文件绑定有效"
                : report.integrity === "invalid"
                  ? "存在验证失败，请勿据此信任文件"
                  : "尚不能确认"}
            </dd>
            <dt>签署证书</dt>
            <dd>
              {
                {
                  "operator-trusted": "符合本机配置的证书信任策略",
                  untrusted: "不在本机信任范围",
                  "not-configured": "尚未配置证书信任策略",
                  unknown: "尚不能确认",
                }[report.trust]
              }
            </dd>
            <dt>签署者（证书自述）</dt>
            <dd>{report.signer?.commonName || "未读取到"}</dd>
            <dt>文件指纹</dt>
            <dd className="mono">{report.sha256}</dd>
          </dl>
          <p>
            本次仅检查内嵌凭证，不下载远程清单，不查询证书的最新吊销状态，也不验证附加身份声明。通过结果只适用于上述离线范围。
          </p>
          {report.findings.some((x) => x.severity !== "success") && (
            <details>
              <summary>查看验证发现</summary>
              <ul>
                {report.findings
                  .filter((x) => x.severity !== "success")
                  .map((x, i) => (
                    <li key={i}>{x.code}</li>
                  ))}
              </ul>
            </details>
          )}
          <button
            className="secondary"
            onClick={() =>
              download(
                new Blob([JSON.stringify(report, null, 2)], {
                  type: "application/json",
                }),
                "c2pa-verification.json",
              )
            }
          >
            下载原生凭证报告
          </button>
        </div>
      )}
      <p>
        可信来源需由管理员配置证书信任策略；本系统不会自动信任文件携带的证书。
      </p>
    </section>
  );
}
function Identities() {
  const profile = useLoad(() => api("/v1/profile")),
    keys = useLoad<any[]>(() => api("/v1/keys")),
    audit = useLoad<any[]>(() => api("/v1/audit"));
  const [error, setError] = useState(""),
    [epoch, setEpoch] = useState("2"),
    [signerAddress, setSignerAddress] = useState(signingAddress() ?? ""),
    [keyPassword, setKeyPassword] = useState(""),
    [keyVault, setKeyVault] = useState(""),
    [busy, setBusy] = useState(false);
  async function action(action: string) {
    setBusy(true);
    setError("");
    try {
      if (
        !(await requestConsent(
          `确认${action}密钥世代 ${epoch}？签名地址 ${signerAddress}。撤销不可恢复。`,
        ))
      )
        return;
      const c = await api("/v1/keys/challenge", {
        action,
        epoch,
        signer: signerAddress,
      });
      await api("/v1/keys/action", {
        id: c.id,
        signature: await signText(c.message),
      });
      keys.load();
      profile.load();
      audit.load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Head
        eyebrow="IDENTITY / 身份与密钥"
        title="使用自己的密钥，对声明负责。"
      />
      <Notice error={error || keys.error || profile.error} />
      <section className="panel">
        <h2>{profile.data?.profile?.name ?? "当前身份"}</h2>
        <button
          className="secondary"
          onClick={async () => {
            try {
              await confirmSigningNetwork(await api("/v1/chain/status"), true);
              setError("");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          核对并重新确认登记网络
        </button>
        <p className="mono">{profile.data?.address}</p>
        <p>
          机构名称为自述。此系统当前允许本机自助登记，不把钱包地址当作第三方资质认证。
        </p>
        <button
          className="secondary"
          onClick={() => {
            const v = vaults().find(
              (v) =>
                v.address.toLowerCase() === profile.data?.address.toLowerCase(),
            );
            if (v)
              download(
                new Blob([JSON.stringify(v)], { type: "application/json" }),
                "contentproof-identity.encrypted.json",
              );
            else setError("外部钱包请使用钱包自身的备份功能");
          }}
        >
          导出本机加密备份
        </button>
      </section>
      <section className="panel form">
        <h2>密钥世代管理</h2>
        <label>
          签名密钥解锁口令
          <input
            type="password"
            value={keyPassword}
            onChange={(e) => setKeyPassword(e.target.value)}
            placeholder="新建至少12位；只在浏览器使用"
          />
        </label>
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            try {
              const v = await createVault(
                `声明签名密钥 ${epoch}`,
                keyPassword,
                false,
              );
              setSignerAddress(v.address);
              setKeyVault(v.address);
              setKeyPassword("");
              download(
                new Blob([JSON.stringify(v)], { type: "application/json" }),
                "contentproof-signing-key.encrypted.json",
              );
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          生成独立签名密钥并导出加密备份
        </button>
        <label>
          解锁已有声明签名密钥
          <select
            value={keyVault}
            onChange={(e) => setKeyVault(e.target.value)}
          >
            <option value="">选择本机加密密钥</option>
            {vaults().map((v) => (
              <option value={v.address} key={v.address}>
                {v.name} · {short(v.address)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            try {
              const v = vaults().find((v) => v.address === keyVault);
              if (!v) throw Error("请选择密钥");
              await unlockVault(v, keyPassword, false);
              setSignerAddress(v.address);
              setKeyPassword("");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          解锁为当前声明签名密钥
        </button>
        <label>
          世代编号
          <input value={epoch} onChange={(e) => setEpoch(e.target.value)} />
        </label>
        <label>
          新签名地址
          <input
            value={signerAddress}
            onChange={(e) => setSignerAddress(e.target.value)}
          />
        </label>
        <div className="actions">
          <button disabled={busy} onClick={() => void action("authorize")}>
            授权新世代
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void action("retire")}
          >
            停用世代
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => void action("revoke")}
          >
            撤销世代
          </button>
        </div>
        <p>
          当前默认签署世代：{profile.data?.profile?.epoch}
          。若授权另一地址，签署声明时必须持有对应地址的私钥或通过该外部钱包签名。
        </p>
        {keys.data?.map((k) => (
          <div className="mono" key={k.epoch}>
            epoch {k.epoch}: {JSON.stringify(k.record)}
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>我的操作审计</h2>
        {audit.data?.map((a, i) => (
          <p key={i}>
            {a.created} · {a.action} · {short(a.objectId)}
          </p>
        ))}
      </section>
    </>
  );
}
async function withdrawClaim(id: string) {
  const claim = await api(`/v1/claims/${id}`);
  const deadline = String(Math.floor(Date.now() / 1000) + 300);
  const signature = await signTyped({
    domain: claim.manifest.domain,
    types: {
      Withdrawal: [
        { name: "claimId", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Withdrawal",
    message: { claimId: id, deadline },
  });
  return api(`/v1/claims/${id}/withdraw`, { deadline, signature });
}
function Demo() {
  const { data, error } = useLoad<Claim[]>(() => api("/v1/claims"));
  const [target, setTarget] = useState(""),
    [report, setReport] = useState<any>(),
    [busy, setBusy] = useState(false),
    [err, setErr] = useState("");
  async function run(mode: string) {
    setBusy(true);
    setErr("");
    try {
      const id = target || data?.[0]?.id;
      if (!id) throw Error("请先在素材库上传文件并创建自己的声明");
      const blob = await downloadBundle(
        id,
        mode === "hide-field" ? ["title", "ai.prompt"] : [],
        mode === "hide-parent" ? [0] : [],
      );
      const form = new FormData();
      form.append("file", blob, "evidence.zip");
      if (mode === "tamper") {
        download(blob, "original-evidence.zip");
        throw Error(
          "为避免浏览器引入另一套ZIP解析器，请使用 npm run test:e2e 自动构造并验证文件篡改、父节点替换和字段删改；原证据包已下载。",
        );
      }
      setReport(await api("/v1/verify", form));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Head eyebrow="LAB / 可复现实验" title="检验边界，而非展示结论。" />
      <section className="panel">
        <label>
          选择实际声明
          <select
            value={target || data?.[0]?.id || ""}
            onChange={(e) => setTarget(e.target.value)}
          >
            {data?.map((c) => (
              <option key={c.id} value={c.id}>
                {operations[c.core.operation]} · {short(c.id)}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button disabled={busy} onClick={() => void run("normal")}>
            验证原始证据
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void run("hide-field")}
          >
            隐藏字段后验证
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void run("hide-parent")}
          >
            隐藏父素材后验证
          </button>
        </div>
        <p>
          这些按钮使用数据库中的实际声明生成新证据包，结果来自真实验证。文件篡改、关系替换等攻击由自动化实验脚本执行。
        </p>
        <code className="command">npm run test:e2e</code>
        <code className="command">npm run bench</code>
      </section>
      <Notice error={err || error} />
      {busy && <p role="status">正在构造并检查证据…</p>}
      {report && <ReportView report={report} />}
    </>
  );
}
class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="notice">
        页面出现异常。
        <button onClick={() => location.reload()}>重新加载</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <Boundary>
    <BrowserRouter>
      <ConsentHost />
      <App />
    </BrowserRouter>
  </Boundary>,
);
