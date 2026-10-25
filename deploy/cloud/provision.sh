#!/usr/bin/env bash
set -euo pipefail
umask 077
bundle="${1:?bundle path required}"
expected="${2:?SHA256 required}"
endpoint="${3:?public IPv4 required}"
[[ "$expected" =~ ^[a-f0-9]{64}$ ]] || exit 2
python3 -c 'import ipaddress,sys; assert ipaddress.ip_address(sys.argv[1]).version == 4' "$endpoint"
[ "$(id -u)" -eq 0 ] || { echo 'Root deployment required'; exit 2; }
exec 9>/run/lock/contentproof-maintenance.lock
flock -n 9 || { echo 'Maintenance already running'; exit 2; }
printf '%s  %s\n' "$expected" "$bundle" | sha256sum -c -
if ! getent passwd contentproof >/dev/null; then useradd --system --home-dir /var/lib/contentproof --shell /usr/sbin/nologin contentproof; fi
install -d -m 0755 /opt/contentproof/releases
install -d -m 0750 -o contentproof -g contentproof /var/lib/contentproof /var/lib/contentproof/app /var/log/contentproof
install -d -m 0750 -o root -g contentproof /etc/contentproof
release="/opt/contentproof/releases/${expected:0:16}"
[ ! -e "$release" ] || { echo 'Release directory already exists; inspect it before retrying'; exit 2; }
install -d -m 0755 "$release"
tar -tzf "$bundle" | python3 -c 'import sys; paths=sys.stdin.read().splitlines(); assert paths and all(p.startswith("contentproof/") and not p.startswith("/") and ".." not in p.split("/") for p in paths)'
tar -xzf "$bundle" -C "$release" --strip-components=1 --no-same-owner
python3 - "$release" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve()
manifest=json.loads((root/'FILE_HASHES.json').read_text())
for name,digest in manifest.items():
    path=(root/name).resolve()
    assert path.is_relative_to(root) and path.is_file(),name
    assert hashlib.sha256(path.read_bytes()).hexdigest()==digest,name
print('All runtime file checksums verified.')
PY
"$release/runtime/bin/node" --version
if [ ! -f /etc/contentproof/app.env ]; then
  if [ -e /var/lib/contentproof/app/contentproof.sqlite ]; then echo 'Existing store requires configuration and key recovery'; exit 2; fi
  if [ ! -f /etc/contentproof/storage.key ]; then openssl rand -hex 32 > /etc/contentproof/storage.key; fi
fi
if [ -f /etc/contentproof/storage.key ]; then
  chown root:contentproof /etc/contentproof/storage.key
  chmod 0640 /etc/contentproof/storage.key
fi
if [ ! -f /etc/contentproof/backup.password ]; then openssl rand -base64 48 > /etc/contentproof/backup.password; fi
chmod 0600 /etc/contentproof/backup.password
"$release/runtime/bin/node" "$release/app/deploy/cloud/config.mjs" /etc/contentproof/app.env "$endpoint"
chown root:contentproof /etc/contentproof/app.env
chmod 0640 /etc/contentproof/app.env
if [ ! -e /var/swap/contentproof.swap ]; then
  install -d -m 0755 /var/swap
  fallocate -l 2G /var/swap/contentproof.swap
  chmod 0600 /var/swap/contentproof.swap
  mkswap /var/swap/contentproof.swap >/dev/null
fi
if ! swapon --show=NAME --noheadings | grep -qx /var/swap/contentproof.swap; then swapon /var/swap/contentproof.swap; fi
if ! grep -q '^/var/swap/contentproof.swap ' /etc/fstab; then printf '/var/swap/contentproof.swap none swap sw 0 0\n' >> /etc/fstab; fi
if [ -e /opt/contentproof/current ] && [ ! -L /opt/contentproof/current ]; then echo 'Refusing to replace unknown current directory'; exit 2; fi
if systemctl is-active --quiet contentproof.service; then systemctl stop contentproof.service; fi
ln -sfn "$release" /opt/contentproof/current
install -m 0644 "$release/app/deploy/cloud/contentproof.service" /etc/systemd/system/contentproof.service
install -m 0644 "$release/app/deploy/cloud/contentproof-backup.service" /etc/systemd/system/contentproof-backup.service
install -m 0644 "$release/app/deploy/cloud/contentproof-backup.timer" /etc/systemd/system/contentproof-backup.timer
install -m 0700 "$release/app/deploy/cloud/backup.sh" /usr/local/sbin/contentproof-backup
install -m 0700 "$release/app/deploy/cloud/health.sh" /usr/local/sbin/contentproof-health
install -m 0644 "$release/app/deploy/cloud/contentproof-health.service" /etc/systemd/system/contentproof-health.service
install -m 0644 "$release/app/deploy/cloud/contentproof-health.timer" /etc/systemd/system/contentproof-health.timer
systemctl daemon-reload
systemctl enable --now contentproof.service
systemctl enable --now contentproof-backup.timer
systemctl enable --now contentproof-health.timer
for i in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:3001/health/ready >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:3001/health/ready
install -d -m 0755 /var/www/contentproof-acme/.well-known/acme-challenge
if [ -L /etc/nginx/sites-enabled/default ]; then unlink /etc/nginx/sites-enabled/default; fi
if [ ! -f /etc/nginx/sites-available/contentproof ]; then
cat > /etc/nginx/sites-available/contentproof <<EOF
server {
    listen 80 default_server;
    server_name ${endpoint};
    location ^~ /.well-known/acme-challenge/ { root /var/www/contentproof-acme; default_type text/plain; }
    location = /deployment-ready { default_type text/plain; return 200 'ContentProof deployment ready\n'; }
    location / { return 503; }
}
EOF
fi
ln -sfn /etc/nginx/sites-available/contentproof /etc/nginx/sites-enabled/contentproof
nginx -t
systemctl enable --now nginx
systemctl reload nginx
printf '\nApplication ready on loopback. Existing proxy/HTTPS configuration preserved; first-time HTTPS activation is a separate step.\n'
