#!/usr/bin/env bash
# Apply shared browser headers without certificate reissuance or an API restart.
set -Eeuo pipefail
umask 077
app="$(realpath "${1:-/opt/contentproof/current/app}")"
[[ "$app" == /opt/contentproof/releases/*/app ]]
exec 9>/run/lock/contentproof-maintenance.lock; flock -n 9
site=/etc/nginx/sites-available/contentproof
snippet=/etc/nginx/snippets/contentproof-security.conf
backup="/var/backups/contentproof/browser-security-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$backup"
cp -p "$site" "$backup/site.conf"
[[ ! -f "$snippet" ]] || cp -p "$snippet" "$backup/security.conf"
before="$(systemctl show contentproof.service -p MainPID --value)"
rollback(){ trap - ERR;set +e;cp -p "$backup/site.conf" "$site";if [[ -f "$backup/security.conf" ]];then cp -p "$backup/security.conf" "$snippet";else rm -f "$snippet";fi;nginx -t && systemctl reload nginx;exit 1; }
trap rollback ERR
install -d -m 0755 /etc/nginx/snippets
/opt/contentproof/current/runtime/bin/node "$app/deploy/cloud/browser-security.mjs" "$snippet"
python3 - "$site" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]);s=p.read_text();needle='listen 443 ssl default_server;'
assert s.count(needle)==1
prefix,body=s.split(needle,1)
assert 'add_header Content-Security-Policy' not in body, 'Review existing custom CSP before replacement'
body=re.sub(r'^\s*(?:include /etc/nginx/snippets/contentproof-security\.conf;|proxy_hide_header (?:Content-Security-Policy|X-Content-Type-Options|X-Frame-Options|Referrer-Policy);|add_header (?:X-Content-Type-Options|X-Frame-Options|Referrer-Policy) [^;]+;)\s*$', '', body,flags=re.M)
shared='\n    include /etc/nginx/snippets/contentproof-security.conf;\n'+''.join('    proxy_hide_header '+n+';\n' for n in ['Content-Security-Policy','X-Content-Type-Options','X-Frame-Options','Referrer-Policy'])
p.write_text(prefix+needle+shared+body)
PY
nginx -t
systemctl reload nginx
[[ "$(systemctl show contentproof.service -p MainPID --value)" == "$before" ]]
trap - ERR
printf 'Shared browser headers applied. API PID preserved: %s\nRollback directory: %s\n' "$before" "$backup"
