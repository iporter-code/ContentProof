#!/usr/bin/env bash
set -euo pipefail
umask 077
release="$(realpath "${1:?validated app release required}")"
[[ "$(id -u)" -eq 0 && "$release" == /opt/contentproof/releases/* ]] || exit 2
base="/opt/contentproof-media/check-$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$base" ]] || exit 2
for unit in contentproof-media-check.service contentproof-media-check.socket; do
  if systemctl is-active --quiet "$unit"; then echo 'Existing sandbox check requires review'; exit 2; fi
done
install -d -m 0750 "$base/engine"
cp "$release/app/deploy/cloud/media-sandbox-check.cjs" "$base/engine/worker.cjs"
CP_CHECK_ROOT="$base" "$release/runtime/bin/node" --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';import{createHash}from'node:crypto';
const root=process.env.CP_CHECK_ROOT,sha=b=>createHash('sha256').update(b).digest('hex'),id='0x'+'fa'.repeat(32);
const desc={version:1,engineDigest:id,platform:process.platform,arch:process.arch,worker:'worker.cjs',versions:{fixture:'OS isolation only'},files:{'worker.cjs':sha(readFileSync(root+'/engine/worker.cjs'))}};
writeFileSync(root+'/engine/engine.json',JSON.stringify(desc));
writeFileSync(root+'/catalog.json',JSON.stringify({version:1,engines:[{engineDigest:id,directory:'engine',descriptorSha256:sha(readFileSync(root+'/engine/engine.json'))}]}));
JS
chown -R root:contentproof-media "$base"; chmod -R g+rX,o-rwx "$base"
python3 - "$base" <<'PY'
import pathlib,sys
root=pathlib.Path(sys.argv[1])
service=pathlib.Path('/etc/systemd/system/contentproof-media.service').read_text().replace('contentproof-media.socket','contentproof-media-check.socket').replace('/opt/contentproof-media/current/engines/catalog.json',str(root/'catalog.json'))
socket=pathlib.Path('/etc/systemd/system/contentproof-media.socket').read_text().replace('/run/contentproof-media/sandbox.sock','/run/contentproof-media-check/sandbox.sock')
pathlib.Path('/run/systemd/system/contentproof-media-check.service').write_text(service)
pathlib.Path('/run/systemd/system/contentproof-media-check.socket').write_text(socket)
PY
cleanup() { systemctl stop contentproof-media-check.socket contentproof-media-check.service; }
trap cleanup EXIT
systemctl daemon-reload
systemctl start contentproof-media-check.socket
CP_APP_RELEASE="$release" CP_CHECK_REPORT="$base/report.json" "$release/runtime/bin/node" --input-type=module <<'JS'
import assert from 'node:assert/strict';import{writeFileSync}from'node:fs';import{pathToFileURL}from'node:url';
const{sandboxRequest}=await import(pathToFileURL(process.env.CP_APP_RELEASE+'/app/dist/server/packages/media/sandbox-wire.js'));
const path='/run/contentproof-media-check/sandbox.sock',id='0x'+'fa'.repeat(32);
const request=angle=>({version:1,method:'execute',engineDigest:id,operation:'rotate',inputs:[Buffer.from('synthetic').toString('base64')],params:{angle}});
const good=async()=>{const r=await sandboxRequest(path,request(0));assert(r.ok,JSON.stringify(r));const p=JSON.parse(Buffer.from(r.result,'base64'));assert(p.uid>0);for(const name of ['protectedPathsDenied','writeDenied','networkDenied','secretEnvironmentEmpty'])assert.equal(p[name],true,name);return p;};
const probe=await good();const crash=await sandboxRequest(path,request(90));assert.equal(crash.error,'MEDIA_WORKER_CRASH');await good();
const timeout=await sandboxRequest(path,request(180));assert.equal(timeout.error,'MEDIA_WORKER_TIMEOUT');await good();
const report={date:new Date().toISOString(),passed:true,probe,checks:['real worker has dedicated non-root uid and no application secret environment','production config/data and home access rejected','network socket creation and protected-path writes rejected','worker crash contained and next job succeeds','20-second worker timeout contained and next job succeeds'],scope:'Actual Linux sandbox test service with the same systemd protection profile and separate synthetic catalog; no production keys read or test engines added to production catalog.'};
writeFileSync(process.env.CP_CHECK_REPORT,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
JS
systemctl show contentproof-media-check.service -p MemoryPeak -p MemoryMax -p CPUQuotaPerSecUSec -p PrivateNetwork -p RestrictAddressFamilies -p NoNewPrivileges
