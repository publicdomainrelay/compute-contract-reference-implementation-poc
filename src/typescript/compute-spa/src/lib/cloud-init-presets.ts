import oauthClientMetadata from '../../public/oauth-client-metadata.json';

/**
 * Origin that serves the SPA's `dist/` (and therefore the wootty-web tarball
 * dropped there by `wootty-web/build-wootty-web.sh`). Derived from the OAuth
 * client metadata `client_uri` (e.g. `https://ui.fedfork.com`) rather than
 * hardcoded, so the download URL tracks wherever the SPA is deployed.
 */
const SPA_ORIGIN = new URL(oauthClientMetadata.client_uri).origin;

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
 * Build the default cloud-config for a VM: WooTTY-over-tmux terminal fronted by
 * fedproxy-client, with the WooTTY auth token fetched from the browser relay over
 * an OIDC-authenticated `getRecord`, and the VM's SSH host key published back to
 * the relay via `createRecord` (which un-gates the "Terminal" button in the SPA).
 */
export function buildDefaultUserData(ctx: DefaultUserDataContext): string {
  const { vmName, serviceName, didPlc, didPlcKey, xrpcRelaySubdomain } = ctx;
  const xrpcRelayFqdn = `${xrpcRelaySubdomain}.xrpc.fedproxy.com`;
  return `#cloud-config
packages:
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
  - path: /usr/local/bin/setup-wootty.sh
    owner: root:root
    permissions: '0755'
    content: |
      #!/bin/bash
      set -x

      STAMP=/var/lib/setup-wootty.done
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

      # Fetch the WooTTY auth token from the browser relay. The relay's Hono
      # handler OIDC-validates \${TOKEN} (full JWKS verify) before returning the
      # record. The record's \`.value.password\` is the single WooTTY auth token
      # (WooTTY has no user:password basic auth — one bearer token only).
      mkdir -p /etc/wootty
      chown agent:agent /etc/wootty
      chmod 750 /etc/wootty
      PASSWORD=$(curl -sf \\
        -H "Authorization: Bearer \${TOKEN}" \\
        "https://\${XRPC_RELAY_FQDN}/xrpc/com.atproto.repo.getRecord?collection=com.fedproxy.ttydCredentials&rkey=${vmName}" \\
        | jq -r .value.password)

      # wootty.service runs as User=agent and reads this as an EnvironmentFile;
      # the SPA shows the user this same token (and opens the terminal with it in
      # the URL hash, which WooTTY exchanges once for the wootty_auth cookie).
      printf 'WOOTTY_AUTH_TOKEN=%s\\n' "\${PASSWORD}" > /etc/wootty/wootty.env
      chown agent:agent /etc/wootty/wootty.env
      chmod 600 /etc/wootty/wootty.env


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

      # Install the woottyd browser-terminal daemon (no apt package; pull the
      # release binary, mirroring the atproto-reverse-proxy pattern above).
      retry sh -c "curl -sfL 'https://github.com/icoretech/wootty/releases/download/wootty-v0.2.17/woottyd_0.2.17_linux_amd64.tar.gz' | tar -xvz -C /usr/local/bin woottyd"
      chmod +x /usr/local/bin/woottyd

      # The woottyd release binary (and the GHCR image) ship NO web UI: both embed
      # an empty placeholder dist and serve {"message":"Web app is not built yet"}.
      # We build the wootty-web assets ourselves (wootty-web/build-wootty-web.sh)
      # and serve the tarball from the SPA origin (oauth-client-metadata client_uri).
      # Extract it and point WOOTTY_STATIC_DIR at it (wootty.service reads that env).
      mkdir -p /usr/local/share/wootty
      retry sh -c "curl -sfL '${SPA_ORIGIN}/wootty-web-dist.tar.gz' | tar -xz -C /usr/local/share/wootty"

      systemctl enable wootty fedproxy-client.service
      systemctl start --no-block wootty fedproxy-client.service

      # Publish the SSH host public key back through the relay via createRecord.
      # The SPA watches for this record to un-gate the "Terminal" button.
      HOST_PUBKEY=$(cat /etc/ssh/ssh_host_ed25519_key.pub)
      curl -sf \\
        -H "Authorization: Bearer \${TOKEN}" \\
        -d@<(jq -n -c \\
          --arg col "com.fedproxy.sshPublicKey" \\
          --arg svc "${vmName}" \\
          --arg key "\${HOST_PUBKEY}" \\
          '{collection: \$col, rkey: \$svc, record: {"\$type": \$col, service: \$svc, key: \$key, createdAt: (now | todate)}}') \\
        "https://\${XRPC_RELAY_FQDN}/xrpc/com.atproto.repo.createRecord" | jq

      touch "\${STAMP}"

  - path: /etc/systemd/system/setup-wootty.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=First-boot WooTTY setup (fetch token, install woottyd, publish SSH key)
      After=network-online.target
      Wants=network-online.target
      ConditionPathExists=/root/secrets/digitalocean.com/serviceaccount/token
      ConditionPathExists=!/var/lib/setup-wootty.done

      [Service]
      Type=oneshot
      User=root
      ExecStart=/usr/local/bin/setup-wootty.sh
      StandardOutput=journal
      StandardError=journal

      [Install]
      WantedBy=multi-user.target

  - path: /etc/systemd/system/setup-wootty.path
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=Watch for DO service-account token then run setup-wootty

      [Path]
      PathExists=/root/secrets/digitalocean.com/serviceaccount/token
      Unit=setup-wootty.service

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
      # the resolved alsoKnownAs handle (which is "handle.invalid" when the DID
      # has no verified handle, breaking the SSH auth and the route).
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

  - path: /etc/systemd/system/wootty.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=Policy Engine Service (WooTTY browser terminal)
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      User=agent
      Group=agent
      # Loopback bind; fedproxy-client fronts it. WOOTTY_AUTH_TOKEN comes from the
      # env file written by setup-wootty.sh. WOOTTY_COMMAND=tmux preserves the
      # ttyd-over-tmux behavior.
      EnvironmentFile=/etc/wootty/wootty.env
      Environment="WOOTTY_HOST=127.0.0.1"
      Environment="WOOTTY_PORT=8080"
      Environment="WOOTTY_COMMAND=tmux"
      # Web UI assets fetched by setup-wootty.sh (release binary embeds none).
      Environment="WOOTTY_STATIC_DIR=/usr/local/share/wootty/wootty-web"
      ExecStart=/usr/local/bin/woottyd run
      Restart=always
      RestartSec=5
      TimeoutStopSec=10
      StandardOutput=journal
      StandardError=journal

      [Install]
      WantedBy=multi-user.target

runcmd:
  - systemctl daemon-reload
  - systemctl enable setup-wootty.path
  - systemctl start --no-block setup-wootty.path
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
