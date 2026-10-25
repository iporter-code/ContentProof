import { useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import {
  cancelConsent,
  consentSnapshot,
  settleConsent,
  subscribeConsent,
} from "./consent-store";

export function ConsentHost() {
  const pending = useSyncExternalStore(subscribeConsent, consentSnapshot);
  const panel = useRef<HTMLDivElement>(null);
  const location = useLocation();
  useEffect(() => {
    cancelConsent();
  }, [location.key]);
  useEffect(() => {
    window.addEventListener("cp-locked", cancelConsent);
    window.addEventListener("cp-session-expired", cancelConsent);
    window.addEventListener("pagehide", cancelConsent);
    return () => {
      window.removeEventListener("cp-locked", cancelConsent);
      window.removeEventListener("cp-session-expired", cancelConsent);
      window.removeEventListener("pagehide", cancelConsent);
      cancelConsent();
    };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const previous = document.activeElement;
    const shell = document.querySelector<HTMLElement>(".shell");
    const wasInert = shell?.inert;
    if (shell) shell.inert = true;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (shell) shell.inert = wasInert ?? false;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [pending?.id]);
  if (!pending) return null;
  return (
    <div className="consent-backdrop">
      <div
        ref={panel}
        className="panel consent-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-title"
        aria-describedby="consent-message"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            settleConsent(pending.id, false);
          }
          if (event.key === "Tab") {
            const buttons = panel.current?.querySelectorAll("button");
            if (!buttons?.length) return;
            const first = buttons[0],
              last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2 id="consent-title">请核对并确认</h2>
        <p id="consent-message" className="consent-message">
          {pending.message}
        </p>
        <div className="actions">
          <button
            className="secondary"
            onClick={() => settleConsent(pending.id, false)}
          >
            取消
          </button>
          <button onClick={() => settleConsent(pending.id, true)}>
            确认并继续
          </button>
        </div>
      </div>
    </div>
  );
}
