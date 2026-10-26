#!/usr/bin/env bash
set -euo pipefail
umask 077
endpoint="${1:?public IPv4 required}"
python3 -c 'import ipaddress,sys; assert ipaddress.ip_address(sys.argv[1]).version == 4' "$endpoint"
certbot=/opt/contentproof/certbot/bin/certbot
[ -x "$certbot" ]
# Run this only after the operator authorizes the CA subscriber agreement and public certificate issuance.
common=(certonly --non-interactive --agree-tos --register-unsafely-without-email --required-profile shortlived --webroot --webroot-path /var/www/contentproof-acme --ip-address "$endpoint" --cert-name contentproof-ip)
"$certbot" "${common[@]}" --staging --config-dir /etc/contentproof/acme-staging --work-dir /var/lib/contentproof-acme-staging --logs-dir /var/log/contentproof-acme-staging
"$certbot" "${common[@]}"
web_routes="$(cat <<'ROUTES'
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Forwarded "";
        proxy_read_timeout 60s;
    }
ROUTES
)"
# Preserve an independently published frontend when HTTPS is reprovisioned.
if [ -f /opt/contentproof-web/current/index.html ]; then
web_routes="$(python3 - "$web_routes" <<'PY'
import sys
proxy=sys.argv[1]
print(proxy.replace('location / {','location ^~ /v1/ {',1)+'\n'+proxy.replace('location / {','location ^~ /health/ {',1)+'''
    location ^~ /assets/ {
        root /opt/contentproof-web/current;
        try_files $uri =404;
        expires 1y;
    }
    location / {
        root /opt/contentproof-web/current;
        try_files $uri $uri/ /index.html;
        expires -1;
    }''')
PY
)"
fi
install -d -m 0755 /etc/nginx/snippets
/opt/contentproof/current/runtime/bin/node /opt/contentproof/current/app/deploy/cloud/browser-security.mjs /etc/nginx/snippets/contentproof-security.conf
cat > /etc/nginx/sites-available/contentproof <<EOF
server {
    listen 80 default_server;
    server_name ${endpoint};
    location ^~ /.well-known/acme-challenge/ { root /var/www/contentproof-acme; default_type text/plain; }
    location = /deployment-ready { default_type text/plain; return 200 'ContentProof deployment ready\n'; }
    location / { return 301 https://${endpoint}\$request_uri; }
}
server {
    listen 443 ssl default_server;
    server_name ${endpoint};
    ssl_certificate /etc/letsencrypt/live/contentproof-ip/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/contentproof-ip/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 128m;
    include /etc/nginx/snippets/contentproof-security.conf;
    proxy_hide_header Content-Security-Policy;
    proxy_hide_header X-Content-Type-Options;
    proxy_hide_header X-Frame-Options;
    proxy_hide_header Referrer-Policy;
$web_routes
}
EOF
nginx -t
systemctl reload nginx
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/contentproof-nginx <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
/usr/sbin/nginx -t
/bin/systemctl reload nginx
EOF
chmod 0700 /etc/letsencrypt/renewal-hooks/deploy/contentproof-nginx
install -m 0644 /home/ecs-user/contentproof-certificate.service /etc/systemd/system/contentproof-certificate.service
install -m 0644 /home/ecs-user/contentproof-certificate.timer /etc/systemd/system/contentproof-certificate.timer
systemctl daemon-reload
systemctl enable --now contentproof-certificate.timer
"$certbot" renew --dry-run --no-random-sleep-on-renew
printf '\nHTTPS activated and renewal dry-run passed.\n'
