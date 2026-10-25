import { z } from "zod";
import type { Manifest } from "./index.js";
export const policySchema = z
  .object({
    chainId: z.number().int().positive().optional(),
    verifyingContract: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    trustedIssuers: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).optional(),
  })
  .strict();
export type VerificationPolicy = z.infer<typeof policySchema>;
export function checkPolicy(m: Manifest, p: VerificationPolicy): boolean {
  return !(
    (p.chainId !== undefined && m.domain.chainId !== p.chainId) ||
    (p.verifyingContract &&
      p.verifyingContract.toLowerCase() !==
        m.domain.verifyingContract.toLowerCase()) ||
    (p.trustedIssuers &&
      !p.trustedIssuers.some(
        (a) => a.toLowerCase() === m.core.issuer.toLowerCase(),
      ))
  );
}
