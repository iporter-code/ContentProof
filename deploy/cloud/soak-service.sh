#!/usr/bin/env bash
# Dedicated synthetic test only. Never loads the production app.env or data.
set -euo pipefail
umask 077
base=/var/lib/contentproof-tests
action="${1:-status}"
[[ "$(id -u)" -eq 0 ]] || { echo 'Root setup required'; exit 2; }
if [[ "$action" == start ]]; then
  archive="${2:?source ZIP required}"; expected="${3:?SHA256 required}"; seconds="${4:-86400}"
  [[ "$expected" =~ ^[a-f0-9]{64}$ && ( "$seconds" == 90 || "$seconds" == 86400 ) ]] || exit 2
  printf '%s  %s\n' "$expected" "$archive" | sha256sum -c -
  install -d -m 0755 "$base" "$base/runs"
  exec 9>"$base/setup.lock"; flock -n 9
  if [[ -f "$base/latest.json" ]]; then
    unit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["unit"])' "$base/latest.json")"
    [[ "$unit" =~ ^contentproof-soak-[0-9TZ-]+-[a-f0-9]{8}\.service$ ]] || exit 2
    if systemctl is-active --quiet "$unit"; then echo 'A test is already active'; exit 2; fi
  fi
  python3 - <<'PY'
import socket
for port in [3081,8581]:
 with socket.socket() as s:
  s.bind(('127.0.0.1',port))
PY
  if ! getent passwd contentproof-test >/dev/null; then useradd --system --home-dir "$base" --shell /usr/sbin/nologin contentproof-test; fi
  run="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
  dir="$base/runs/$run"; unit="contentproof-soak-$run.service"
  install -d -m 0755 "$dir/app" "$dir/runtime/bin"
  current="$(readlink -f /opt/contentproof/current)"
  [[ "$current" == /opt/contentproof/releases/* ]] || exit 2
  cp "$current/runtime/bin/node" "$dir/runtime/bin/node"
  chmod 0755 "$dir/runtime/bin/node"
  python3 - "$archive" "$dir/app" <<'PY'
import zipfile,sys,pathlib
root=pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as z:
 for info in z.infolist():
  path=pathlib.PurePosixPath(info.filename)
  assert path.parts and path.parts[0]=='app' and '..' not in path.parts and '\\' not in info.filename
  target=(root/pathlib.Path(*path.parts[1:])).resolve()
  assert target.is_relative_to(root)
  if not info.is_dir():target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(z.read(info))
PY
  # Install from the exact lock into this new test directory, with no scripts.
  npm_tool=/home/ecs-user/mobile-npm-10.9.4/package/bin/npm-cli.js
  test -f "$npm_tool"
  (cd "$dir/app"; PATH="$dir/runtime/bin:$PATH" NODE_OPTIONS=--max-old-space-size=256 "$dir/runtime/bin/node" "$npm_tool" ci --omit=dev --ignore-scripts --no-audit --no-fund)
  # Remove CLI aliases by copying the trusted installed tree with dereferencing.
  # Runtime uses compiled Node entry points, never .bin shims.
  (cd "$dir/app"; "$dir/runtime/bin/node" --input-type=module <<'JS'
import {cpSync,renameSync} from 'node:fs';
import {writeSnapshotManifest} from './dist/server/packages/operations/snapshot.js';
renameSync('node_modules','../installed-dependencies');
cpSync('../installed-dependencies','node_modules',{recursive:true,dereference:true,filter:path=>!path.split('/').includes('.bin')});
writeSnapshotManifest(process.cwd());
JS
  )
  chown -R root:contentproof-test "$dir"
  chmod -R g+rX "$dir"
  install -d -m 0750 -o contentproof-test -g contentproof-test "$dir/app/data" "$dir/results"
  reauth=1800; [[ "$seconds" == 90 ]] && reauth=15
  cat > "/run/systemd/system/$unit" <<EOF
[Unit]
Description=ContentProof isolated ${seconds}-second synthetic acceptance
After=network.target
[Service]
Type=exec
User=contentproof-test
Group=contentproof-test
WorkingDirectory=$dir/app
ExecStart=$dir/runtime/bin/node $dir/app/scripts/soak-watchdog.mjs run
ExecStopPost=$dir/runtime/bin/node $dir/app/scripts/soak-watchdog.mjs finalize
Environment=CP_SOAK_SECONDS=$seconds
Environment=CP_SOAK_REPORT=soak
Environment=CP_SOAK_REAUTH_SECONDS=$reauth
Environment=CP_SOAK_SNAPSHOT=required
Environment=CP_RESULTS_DIR=$dir/results
Environment=NODE_OPTIONS=--max-old-space-size=256
Environment=MEDIA_CONCURRENCY=1
Environment=MEDIA_QUEUE_LIMIT=4
Restart=no
RuntimeMaxSec=$((seconds+600))
TimeoutStopSec=75
KillMode=control-group
Nice=10
CPUQuota=50%
# Leave room for the frozen dependency page cache as well as the API/EVM.
# The previous 450M high watermark was reached during concurrent maintenance.
MemoryHigh=550M
MemoryMax=700M
MemorySwapMax=256M
TasksMax=96
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$dir/app/data $dir/results
[Install]
WantedBy=multi-user.target
EOF
  python3 - "$base/latest.json" "$unit" "$dir" "$seconds" "$expected" <<'PY'
import json,sys,datetime,pathlib
pathlib.Path(sys.argv[1]).write_text(json.dumps(dict(date=datetime.datetime.now(datetime.timezone.utc).isoformat(),unit=sys.argv[2],directory=sys.argv[3],targetSeconds=int(sys.argv[4]),sourceSha256=sys.argv[5],scope='Dedicated user, frozen code/dependencies, isolated loopback test chain; no production credentials/data'),indent=2))
PY
  chmod 0644 "$base/latest.json"
  systemctl daemon-reload
  systemctl start "$unit"
  printf 'Started %s\nResults: %s/results\n' "$unit" "$dir"
elif [[ "$action" == status || "$action" == stop ]]; then
  [[ -f "$base/latest.json" ]] || { echo 'No test launched'; exit 0; }
  unit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["unit"])' "$base/latest.json")"
  dir="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["directory"])' "$base/latest.json")"
  [[ "$unit" =~ ^contentproof-soak-[0-9TZ-]+-[a-f0-9]{8}\.service$ && "$dir" == "$base"/runs/* && "$(realpath "$dir")" == "$dir" ]] || exit 2
  if [[ "$action" == stop ]]; then
    [[ ! -f "$dir/results/soak.stop" ]] && install -m 0600 -o contentproof-test -g contentproof-test /dev/null "$dir/results/soak.stop"
    echo 'Graceful stop requested; no PID is killed.'
  fi
  state="$(systemctl show "$unit" -p ActiveState --value 2>/dev/null || true)"
  if [[ "$state" == inactive || "$state" == failed || -z "$state" ]]; then
    seconds="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["targetSeconds"])' "$base/latest.json")"
    CP_RESULTS_DIR="$dir/results" CP_SOAK_REPORT=soak CP_SOAK_SECONDS="$seconds" SERVICE_RESULT="$(systemctl show "$unit" -p Result --value 2>/dev/null || true)" "$dir/runtime/bin/node" "$dir/app/scripts/soak-watchdog.mjs" finalize
  fi
  cat "$base/latest.json"
  systemctl show "$unit" -p ActiveState -p SubState -p Result -p ExecMainStatus -p MemoryPeak
  [[ ! -f "$dir/results/soak-progress.json" ]] || cat "$dir/results/soak-progress.json"
else echo 'Use start, status or stop'; exit 2
fi
