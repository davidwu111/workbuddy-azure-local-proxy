# Linux and Debian LXC deployment

This branch runs the same Node.js bridge on Linux with an optional LAN listener.
No Docker or npm packages are required; install Node.js 22 or newer. The
Windows-only PowerShell launcher on the repository is not used on Linux.

## 1. Install and configure

```bash
# Choose a directory under the service user's home. This guide and the
# example systemd unit assume this exact path:
git clone -b linux https://github.com/davidwu111/workbuddy-azure-local-proxy.git \
  "$HOME/workbuddy-azure-local-proxy"
cd "$HOME/workbuddy-azure-local-proxy"
node --version
node --test bridge.test.js bridge.linux.test.js
cp .env.example .env
chmod 600 .env
```

Edit `.env` and replace **all** placeholders. In particular, set `BRIDGE_HOST`
to this host's LAN IPv4 (`hostname -I` or `ip -4 addr` can help identify it).
`127.0.0.1` is only for clients on the same host, and `0.0.0.0` listens on all
interfaces, including VPN interfaces. Set `AZURE_OPENAI_BASE` to the Azure
resource base, not `/openai/v1/responses`; set `AZURE_OPENAI_MODEL` to your
Azure deployment name. `BRIDGE_PROXY_TOKEN` must differ from the Azure key:
use `openssl rand -hex 32` and configure that value as WorkBuddy's `apiKey`.
The Azure key stays on the Linux host. Never commit `.env`.

## 2. Run

For an initial foreground run:

```bash
node bridge.js
```

From the Linux host (substitute its LAN IP):

```bash
curl --noproxy '*' http://YOUR_LAN_IPV4:8787/healthz
curl --noproxy '*' http://YOUR_LAN_IPV4:8787/v1/models
```

Those two endpoints are unauthenticated and report process/configured-model
state, not Azure connectivity. From another LAN PC, use
`http://YOUR_LAN_IPV4:8787/v1/chat/completions` as the WorkBuddy URL and use
`BRIDGE_PROXY_TOKEN` as its `apiKey`. An authenticated test request may incur
Azure charges; the mock tests do not contact Azure.

For restart-on-failure and startup across reboots under systemd:

```bash
mkdir -p "$HOME/.config/systemd/user"
cp examples/workbuddy-azure-bridge.service "$HOME/.config/systemd/user/"
# The sample unit expects Node to be on systemd's PATH (typically
# /usr/local/bin or /usr/bin). If Node is user-local, resolve its real binary
# with `readlink -f "$(command -v node)"` and replace `/usr/bin/env node`
# in ExecStart with that absolute path before enabling the service.
# If your checkout is not $HOME/workbuddy-azure-local-proxy, edit WorkingDirectory
# and the bridge.js path in ExecStart in the copied unit.
systemctl --user daemon-reload
systemctl --user enable --now workbuddy-azure-bridge.service
systemctl --user status workbuddy-azure-bridge.service
journalctl --user -u workbuddy-azure-bridge.service -n 50
```

An administrator must run `sudo loginctl enable-linger "$USER"` once if the
user service needs to start on boot without a login; check with
`loginctl show-user "$USER" -p Linger`. Verify boot behavior after a reboot.
To stop it: `systemctl --user stop workbuddy-azure-bridge.service`.
To deploy new code, `git pull`, rerun the tests and
`systemctl --user restart workbuddy-azure-bridge.service`. Changes in `.env`
also require a restart.

## Network and transport security

Binding to the host's LAN IP avoids listening on other interfaces, but is
**not a firewall**. Permit port 8787 only from trusted LAN clients in the
LXC/VM/host/router firewall. Do not expose it to the Internet. On Proxmox,
check both the guest and the Proxmox firewall rules. No firewall rules are
installed by this project.

Plain HTTP sends prompts and the bearer token unencrypted. On untrusted or
shared LANs, use TLS: generate/acquire a certificate whose SAN matches your
LAN hostname/IP, set both `BRIDGE_TLS_CERT` and `BRIDGE_TLS_KEY` in `.env`,
then trust that certificate on each client and switch WorkBuddy's URL to
`https://...`. Do not disable TLS verification. Leave the TLS fields unset
for plain HTTP on a trusted LAN. Keep private keys out of Git (`certs/` is
ignored). This is a security trade-off, not encryption provided by the LAN.

## Troubleshooting

- No connection: check `systemctl --user status`, `ss -ltn` for the configured
  IP/port, client routing and any guest/host firewall.
- `401`: WorkBuddy must use `BRIDGE_PROXY_TOKEN`, not the Azure API key.
- `503`: verify the Azure base URL and key in `.env`; restart after editing.
- Azure error: confirm the deployment name and Responses API support. Check
  service logs without copying sensitive values into issues or chat.
- `EADDRNOTAVAIL` on boot: the configured LAN IP is not yet assigned; check
  DHCP/static address stability and `journalctl --user -u workbuddy-azure-bridge`.
