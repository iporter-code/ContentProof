#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/run/lock/contentproof-maintenance.lock
flock -n 9 || exit 1
was_active=0
if systemctl is-active --quiet contentproof.service; then was_active=1; fi
resume() { if [ "$was_active" -eq 1 ]; then systemctl start contentproof.service; fi; }
trap resume EXIT
systemctl stop contentproof.service
set -a
source /etc/contentproof/app.env
set +a
export CP_BACKUP_PASSWORD
CP_BACKUP_PASSWORD="$(cat /etc/contentproof/backup.password)"
target="/var/backups/contentproof/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p /var/backups/contentproof
cd /opt/contentproof/current/app
/opt/contentproof/current/runtime/bin/node dist/server/scripts/maintenance.js backup "$target"
unset CP_BACKUP_PASSWORD
printf 'Encrypted backup completed: %s\n' "$target"
/opt/contentproof/current/runtime/bin/node deploy/cloud/backup-retention.mjs /var/backups/contentproof
