import { Link } from "react-router-dom";
import { AccountGate } from "./AccountGate";
export function LoginScreen({ onReady }: { onReady: () => void }) {
  return (
    <div className="login-screen" data-consent-background>
      <header className="login-header">
        <Link className="brand" to="/login" aria-label="内容证链登录页">
          <span className="brand-mark">证</span>
          <span>
            内容证链<small>CONTENTPROOF</small>
          </span>
        </Link>
        <span className="login-header-note">来源有据，隐私有界。</span>
      </header>
      <main className="login-content">
        <section className="login-intro" aria-label="内容证链介绍">
          <div className="eyebrow">CONTENT · IDENTITY · PROVENANCE</div>
          <h2>
            每一份内容，
            <br />
            都有可验证的来处。
          </h2>
          <p>
            从自己的签名身份出发，记录内容的创作与流转，让来源可追溯，让证据可核验。
          </p>
          <ul className="login-features">
            <li>
              <span>01</span>
              <div>
                <strong>为内容署名</strong>
                <p>签名绑定文件与声明，留下可核对的记录。</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>保留流转证据</strong>
                <p>连接原始素材与编辑步骤，查看内容来源。</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>按需分享与核验</strong>
                <p>自主选择披露范围，导出证据进行独立验证。</p>
              </div>
            </li>
          </ul>
        </section>
        <AccountGate onReady={onReady} />
      </main>
      <footer className="login-footer">
        ContentProof · 内容证链
        <span>签名证明声明来源，不证明内容符合事实。</span>
      </footer>
    </div>
  );
}
