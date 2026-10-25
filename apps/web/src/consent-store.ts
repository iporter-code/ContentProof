type Consent = { id: number; message: string };
let current: Consent | null = null;
let resolve: ((accepted: boolean) => void) | undefined;
let sequence = 0;
const listeners = new Set<() => void>();
export const consentSnapshot = () => current;
export function subscribeConsent(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function requestConsent(message: string): Promise<boolean> {
  // A second operation must never replace the content currently being reviewed.
  if (current) return Promise.resolve(false);
  return new Promise((done) => {
    resolve = done;
    current = { id: ++sequence, message };
    listeners.forEach((listener) => listener());
  });
}
export function settleConsent(id: number, accepted: boolean) {
  if (current?.id !== id) return;
  const done = resolve;
  current = null;
  resolve = undefined;
  listeners.forEach((listener) => listener());
  done?.(accepted);
}
export function cancelConsent() {
  if (current) settleConsent(current.id, false);
}
