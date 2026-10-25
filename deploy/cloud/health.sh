#!/usr/bin/env bash
set -euo pipefail
# An operator or the backup service may intentionally stop the application.
systemctl is-active --quiet contentproof.service || exit 0
for attempt in 1 2 3; do
  status=$(curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/health/ready || true)
  case "$status" in 200|429) exit 0 ;; esac
  sleep 2
done
# Serialise with deployment and stopped-state backup before restarting anything.
exec 9>/run/lock/contentproof-maintenance.lock
flock -n 9 || exit 0
systemctl is-active --quiet contentproof.service || exit 0
printf 'Application health failed repeatedly; restarting the single-host service.\n'
systemctl restart contentproof.service
for attempt in $(seq 1 45); do
  if curl -fsS --max-time 5 http://127.0.0.1:3001/health/ready >/dev/null 2>&1; then exit 0; fi
  sleep 1
done
exit 1
