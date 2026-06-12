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
  /** VM name / RBAC role from the form. */
  vmName: string;
  /** fedproxy SERVICE name / terminal subdomain (`<role>--<handle-label>`). */
  serviceName: string;
  /** Logged-in user's full DID (`did:plc:…`). */
  didPlc: string;
  /** Bare PLC key (DID without the `did:plc:` prefix). */
  didPlcKey: string;
  /** Subdomain the browser relay registered on `xrpc.fedproxy.com`. */
  xrpcRelaySubdomain: string;
}

const PLACEHOLDER: DefaultUserDataContext = {
  vmName: '<vm-name>',
  serviceName: '<service-name>',
  didPlc: '<did:plc:…>',
  didPlcKey: '<plc-key>',
  xrpcRelaySubdomain: '<relay-subdomain>',
};

/**
 * Build the default cloud-config for a VM: ttyd-over-tmux terminal fronted by
 * fedproxy-client, with the ttyd password fetched from the browser relay over an
 * OIDC-authenticated `getRecord`, and the VM's SSH host key published back to the
 * relay via `createRecord` (which un-gates the "Terminal" button in the SPA).
 */
export function buildDefaultUserData(ctx: DefaultUserDataContext): string {
  const { vmName, serviceName, didPlc, didPlcKey, xrpcRelaySubdomain } = ctx;
  const xrpcRelayFqdn = `${xrpcRelaySubdomain}.xrpc.fedproxy.com`;
  return `#cloud-config
packages:
  - ttyd
  - tmux

users:
  - name: agent
    gecos: Policy Engine Agent
    primary_group: agent
    groups: [users]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: true
    no_user_group: false

write_files:
  - path: /usr/local/bin/setup-ttyd.sh
    owner: root:root
    permissions: '0755'
    content: |
      #!/bin/bash
      set -x

      STAMP=/var/lib/setup-ttyd.done
      [ -f "\${STAMP}" ] && exit 0

      # Identity of the requesting user, wired through from the SPA.
      DID_PLC="${didPlc}"
      DID_PLC_KEY="${didPlcKey}"

      URL=$(cat /root/secrets/digitalocean.com/serviceaccount/base_url)
      TEAM_UUID=$(cat /root/secrets/digitalocean.com/serviceaccount/team_uuid)
      ID_TOKEN=$(cat /root/secrets/digitalocean.com/serviceaccount/token)

      # Scope the minted token to exactly the ttyd-password role for this VM.
      SUBJECT="actx:\${TEAM_UUID}:plc:\${DID_PLC_KEY}:role:get-ttyd-password-${vmName}"

      TOKEN=$(curl -sf \\
        -H "Authorization: Bearer \${ID_TOKEN}" \\
        -d@<(jq -n -c \\
          --arg aud "api://ATProto?actx=\${DID_PLC}" \\
          --arg sub "\${SUBJECT}" \\
          --arg ttl 300 \\
          '{aud: \$aud, sub: \$sub, ttl: (\$ttl | fromjson)}') \\
        "\${URL}/v1/oidc/issue" \\
        | jq -r .token)

      XRPC_RELAY_FQDN="${xrpcRelayFqdn}"

      # Fetch the ttyd password from the browser relay. The relay's Hono handler
      # OIDC-validates \${TOKEN} (full JWKS verify) before returning the record.
      mkdir -p /etc/ttyd
      chmod 700 /etc/ttyd
      PASSWORD=$(curl -sf \\
        -H "Authorization: Bearer \${TOKEN}" \\
        "https://\${XRPC_RELAY_FQDN}/xrpc/com.atproto.repo.getRecord?collection=com.fedproxy.ttydCredentials&rkey=${vmName}" \\
        | jq -r .value.password)

      # ttyd -c expects user:password; the SPA shows the user this same password.
      printf 'agent:%s' "\${PASSWORD}" > /etc/ttyd/credentials
      chmod 600 /etc/ttyd/credentials


      retry() {
        n=0
        delay=5
        until "$@"; do
          n=$((n + 1))
          echo "command failed (attempt $n): $*; retrying in \${delay}s" >&2
          sleep "$delay"
        done
      }

      retry sh -c "curl -sfL 'https://github.com/publicdomainrelay/atproto-reverse-proxy/releases/download/latest/atproto-reverse-proxy_linux_amd64.tar.gz' | tar -xvz -C /usr/local/bin"

      systemctl enable ttyd fedproxy-client.service
      systemctl start --no-block ttyd fedproxy-client.service

      # Publish the SSH host public key back through the relay via createRecord.
      # The SPA watches for this record to un-gate the "Terminal" button.
      HOST_PUBKEY=$(cat /etc/ssh/ssh_host_ed25519_key.pub)
      curl -sf \\
        -H "Authorization: Bearer \${TOKEN}" \\
        -d@<(jq -n -c \\
          --arg col "com.fedproxy.sshPublicKey" \\
          --arg svc "${serviceName}" \\
          --arg key "\${HOST_PUBKEY}" \\
          '{collection: \$col, rkey: \$svc, record: {"\$type": \$col, service: \$svc, key: \$key, createdAt: (now | todate)}}') \\
        "https://\${XRPC_RELAY_FQDN}/xrpc/com.atproto.repo.createRecord" | jq

      touch "\${STAMP}"

  - path: /etc/systemd/system/setup-ttyd.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=First-boot ttyd setup (fetch credentials, publish SSH key)
      After=network-online.target
      Wants=network-online.target
      ConditionPathExists=/root/secrets/digitalocean.com/serviceaccount/token
      ConditionPathExists=!/var/lib/setup-ttyd.done

      [Service]
      Type=oneshot
      User=root
      ExecStart=/usr/local/bin/setup-ttyd.sh
      StandardOutput=journal
      StandardError=journal

      [Install]
      WantedBy=multi-user.target

  - path: /etc/systemd/system/setup-ttyd.path
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=Watch for DO service-account token then run setup-ttyd

      [Path]
      PathExists=/root/secrets/digitalocean.com/serviceaccount/token
      Unit=setup-ttyd.service

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
      Environment="SERVICE=${serviceName}"
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

  - path: /etc/systemd/system/ttyd.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=Policy Engine Service
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      User=agent
      Group=agent
      ExecStart=/bin/bash -c '/usr/bin/ttyd -p 8080 -i 127.0.0.1 -c $(cat /etc/ttyd/credentials) -W $(which tmux)'
      Restart=always
      RestartSec=5
      TimeoutStopSec=10
      StandardOutput=journal
      StandardError=journal

      [Install]
      WantedBy=multi-user.target

runcmd:
  - systemctl daemon-reload
  - systemctl enable setup-ttyd.path
  - systemctl start --no-block setup-ttyd.path
`;
}

export const CLOUD_INIT_PRESETS: CloudInitPreset[] = [
  {
    id: 'default',
    label: 'Default (ttyd terminal)',
    description: 'fedproxy-client + ttyd-over-tmux browser terminal',
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
