export interface CloudInitPreset {
  id: string;
  label: string;
  description: string;
  /** Static script, or undefined when the preset is built dynamically via `build`. */
  script: string;
  /** When present, the preset is rendered from live context (the default preset). */
  build?: (ctx: DefaultUserDataContext) => string;
}

export interface DefaultUserDataContext {
  /** VM name / RBAC role from the form; used verbatim as the fedproxy SERVICE.
   * The relay flattens the served host to `<SERVICE>--<HANDLE>.fedproxy.com`. */
  vmName: string;
  /** Logged-in user's full DID (`did:plc:…`). */
  didPlc: string;
  /** Bare PLC key (DID without the `did:plc:` prefix). */
  didPlcKey: string;
  /** Subdomain the browser relay registered on `xrpc.fedproxy.com`. */
  xrpcRelaySubdomain: string;
  /** OpenSSH public key (single line) added to root's authorized_keys. */
  sshAuthorizedKey: string;
}

const PLACEHOLDER: DefaultUserDataContext = {
  vmName: '<vm-name>',
  didPlc: '<did:plc:…>',
  didPlcKey: '<plc-key>',
  xrpcRelaySubdomain: '<relay-subdomain>',
  sshAuthorizedKey: 'ssh-ed25519 <public-key> <comment>',
};

/**
 * Build the default cloud-config for a VM: OpenSSH reachable over WebSocket.
 *
 * sshd listens on 127.0.0.1:22 (loopback only). websocat bridges
 * ws-listen 127.0.0.1:8080 → tcp 127.0.0.1:22, and fedproxy-client fronts
 * :8080 — so an external SSH client tunnels through the relay over a WebSocket
 * (`ProxyCommand websocat --binary ws://<service>.fedproxy.com`). Root login is
 * key-only; the public key is injected by the orchestrator (server.ts), which
 * holds the matching private key. SSH host key publication is handled by
 * fedproxy-client directly (un-gates the "Terminal" button in the SPA).
 */
export function buildDefaultUserData(ctx: DefaultUserDataContext): string {
  const { vmName, didPlc, didPlcKey, xrpcRelaySubdomain, sshAuthorizedKey } = ctx;
  const xrpcRelayFqdn = `${xrpcRelaySubdomain}.xrpc.fedproxy.com`;
  return `#cloud-config
packages:
  - openssh-server
  - jq
  - curl

# Key-only root login over the websocat tunnel.
disable_root: false
ssh_pwauth: false

write_files:
  - path: /root/.ssh/authorized_keys
    owner: root:root
    permissions: '0600'
    content: |
      ${sshAuthorizedKey}

  - path: /etc/ssh/sshd_config.d/10-websocat.conf
    owner: root:root
    permissions: '0644'
    content: |
      # sshd is only reachable through the websocat→fedproxy tunnel.
      ListenAddress 127.0.0.1
      PermitRootLogin prohibit-password
      PasswordAuthentication no

  - path: /usr/local/bin/setup-websocat.sh
    owner: root:root
    permissions: '0755'
    content: |
      #!/bin/bash
      set -x

      STAMP=/var/lib/setup-websocat.done
      [ -f "\${STAMP}" ] && exit 0

      retry() {
        n=0
        delay=5
        until "$@"; do
          n=$((n + 1))
          echo "command failed (attempt $n): $*; retrying in \${delay}s" >&2
          sleep "$delay"
        done
      }

      # fedproxy-client (fronts the websocat WebSocket listener).
      _arch=$(uname -m)
      case "$_arch" in x86_64|amd64) _arch=amd64 ;; aarch64|arm64) _arch=arm64 ;; esac
      _os=$(uname -s | tr '[:upper:]' '[:lower:]')
      retry sh -c "curl -sfL 'https://github.com/publicdomainrelay/atproto-reverse-proxy/releases/download/latest/atproto-reverse-proxy_\${_os}_\${_arch}.tar.gz' | tar -xvz -C /usr/local/bin"

      # websocat release binary (musl-static; ws ↔ tcp bridge).
      case "$_arch" in amd64) _ws_arch=x86_64 ;; arm64) _ws_arch=aarch64 ;; esac
      retry sh -c "curl -sfL 'https://github.com/vi/websocat/releases/download/v1.13.0/websocat.\${_ws_arch}-unknown-linux-musl' -o /usr/local/bin/websocat"
      chmod +x /usr/local/bin/websocat

      systemctl enable websocat.service fedproxy-client.service
      systemctl start --no-block websocat.service fedproxy-client.service

      touch "\${STAMP}"

  - path: /etc/systemd/system/websocat.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=websocat ws→sshd bridge (fronted by fedproxy-client)
      After=network-online.target sshd.service ssh.service
      Wants=network-online.target

      [Service]
      Type=simple
      User=root
      # WebSocket listener on loopback :8080 → sshd on loopback :22.
      # fedproxy-client (SERVICE=${vmName}, PORT=8080) forwards external WS here.
      # The relay flattens the served host to <SERVICE>--<HANDLE>.fedproxy.com,
      # so SERVICE stays the bare VM name and HANDLE carries the did:plc.
      ExecStart=/usr/local/bin/websocat --binary ws-l:127.0.0.1:8080 tcp:127.0.0.1:22
      Restart=always
      RestartSec=5
      TimeoutStopSec=10
      StandardOutput=journal
      StandardError=journal

      [Install]
      WantedBy=multi-user.target

  - path: /etc/systemd/system/setup-websocat.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=First-boot websocat setup (install binaries)
      After=network-online.target
      Wants=network-online.target
      ConditionPathExists=/root/secrets/digitalocean.com/serviceaccount/token
      ConditionPathExists=!/var/lib/setup-websocat.done

      [Service]
      Type=oneshot
      User=root
      ExecStart=/usr/local/bin/setup-websocat.sh
      StandardOutput=journal
      StandardError=journal

      [Install]
      WantedBy=multi-user.target

  - path: /etc/systemd/system/setup-websocat.path
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=Watch for DO service-account token then run setup-websocat

      [Path]
      PathExists=/root/secrets/digitalocean.com/serviceaccount/token
      Unit=setup-websocat.service

      [Install]
      WantedBy=multi-user.target

  - path: /etc/systemd/system/fedproxy-client.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=FedProxy Client Service
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      User=root
      WorkingDirectory=/root
      Environment="SERVICE=${vmName}"
      # SSH username the relay flattens into the host's handle segment. Pinning
      # it to the did:plc yields <SERVICE>--did-plc-<key>.fedproxy.com instead of
      # the resolved alsoKnownAs handle.
      Environment="HANDLE=${didPlc}"
      Environment="PORT=8080"
      Environment="ATPRP_URL=https://${xrpcRelayFqdn}"
      Environment="AUTH_PLUGIN=oidc"
      Environment="MARKET_ACCEPT_JSON_PATH=/root/secrets/publicdomainrelay.com/market/accept.json"
      ExecStart=/usr/local/bin/fedproxy-client
      Restart=always
      RestartSec=5
      TimeoutStopSec=10
      StandardOutput=journal
      StandardError=journal

      [Install]
      WantedBy=multi-user.target

runcmd:
  - systemctl daemon-reload
  - systemctl enable --now ssh || systemctl enable --now sshd
  - systemctl enable setup-websocat.path
  - systemctl start --no-block setup-websocat.path
`;
}

export const CLOUD_INIT_PRESETS: CloudInitPreset[] = [
  {
    id: 'default',
    label: 'Default (WooTTY terminal)',
    description: 'fedproxy-client + WooTTY-over-tmux browser terminal',
    script: buildDefaultUserData(PLACEHOLDER),
    build: buildDefaultUserData,
  },
  {
    id: 'minimal',
    label: 'Minimal (Ubuntu)',
    description: 'Bare Ubuntu install, SSH only',
    script: `#cloud-config
package_update: true
package_upgrade: true
`,
  },
  {
    id: 'docker',
    label: 'Docker Host',
    description: 'Ubuntu with Docker Engine + Compose plugin',
    script: `#cloud-config
package_update: true
package_upgrade: true
packages:
  - apt-transport-https
  - ca-certificates
  - curl
  - gnupg
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
`,
  },
  {
    id: 'nginx',
    label: 'Nginx Web Server',
    description: 'Ubuntu with Nginx serving a default page',
    script: `#cloud-config
package_update: true
packages:
  - nginx
runcmd:
  - systemctl enable --now nginx
write_files:
  - path: /var/www/html/index.html
    content: |
      <html><body><h1>Hello from cloud-init</h1></body></html>
`,
  },
  {
    id: 'k3s',
    label: 'K3s Single-Node',
    description: 'Lightweight Kubernetes (k3s) server node',
    script: `#cloud-config
package_update: true
packages:
  - curl
runcmd:
  - curl -sfL https://get.k3s.io | sh -
  - systemctl enable --now k3s
`,
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Write your own cloud-init script',
    script: `#cloud-config
`,
  },
];
