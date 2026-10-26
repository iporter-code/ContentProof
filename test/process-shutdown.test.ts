import { it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
it.each(["graceful", "nonzero", "unresponsive"])(
  "observes actual child exit and rejects %s shutdown failures",
  (mode) => {
    mkdirSync("data/test-shutdown", { recursive: true });
    const root = mkdtempSync(resolve("data/test-shutdown/run-")),
      fixture = resolve(root, "child.cjs");
    writeFileSync(
      fixture,
      `process.on('message',()=>{${mode === "unresponsive" ? "" : `process.exit(${mode === "graceful" ? 0 : 7})`}});setInterval(()=>{},1000);process.send('ready');`,
    );
    const helper = pathToFileURL(resolve("scripts/process-shutdown.mjs")).href;
    const code = `import{fork}from'node:child_process';import{once}from'node:events';import{stopOwnedProcess}from${JSON.stringify(helper)};const c=fork(${JSON.stringify(fixture)},[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});await once(c,'message');console.log(JSON.stringify(await stopOwnedProcess(c,'api',{grace:100,terminate:1000,kill:1000})));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(r.status, r.stderr).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.passed).toBe(mode === "graceful");
    expect(result.forced).toBe(mode === "unresponsive");
    if (mode === "nonzero") expect(result.code).toBe(7);
  },
);
