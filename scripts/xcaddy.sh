#!/usr/bin/env bash
set -xeuo pipefail

# Ensure Caddy is installed and carries the cloudflare DNS module. atprp-ssh-relay
# needs DNS-01 (cloudflare) to issue certs for multi-level subdomains like
# svc.handle.fedproxy.com; without the module Caddy rejects the automation policy
# the relay pushes and no cert is ever minted ("no certificate matching TLS ClientHello").
# Idempotent: only (re)build when the running binary lacks dns.providers.cloudflare.
if ! caddy list-modules 2>/dev/null | grep -q 'dns.providers.cloudflare'; then
  echo "cloudflare DNS module missing -- installing Caddy + building with xcaddy"

  sudo apt-get update

  # Base Caddy package supplies the caddy user/group and default dirs. Install
  # from the official Cloudsmith repo if no caddy binary exists yet.
  if ! command -v caddy >/dev/null 2>&1; then
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt-get update
    sudo apt-get install -y caddy
  fi

  # xcaddy needs Go.
  command -v go >/dev/null 2>&1 || sudo apt-get install -y golang-go

  # Install xcaddy if absent.
  if ! command -v xcaddy >/dev/null 2>&1; then
    wget -q "https://github.com/caddyserver/xcaddy/releases/download/v0.4.5/xcaddy_0.4.5_linux_amd64.deb" -O /tmp/xcaddy.deb
    sudo dpkg -i /tmp/xcaddy.deb
  fi

  # Build a Caddy with the cloudflare DNS provider and swap it in. Replacing the
  # binary in place is safe while caddy runs; the restart at the end of this
  # script execs the new binary.
  xcaddy build --with github.com/caddy-dns/cloudflare --output /tmp/caddy-cloudflare
  sudo mv /tmp/caddy-cloudflare /usr/bin/caddy
  sudo chmod 0755 /usr/bin/caddy

  # Fail loudly if the build did not actually include the module.
  caddy list-modules 2>/dev/null | grep -q 'dns.providers.cloudflare' || { echo "ERROR: cloudflare DNS module still missing after build"; exit 1; }
  echo "Caddy now has dns.providers.cloudflare"
else
  echo "Caddy already has dns.providers.cloudflare -- skipping build"
fi
