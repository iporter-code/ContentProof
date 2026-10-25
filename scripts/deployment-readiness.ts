import { existsSync, writeFileSync } from "node:fs";
import {
  prepareRecoveryPlan,
  restoreRecoveryPlan,
} from "../packages/operations/disaster-recovery.js";
import { checkProductionVault } from "../packages/operations/vault-readiness.js";
const [command, ...args] = process.argv.slice(2);
try {
  if (command === "prepare-recovery" && args.length === 2)
    console.log(JSON.stringify(await prepareRecoveryPlan(args[0], args[1])));
  else if (command === "restore-recovery" && args.length === 5) {
    if (existsSync(args[4])) throw Error("REPORT_REQUIRES_NEW_FILE");
    const report = await restoreRecoveryPlan(
      args[0],
      args[1],
      args[2],
      args[3],
    );
    writeFileSync(args[4], JSON.stringify(report, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        passed: true,
        restoredFiles: report.restoredFiles,
        seconds: report.seconds,
      }),
    );
  } else if (command === "vault-kv" && args.length === 1) {
    if (existsSync(args[0])) throw Error("REPORT_REQUIRES_NEW_FILE");
    const report = await checkProductionVault(process.env);
    writeFileSync(args[0], JSON.stringify(report, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(JSON.stringify(report));
  } else
    throw Error(
      "USAGE: prepare-recovery backup-dir new-plan | restore-recovery plan backup-dir new-data-dir password-file new-report | vault-kv new-report",
    );
} catch (e) {
  const msg = e instanceof Error ? e.message : "";
  console.error(
    /^[A-Z_]{3,100}$/.test(msg) ? msg : "DEPLOYMENT_READINESS_FAILED",
  );
  process.exitCode = 1;
}
