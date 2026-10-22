#!/bin/sh
# Entry point for the latex-api image.
# Starts as root only to (1) give the `node` user access to the Docker socket, whose group id
# differs between hosts, and (2) make the data directory writable when it is a host bind
# that Docker created as root. Then drops privileges permanently with setpriv.
set -eu

SOCK="${DOCKER_SOCKET:-/var/run/docker.sock}"
DATA="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  if [ -S "$SOCK" ]; then
    SOCK_GID=$(stat -c %g "$SOCK")
    if [ "$SOCK_GID" != "0" ]; then
      getent group "$SOCK_GID" >/dev/null 2>&1 || groupadd -g "$SOCK_GID" dockerhost
      GROUP_NAME=$(getent group "$SOCK_GID" | cut -d: -f1)
      usermod -aG "$GROUP_NAME" node
    else
      # Socket owned by root:root (e.g. rootless or hardened hosts): fall back to an ACL.
      setfacl -m u:node:rw "$SOCK" 2>/dev/null || chmod g+rw "$SOCK" 2>/dev/null || true
    fi
  fi
  mkdir -p "$DATA"
  chown node:node "$DATA" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups /usr/bin/tini -- "$@"
fi

exec /usr/bin/tini -- "$@"
