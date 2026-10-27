import React, { useState, useEffect } from "react";
import { api, download } from "./api";
import { requestConsent } from "./consent-store";
import {
  readVaultState,
  createVault,
  unlockVault,
  importVault,
  parseVaultBackup,
  connectExternal,
  signText,
  signingAddress,
} from "./wallet";
export function AccountGate({ onReady }: { onReady: () => void }) {
  const [stored, setStored] = useState(readVaultState),
    [selected, setSelected] = useState(stored.vaults[0]?.address ?? ""),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [showPassword, setShowPassword] = useState(false),
    [create, setCreate] = useState(!stored.vaults.length),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pendingBackup, setPendingBackup] = useState<{
      text: string;
      vault: ReturnType<typeof parseVaultBackup>;
    } | null>(null);
  const list = stored.vaults;
  function refreshIdentities() {
    const next = readVaultState();
    setStored(next);
    setSelected((current) =>
      next.vaults.some((v) => v.address === current)
        ? current
        : (next.vaults[0]?.address ?? ""),
    );
    if (!stored.vaults.length && next.vaults.length) setCreate(false);
  }
  useEffect(() => {
    const refresh = () => {
      if (!busy) refreshIdentities();
    };
    const changed = (event: StorageEvent) => {
      if (
        event.key === "contentproof-vaults" ||
        event.key?.startsWith("contentproof-vault:") ||
        event.key === null
      )
        refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", changed);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", changed);
    };
  }, [busy, stored]);
  async function login(mode: "local" | "external") {
    setShowPassword(false);
    setBusy(true);
    setError("");
    try {
      let label = name;
      if (mode === "external") await connectExternal();
      else if (pendingBackup) {
        const v = await importVault(pendingBackup.text, password);
        setStored(readVaultState());
        setSelected(v.address);
        setPendingBackup(null);
        setNotice("加密备份已验证并保存，原身份地址不变。");
        await unlockVault(v, password);
        label = v.name;
      } else if (create) {
        const v = await createVault(name, password);
        setStored(readVaultState());
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
              setPendingBackup(null);
              setNotice("");
              setPassword("");
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
              setPendingBackup(null);
              setNotice("");
              setPassword("");
              setCreate(false);
            }}
          >
            解锁已有身份
          </button>
        </div>
        {(stored.issue || !list.length) && (
          <div className="notice neutral" role="status">
            {stored.issue === "unavailable"
              ? "浏览器暂不允许读取本机身份，请检查网站存储权限或退出无痕模式后重试。"
              : stored.issue === "invalid"
                ? "本机身份记录异常，原数据未清除。请保留浏览器数据，并在可正常保存数据的浏览器中恢复加密备份。"
                : "当前浏览器未找到身份。若以前创建过，请使用原浏览器和原网站地址，或在下方恢复加密备份。创建身份会生成新的地址。"}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={refreshIdentities}
            >
              重新检查本机身份
            </button>
          </div>
        )}
        {notice && (
          <div className="notice neutral" role="status">
            {notice}
          </div>
        )}
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
            {pendingBackup ? "备份中的身份（尚未保存）" : "本机身份"}
            <select
              disabled={busy || !!pendingBackup || !list.length}
              value={pendingBackup?.vault.address ?? selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {!pendingBackup && !list.length && (
                <option value="">未找到身份，请恢复加密备份</option>
              )}
              {(pendingBackup ? [pendingBackup.vault] : list).map((v) => (
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
          disabled={
            busy ||
            !!stored.issue ||
            (!pendingBackup && (create ? name.trim().length < 2 : !selected))
          }
        >
          {busy
            ? "正在验证身份与登记…"
            : pendingBackup
              ? "验证备份并登录 →"
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
              const f = e.target.files?.[0];
              if (!f) return;
              setBusy(true);
              setError("");
              setNotice("");
              try {
                if (f.size > 8192)
                  throw Error("身份备份文件过大，请选择原加密身份备份JSON");
                const text = await f.text();
                const v = parseVaultBackup(text);
                setPendingBackup({ text, vault: v });
                setCreate(false);
                setPassword("");
                setShowPassword(false);
                setNotice(
                  "已选择加密备份，请输入该备份的原口令。验证通过前不会保存或覆盖本机身份。",
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
                e.target.value = "";
              }
            }}
          />
        </label>
        {pendingBackup && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setPendingBackup(null);
              setPassword("");
              setNotice("");
              setError("");
              setCreate(!list.length);
            }}
          >
            取消恢复
          </button>
        )}
        <small>
          恢复文件名通常为
          contentproof-identity.encrypted.json；核验报告JSON不能用来恢复身份。
        </small>
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
