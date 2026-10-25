import React, { useState } from "react";
import { api, download } from "./api";
import { requestConsent } from "./consent-store";
import {
  vaults,
  createVault,
  unlockVault,
  importVault,
  connectExternal,
  signText,
  signingAddress,
  type Vault,
} from "./wallet";
export function AccountGate({ onReady }: { onReady: () => void }) {
  const [list, setList] = useState(vaults()),
    [selected, setSelected] = useState(vaults()[0]?.address ?? ""),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [showPassword, setShowPassword] = useState(false),
    [create, setCreate] = useState(!vaults().length),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function login(mode: "local" | "external") {
    setShowPassword(false);
    setBusy(true);
    setError("");
    try {
      let label = name;
      if (mode === "external") await connectExternal();
      else if (create) {
        const v = await createVault(name, password);
        setList(vaults());
        setSelected(v.address);
        setCreate(false);
        label = v.name;
        const exportBackup = await requestConsent(
          "身份已在本机加密保存。是否立即下载加密备份？口令遗失无法恢复私钥。",
        );
        if (exportBackup)
          download(
            new Blob([JSON.stringify(v)], { type: "application/json" }),
            "contentproof-identity.encrypted.json",
          );
      } else {
        const v = list.find((v) => v.address === selected);
        if (!v) throw Error("请选择身份");
        await unlockVault(v, password);
        label = v.name;
      }
      const address = signingAddress();
      if (!address) throw Error("请先解锁签名身份");
      const challenge = await api("/v1/auth/challenge", {
        address,
      });
      const session = await api("/v1/auth/verify", {
        id: challenge.id,
        signature: await signText(challenge.message),
      });
      sessionStorage.setItem("cp-token", session.token);
      const current = await api("/v1/profile");
      if (!current.profile) {
        if ((label ?? "").trim().length < 2)
          throw Error("请填写至少2字的显示名称后重新连接");
        await api("/v1/profile", { name: label });
      }
      if (signingAddress()?.toLowerCase() !== address.toLowerCase())
        throw Error("身份状态已改变，请重新登录");
      setPassword("");
      onReady();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="login" aria-labelledby="login-title">
      <div className="eyebrow">WELCOME / 身份登录</div>
      <h1 id="login-title">登录内容证链</h1>
      <p className="login-description">
        解锁你的签名身份，进入内容证据工作空间。
      </p>
      <form
        className="panel form"
        onSubmit={(e) => {
          e.preventDefault();
          void login("local");
        }}
      >
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            className={create ? "" : "secondary"}
            onClick={() => {
              setShowPassword(false);
              setCreate(true);
            }}
          >
            创建身份
          </button>
          <button
            type="button"
            disabled={busy}
            className={!create ? "" : "secondary"}
            onClick={() => {
              setShowPassword(false);
              setCreate(false);
            }}
          >
            解锁已有身份
          </button>
        </div>
        {create ? (
          <label>
            显示名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              minLength={2}
              maxLength={80}
              required
              disabled={busy}
              autoComplete="nickname"
              placeholder="个人或机构自述名称"
            />
          </label>
        ) : (
          <label>
            本机身份
            <select
              disabled={busy}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {list.map((v) => (
                <option key={v.address} value={v.address}>
                  {v.name} · {v.address.slice(0, 10)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="password-field">
          <label htmlFor="login-password">本机解锁口令</label>
          <div className="password-control">
            <input
              id="login-password"
              type={showPassword ? "text" : "password"}
              required
              minLength={create ? 12 : undefined}
              disabled={busy}
              autoComplete={create ? "new-password" : "current-password"}
              autoCapitalize="none"
              spellCheck={false}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                create
                  ? "至少12位，遗失无法恢复"
                  : "仅在本机解密，不发送到服务端"
              }
            />
            <button
              type="button"
              className="secondary"
              disabled={busy}
              aria-label={showPassword ? "隐藏口令" : "显示口令"}
              aria-pressed={showPassword}
              aria-controls="login-password"
              onClick={() => setShowPassword((shown) => !shown)}
            >
              {showPassword ? "隐藏" : "显示"}
            </button>
          </div>
        </div>
        {error && (
          <div className="notice" role="alert">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={busy || (create && name.trim().length < 2)}
        >
          {busy
            ? "正在验证身份与登记…"
            : create
              ? "创建并登录 →"
              : "解锁并登录 →"}
        </button>
        <label>
          恢复加密备份
          <input
            type="file"
            disabled={busy}
            accept=".json"
            onChange={async (e) => {
              try {
                const f = e.target.files?.[0];
                if (!f || f.size > 8192) throw Error("备份文件过大");
                const v = importVault(await f.text());
                setList(vaults());
                setSelected(v.address);
                setCreate(false);
                setShowPassword(false);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void login("external")}
        >
          连接外部钱包
        </button>
        <small>
          私钥在浏览器生成，使用口令加密后保存在本机。名称为用户自述，不代表第三方机构认证。请下载加密备份并妥善保管口令。
        </small>
      </form>
    </section>
  );
}
