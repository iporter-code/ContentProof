export interface ReleaseSource {
  revision: string | null;
  tree: string | null;
  dirty: boolean | null;
}
export interface ReleaseVerification {
  date: string;
  passed: true;
  files: number;
  bytes: number;
  sha256: string;
  source: ReleaseSource;
  sourceVerified: boolean;
  sourceCoverageVerified: boolean;
  mode: "workspace" | "snapshot";
  checks: string[];
}
export function readReleaseSource(root?: string): ReleaseSource;
export function verifyRelease(
  bytes: Uint8Array,
  root?: string,
  options?: { mode?: "workspace" | "snapshot" },
): ReleaseVerification;
