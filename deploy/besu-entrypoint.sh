#!/bin/sh
set -eu
# Besu normalizes its permission file on startup, so keep the editable copy in
# this node's private volume rather than writing to a shared host configuration.
if [ ! -f /var/lib/besu/permissions.toml ]; then
  cp /config/permissions.toml /var/lib/besu/permissions.toml
fi
exec /opt/besu/bin/besu "$@"
