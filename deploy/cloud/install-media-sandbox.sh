#!/usr/bin/env bash
# Root-only provisioning from an already validated, root-owned release.
set -euo pipefail
umask 077
release="$(realpath "${1:?validated release directory required}")"
hash="${2:?source SHA256 required}"
[[ "$(id -u)" -eq 0 && "$release" == /opt/contentproof/releases/* && "$hash" =~ ^[a-f0-9]{64}$ ]] || exit 2
python3 - "$release" "$hash" <<'PY'
import pathlib,json,sys
p=pathlib.Path(sys.argv[1]);provenance=json.loads((p/'PROVENANCE.json').read_text())
assert p.stat().st_uid==0 and not p.stat().st_mode & 0o022
assert provenance['sourceSha256']==sys.argv[2] and provenance['historicalMedia']['passed'] and provenance['realChainIntegration']['passed']
PY
if ! getent passwd contentproof-media >/dev/null; then useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin contentproof-media; fi
target="/opt/contentproof-media/releases/${hash:0:16}"
[[ ! -e "$target" ]] || { echo 'Sandbox release already exists; inspect before reuse'; exit 2; }
if systemctl is-active --quiet contentproof-media.service; then echo 'Stop application and sandbox in maintenance before replacing an active sandbox'; exit 2; fi
install -d -m 0755 /opt/contentproof-media /opt/contentproof-media/releases "$target/bridge/scripts" "$target/bridge/packages/media" "$target/bridge/node_modules" "$target/runtime/bin"
cp "$release/runtime/bin/node" "$target/runtime/bin/node"
cp "$release/app/dist/server/scripts/media-sandbox.js" "$target/bridge/scripts/"
for name in sandbox-service sandbox-wire archives process-jobs worker-environment resources; do
  cp "$release/app/dist/server/packages/media/$name.js" "$target/bridge/packages/media/"
done
cp -a "$release/app/node_modules/zod" "$target/bridge/node_modules/"
printf '{"type":"module","private":true}\n' > "$target/bridge/package.json"
cp -a "$release/app/data/media-engines" "$target/engines"
printf '%s\n' "$hash" > "$target/SOURCE_SHA256"
chown -R root:contentproof-media "$target"
chmod -R g+rX,o-rwx "$target"
chmod 0550 "$target/runtime/bin/node"
ln -sfn "$target" /opt/contentproof-media/current
install -m 0644 "$release/app/deploy/cloud/contentproof-media.socket" /etc/systemd/system/contentproof-media.socket
install -m 0644 "$release/app/deploy/cloud/contentproof-media.service" /etc/systemd/system/contentproof-media.service
systemd-analyze verify /etc/systemd/system/contentproof-media.socket /etc/systemd/system/contentproof-media.service
systemctl daemon-reload
systemctl enable --now contentproof-media.socket
echo 'Sandbox socket ready; application configuration has not been switched.'
