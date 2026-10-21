# Linux and Debian LXC deployment

Linux uses the same upgraded shared Node.js core as Windows, including explicit
approved Azure origins, deployment/variant/version routes, client aliases,
stateless conversion, resource bounds and sanitized diagnostics. It adds no
separate shell launcher. Node.js 22 or newer is required; Node 22/24 on Linux
and Windows are configured in the [offline CI workflow](<.github/workflows/test.yml>).
The historical main-branch Windows 131/131 results are **not validation of this
merge or Linux execution**; see the [validation record](<docs/validation.md>).
No service, firewall rule, certificate or Node installation is performed by this guide.

## 1. Private configuration and migration

Place the checkout under the service user's home. The
[example user unit](<examples/workbuddy-azure-bridge.service>) assumes
`$HOME/workbuddy-azure-local-proxy`; adjust its paths for your actual checkout.
From the repository root:

```bash
node --version
node --test *.test.js
for source in *.js *.cjs; do
  [ -f "$source" ] || continue
  node --check "$source" || exit 1
done
# Set restrictive permissions before creating any environment or key files.
umask 077
# Never overwrite an existing configuration, including a symbolic link.
if [ ! -e .env ] && [ ! -L .env ]; then
  (set -C; cat .env.example > .env)
else
  printf '%s\n' 'Existing .env preserved; edit it privately.'
fi
chmod 600 .env
```

The [placeholder-only template](<.env.example>) is not a production configuration.
Edit your private `.env` locally; do not paste credentials into issues or chat.
The entrypoint defaults to the `.env` beside [bridge.js](<bridge.js>), not a
file discovered from the current directory. `--env-file /absolute/private/path`
selects another file; `--no-env-file` uses only process environment. Process
values override dotenv, and the Node dotenv parser is shared with Windows.

Older Linux settings with only an Azure deployment name must be migrated.
Set all of the following (examples are placeholders):

```dotenv
AZURE_OPENAI_BASE=https://your-resource.openai.azure.com
BRIDGE_APPROVED_ORIGINS='["https://your-resource.openai.azure.com"]'
AZURE_OPENAI_API_KEY=replace-with-your-azure-resource-key
BRIDGE_PROXY_TOKEN=replace-with-a-different-local-bearer-token
AZURE_OPENAI_MODEL=your-gpt6-deployment
AZURE_OPENAI_VARIANT=gpt-6-luna
AZURE_OPENAI_VERSION=2026-09-22
BRIDGE_MODEL_ALIAS=gpt-6-local
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=8787
```

The base must be an explicitly approved HTTPS **origin**, without credentials,
path, query or fragment; do not append `/openai/v1/responses`. The deployment
name, underlying GPT-6 variant, declared version and outward alias are distinct.
The bridge does not discover or verify your Azure declaration. See
[configuration and multi-route migration](<README.md#requirements-and-migration>)
and the [shared contract](<docs/compatibility.md>). Generate a separate token,
for example `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
It must be exact visible ASCII without whitespace and differ from the Azure key.
Only the local bearer token goes into WorkBuddy; the Azure key remains on the host.

## 2. Listener and native TLS

`BRIDGE_HOST` defaults to `127.0.0.1` and accepts only a literal IPv4 or IPv6
address: no hostname, URL, port suffix or IPv6 brackets. Use a stable assigned
LAN address, for example `192.168.1.10`, only when other hosts need access.
`127.0.0.1` and `::1` serve same-host clients; `0.0.0.0` and `::` are wildcard
bindings that can expose VPN and other interfaces. Wildcard addresses are not
client destinations; use a reachable actual IP or certificate-matching hostname.
Bracket IPv6 literals in **URLs**, e.g. `http://[::1]:8787/healthz`.

Binding a specific LAN IP is **not a firewall**. Permit the selected port only
from trusted clients in guest/LXC, hypervisor/Proxmox, host and router rules.
Do not publish it to the Internet. Public `/healthz`, `/readyz` and `/v1/models`
remain unauthenticated on **every bound interface**, exposing service/build/config
identity and configured aliases. Only chat completion requests require the bearer.

Plain HTTP transmits prompts and the bearer token unencrypted. For a shared or
untrusted network, acquire a certificate whose SAN matches the client URL's IP
or hostname and configure **both** paths for native downstream HTTPS:

```dotenv
BRIDGE_HOST=192.168.1.10
BRIDGE_TLS_CERT=certs/bridge-cert.pem
BRIDGE_TLS_KEY=certs/bridge-key.pem
```

Leave **both** TLS settings unset for HTTP; configuring only one is invalid.
Relative paths resolve from the Node process's **working directory**, not from
the environment file's location. Prefer absolute paths for nonstandard layouts.
Keep the private key owner-readable only and out of version control; protect
parent directories as well. Both must be readable regular PEM files, at most
**1 MiB each**; startup/check-only validate regular-file type and use nonblocking
opens before reading. Trust the
issuing CA/certificate on every client and use `https://...`; never use `curl -k`
or disable WorkBuddy certificate verification. A hostname can be used in the
client URL even though the bind setting accepts only a literal IP.

## 3. Foreground run and non-inference checks

```bash
# Validates configured TLS files; opens no listener/log and does not check log writability.
node bridge.js --check-config-json
node bridge.js
```

In another terminal, using the configured address and scheme:

```bash
curl --noproxy '*' http://127.0.0.1:8787/healthz
curl --noproxy '*' http://127.0.0.1:8787/readyz
curl --noproxy '*' http://127.0.0.1:8787/v1/models
# HTTPS with a separately acquired/trusted CA, for example:
# curl --noproxy '*' --cacert /path/to/bridge-ca.pem https://bridge.lan:8787/readyz
```

These GETs do not call Azure. Readiness is local readiness, not proof of Azure
credentials, quota, deployment availability or installed WorkBuddy compatibility.
Config identity includes bind host/port and whether TLS is enabled, but excludes
credentials and TLS certificate/key paths/material. Credential/key/certificate changes still require
an explicit stop/restart; matching public identity does not prove key equivalence.

Configure WorkBuddy through its UI with the full reachable URL, such as
`https://bridge.lan:8787/v1/chat/completions`, local token and configured alias.
Enable Custom Protocol; that switch handles URL paths, not protocol conversion.
See [UI-first setup](<README.md#workbuddy-ui-first-setup>). Authenticated inference
can incur Azure charges and requires separately authorized acceptance testing.

## 4. systemd user service and logging

The [example service](<examples/workbuddy-azure-bridge.service>) runs Node directly,
sets `BRIDGE_LOG_MODE=console` in the process environment (overriding dotenv),
and routes sanitized operational records to journald. Legacy
`BRIDGE_LOG_PATH=/dev/null` automatically selects console only when log mode is
unset; migrate to the explicit mode rather than a device-path workaround.
Explicit file mode rejects that device path. Console mode performs no
log-file creation, rotation or pruning. Protect journal access and configure
journald retention through your administrator's policy.

```bash
mkdir -p "$HOME/.config/systemd/user"
cp examples/workbuddy-azure-bridge.service "$HOME/.config/systemd/user/"
# Review the copied unit before enabling it. Set actual checkout paths and,
# if necessary, an absolute maintained Node executable in ExecStart.
systemctl --user daemon-reload
systemctl --user enable --now workbuddy-azure-bridge.service
systemctl --user status workbuddy-azure-bridge.service
journalctl --user -u workbuddy-azure-bridge.service -n 50
```

For a user-local Node, resolve its executable using
`readlink -f "$(command -v node)"`; replace `/usr/bin/env node` with that absolute
path. systemd does not source your interactive shell or Node version-manager
initialization. The unit's `WorkingDirectory` also determines relative TLS paths.
It sets `UMask=0077` and `TimeoutStopSec=15s`. Shutdown can use one
`BRIDGE_TIMEOUTS.shutdownMs` budget for requests and another for logger cleanup;
keep the unit timeout **at least 2 × shutdownMs plus a safety margin**. The sample
allows 10 seconds plus a 5-second margin with the default `shutdownMs=5000`.
Increase it when tuning that budget; forced termination can bypass cleanup.

Default application logging outside this unit is `BRIDGE_LOG_MODE=file`.
For file mode under systemd, replace the unit's console environment setting,
create a private writable directory (e.g. `install -d -m 700 "$HOME/.local/state/azure-bridge"`),
and set an absolute `BRIDGE_LOG_PATH` inside it. Keep `UMask=0077` and grant only
that directory via `ReadWritePaths=/home/YOUR_USER/.local/state/azure-bridge` in
the copied unit; its `ProtectSystem=strict`/`ProtectHome=read-only` otherwise prevent
writes. File mode also mirrors sanitized records to stdout/journald; adjust the
copied unit's output policy if duplicate journal storage is unwanted.
Real startup validates a writable regular active file and creates a missing file
with mode `0600`, but does **not** chmod an existing file; inspect/tighten its
permissions privately. Rotation uses exclusive hardlinks to preserve existing
archives across restarts, so require a filesystem with hardlink support and
**one writer per log path**. Rotation and retention need archive-directory write
access, not just a writable active file; startup appendability does not prove
those operations will work. Never use a shared or sensitive unrelated directory for logs.
See [file rotation and limits](<README.md#resource-bounds-and-diagnostics>).
User-service hardening support depends on the distribution's user namespace policy;
verify status/journal rather than assuming these settings are enforced everywhere.

An administrator must authorize `sudo loginctl enable-linger "$USER"` if the
user service must start on boot without login; check
`loginctl show-user "$USER" -p Linger` and verify actual reboot behavior.
Stop with `systemctl --user stop workbuddy-azure-bridge.service`.
After reviewing a code/config/certificate update, rerun offline tests and use
`systemctl --user restart workbuddy-azure-bridge.service`. No install or restart
is performed as part of development validation.

## Troubleshooting

- Startup configuration rejection: check approved origin, alias/variant/version,
  paired readable TLS files, literal bind IP and distinct credentials privately.
- No connection: check service status, `ss -ltn`, routing, configured address and
  scheme, certificate trust and all guest/host firewalls.
- `EADDRNOTAVAIL` at boot: the selected address is not yet assigned; check stable
  DHCP/static addressing and service journal. network-online ordering in a user
  unit alone is not a guarantee that the selected IP is ready.
- `401`: the client must send the exact local bearer token, not the Azure key.
- `429/503/504` or SSE errors: distinguish capacity, shutdown, timeouts and upstream
  failure using sanitized stage/code/retry fields; a 503 alone is not proof of a
  bad Azure key. Do not replay already-emitted tool calls automatically.
- File log failures: verify a private directory, owner permissions and systemd
  write allowance; use console/journald when persistent file output is unnecessary.
- Public checks succeeding do not establish real Azure or WorkBuddy acceptance.
  Follow the separately approved [acceptance plan](<docs/acceptance.md>).
