#!/usr/bin/env bash
# Publish immutable public web assets without restarting API/chain/test units.
set -Eeuo pipefail
umask 022
archive="${1:?web ZIP required}"; hash="${2:?SHA256 required}"; endpoint="${3:?public IPv4 required}"
[[ "$(id -u)" -eq 0 && "$hash" =~ ^[a-f0-9]{64}$ ]] || exit 2
python3 - "$endpoint" <<'PY'
import ipaddress,sys
assert ipaddress.ip_address(sys.argv[1]).version==4
PY
printf '%s  %s\n' "$hash" "$archive" | sha256sum -c -
exec 9>/run/lock/contentproof-maintenance.lock; flock -n 9
backend_pid="$(systemctl show contentproof.service -p MainPID --value)"
[[ "$backend_pid" =~ ^[1-9][0-9]*$ ]]
curl -fsS --max-time 5 http://127.0.0.1:3001/health/ready >/dev/null
base=/opt/contentproof-web; target="$base/releases/${hash:0:16}"
[[ ! -e "$target" ]] || { echo 'Web release exists; inspect before reuse'; exit 2; }
install -d -m 0755 "$base/releases" "$target"
previous=''
if [[ -e "$base/current" || -L "$base/current" ]]; then
  [[ -L "$base/current" ]] || exit 2
  previous="$(realpath "$base/current")"; [[ "$previous" == "$base"/releases/* ]] || exit 2
fi
source_web="${previous:-$(readlink -f /opt/contentproof/current)/app/dist/web}"
python3 - "$archive" "$target" "$source_web" "$hash" <<'PY'
import pathlib,zipfile,sys,shutil,hashlib,json
archive,folder,previous,sha=sys.argv[1:];root=pathlib.Path(folder).resolve();old=pathlib.Path(previous)
# Retain already-public hashed assets so open tabs can load their older chunks.
if (old/'assets').exists():
 for p in (old/'assets').rglob('*'):
  assert not p.is_symlink()
  if p.is_file():
   dest=root/p.relative_to(old);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dest);dest.chmod(0o644)
files={}
with zipfile.ZipFile(archive) as z:
 assert len(z.infolist())<=256 and sum(i.file_size for i in z.infolist())<=32*1024*1024
 for info in z.infolist():
  p=pathlib.PurePosixPath(info.filename);assert p.parts and p.parts[0]=='web' and '..' not in p.parts and '\\' not in info.filename and not info.is_dir()
  rel=pathlib.Path(*p.parts[1:]);assert rel.parts and (str(rel)=='index.html' or rel.parts[0]=='assets')
  dest=(root/rel).resolve();assert dest.is_relative_to(root) and str(rel) not in files
  content=z.read(info)
  if dest.exists() and rel.parts[0]=='assets':assert dest.read_bytes()==content,'Hashed asset name collision'
  dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(content);dest.chmod(0o644)
  files[str(rel)]=hashlib.sha256(content).hexdigest()
assert 'index.html' in files
(root/'WEB_PROVENANCE.json').write_text(json.dumps(dict(sourceSha256=sha,files=files,scope='Compiled public frontend; backend and business data unchanged'),indent=2))
PY
backup="/var/backups/contentproof/web-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$backup"
cp -p /etc/nginx/sites-available/contentproof "$backup/nginx.conf"
printf '%s\n' "$previous" > "$backup/previous-web"
rollback() {
 trap - ERR; set +e
 cp -p "$backup/nginx.conf" /etc/nginx/sites-available/contentproof
 if [[ -n "$previous" ]]; then ln -sfn "$previous" "$base/current"; elif [[ -L "$base/current" && "$(readlink -f "$base/current")" == "$target" ]]; then unlink "$base/current"; fi
 nginx -t && systemctl reload nginx
 echo 'Web publish failed; previous frontend route restored.'; exit 1
}
trap rollback ERR
python3 - <<'PY'
import pathlib
p=pathlib.Path('/etc/nginx/sites-available/contentproof');s=p.read_text();root='root /opt/contentproof-web/current;'
if root in s:
 assert s.count(root)==2 and 'location ^~ /v1/' in s and 'location ^~ /health/' in s
else:
 marker='    location / {\n        proxy_pass http://127.0.0.1:3001;'
 assert s.count(marker)==1,'Unknown existing proxy configuration'
 start=s.index(marker);end=s.index('\n    }',start)+len('\n    }');proxy=s[start:end]
 assert proxy.count('{')==1 and proxy.count('}')==1
 replacement=proxy.replace('location / {','location ^~ /v1/ {',1)+'\n'+proxy.replace('location / {','location ^~ /health/ {',1)+'''
    location ^~ /assets/ {
        root /opt/contentproof-web/current;
        try_files $uri =404;
        expires 1y;
    }
    location / {
        root /opt/contentproof-web/current;
        try_files $uri $uri/ /index.html;
        expires -1;
    }'''
 p.write_text(s[:start]+replacement+s[end:])
PY
ln -sfn "$target" "$base/current"
nginx -t
systemctl reload nginx
test "$(systemctl show contentproof.service -p MainPID --value)" = "$backend_pid"
curl -fsS --max-time 10 "https://$endpoint/health/ready"
expected="$(sha256sum "$target/index.html" | cut -d' ' -f1)"
# Reload is graceful: an old worker can briefly serve the previous document.
# Accept publication only once HTTPS actually serves the expected new bytes.
served=''
for attempt in $(seq 1 20); do
 served="$(curl -fsS --max-time 3 "https://$endpoint/login?web-release=${hash:0:16}" | sha256sum | cut -d' ' -f1)" || served=''
 [[ "$served" != "$expected" ]] || break
 sleep 0.5
done
[[ "$served" == "$expected" ]]
trap - ERR
printf '\nWeb published: %s\nRollback config: %s\nBackend PID preserved: %s\n' "$target" "$backup" "$backend_pid"
