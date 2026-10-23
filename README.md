# Azure GPT-6 Responses Bridge

A dependency-free Node.js adapter (loopback by default; opt-in LAN binding and native TLS): **WorkBuddy Chat Completions → Azure Responses → Chat Completions**. Azure performs inference; this is not an offline model or a complete implementation of either API. It targets explicitly configured GPT-6 variants, keeps Chat-history replay stateless, and makes unsupported semantic requests fail locally instead of silently changing them.

**Evidence boundary:** The integrated Linux/shared-core offline suite passed **339 of 343 tests (4 Linux-only skips, 0 failures)** on Windows with Node **24.14.0** and **22.22.2**; syntax checks passed on both. Historical main-branch results were 131/131. These Windows checks do **not** establish actual Linux/systemd execution. See the [validation record](<docs/validation.md>) for separately recorded checks and environment boundaries. Node 22/24 Windows/Linux CI is configured; no hosted-CI, Linux execution, installed WorkBuddy, Azure deployment, cache savings, or real workload acceptance is claimed. See the [approval-gated acceptance plan](<docs/acceptance.md>), [implemented contract and official evidence](<docs/compatibility.md>), [staged compatibility plan](<docs/staged-compatibility.md>), and [F01–F21 disposition](<docs/review-disposition.md>). The [2026-10-23 review](<docs/review-2026-10-23.md>) records the current open findings and the phase plan.

## Requirements and migration

- Node.js 22 or newer; supported CI targets are Node 22 and 24.
- An independently authorized Azure resource with GPT-6 Responses support and an API key. No SDK/npm installation or Azure CLI is required by this bridge.
- A separate local bearer token, a trusted HTTPS Azure origin, and an explicit deployment/variant/version mapping.

Older configuration that only supplies a deployment name is no longer sufficient. Arbitrary request `model` values no longer select any deployment accessible with the Azure key. Implementation work and offline checks do not read or modify production secrets; normal startup loads the private environment file you select.

## Configure without sharing credentials

Use the placeholder-only [environment template](<.env.example>). Create a private `.env` beside the [entrypoint](<bridge.js>) **only if it does not already exist**; otherwise edit your existing configuration privately. Never overwrite a production environment file with the template. The file is plaintext and should be readable only by its owner. Process environment values take precedence over dotenv values; the launcher and entrypoint use the same Node dotenv parser.

Minimal single route:

```dotenv
AZURE_OPENAI_BASE=https://your-resource.openai.azure.com
BRIDGE_APPROVED_ORIGINS='["https://your-resource.openai.azure.com"]'
AZURE_OPENAI_API_KEY=replace-with-your-azure-resource-key
BRIDGE_PROXY_TOKEN=replace-with-a-different-local-bearer-token
AZURE_OPENAI_MODEL=your-gpt6-deployment
AZURE_OPENAI_VARIANT=gpt-6-luna
AZURE_OPENAI_VERSION=2026-09-22
BRIDGE_MODEL_ALIAS=gpt-6-local
```

`AZURE_OPENAI_BASE` must be an HTTPS **origin**, without credentials, path, query, or fragment. Do not append `/openai/v1/responses`. `BRIDGE_APPROVED_ORIGINS` must explicitly include that exact trusted origin; this supports explicitly approved sovereign/private/custom origins without guessing a domain suffix. Requests use `redirect: "error"`; HTTP upstreams are limited to an explicit injected loopback test seam, not a production environment switch.

`AZURE_OPENAI_MODEL` is the **Azure deployment name**. `AZURE_OPENAI_VARIANT` identifies the underlying model; `AZURE_OPENAI_VERSION` records the operator-declared deployment version. `BRIDGE_MODEL_ALIAS` is what WorkBuddy sends and sees. The bridge does not query Azure to discover or verify that declaration.

For multiple routes, `BRIDGE_MODELS` is a JSON object whose entries have `deployment`, `variant`, `version`, and optional `profile`. This replaces the single-route identity settings; `BRIDGE_MODEL_ALIAS` must identify the default entry:

```dotenv
BRIDGE_MODEL_ALIAS=gpt-6-local
BRIDGE_MODELS='{"gpt-6-local":{"deployment":"your-luna-deployment","variant":"gpt-6-luna","version":"2026-09-22"},"gpt-6-sol-local":{"deployment":"your-sol-deployment","variant":"gpt-6.1-sol","version":"2026-09-29"}}'
```

Allowed variants are `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, and `gpt-6.1-sol`. Omitting the request model selects the default alias; unknown aliases are rejected before upstream forwarding. Profiles are conservative capability gates, not proof of provider support. Images and `pro` mode are off by default. See [profile overrides and disputed combinations](<docs/compatibility.md#profiles-and-official-evidence>) before changing them.

Generate a separate local token if needed:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put this token only in your private environment and WorkBuddy. It must be **visible ASCII with no whitespace** and match byte-for-byte; leading/trailing spaces, embedded whitespace and non-ASCII are rejected rather than trimmed into a different credential. Do not put the Azure key in WorkBuddy.

## Run and check locally

From PowerShell in the workspace:

```powershell
node .\bridge.js --check-config-json
node .\bridge.js
```

Or use the [Windows launcher](<start-bridge.ps1>): `./start-bridge.ps1 -NodePath "C:\Program Files\nodejs\node.exe"` (replace the executable path). The launcher accepts `-NodePath`/process `BRIDGE_NODE`, `-EnvFile`, `-NoEnvFile`, and `-CheckOnly`. Node discovery prefers the explicit override, then a valid PATH executable, then discovered WorkBuddy-managed versions; it does not install Node or pin an obsolete managed runtime. It validates configuration through `--check-config-json`, then checks matching service/protocol/build/config identity and `/readyz` before accepting an existing listener; it refuses to replace a different answering service. A new bridge runs in the foreground. Stop with `Ctrl+C`; shutdown has a bounded grace period for active requests. No desktop shortcut or scheduled task is created by this patch.

Linux/Debian LXC uses the same shared core without a shell launcher; follow the [Linux deployment guide](<LINUX.md>) for private configuration, LAN/native TLS, firewall/client trust and direct-Node systemd setup.

`BRIDGE_HOST` defaults to `127.0.0.1` and accepts only a literal IPv4/IPv6 address, not a hostname/URL or bracketed IPv6. Opt into a specific assigned LAN IP only when needed; `0.0.0.0`/`::` bind all interfaces and are not client destinations. `BRIDGE_TLS_CERT` and `BRIDGE_TLS_KEY` must either both be unset (HTTP) or both name readable files (native HTTPS). Relative TLS paths resolve from the Node process working directory, not the environment-file directory. Trust the certificate on clients and use the matching HTTPS URL; never disable TLS verification. Restrict LAN access with a firewall: binding an address does not implement access control, and the public GET endpoints below remain unauthenticated on every bound interface.

Liveness, readiness and model listing do not call Azure. These examples use the default local HTTP listener; substitute the actual address/scheme for LAN/TLS (bracket IPv6 literals in URLs):

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/readyz
Invoke-RestMethod http://127.0.0.1:8787/v1/models
```

| Method | Path | Authentication / purpose |
|---|---|---|
| `GET` | `/healthz` | Public on the bound interface: liveness with service/build/protocol/configuration identity |
| `GET` | `/readyz` | Public on the bound interface: readiness, distinct from liveness |
| `GET` | `/v1/models` | Public on the bound interface: allowed alias list |
| `POST` | `/v1/chat/completions` | `Authorization: Bearer <BRIDGE_PROXY_TOKEN>` |
| `POST` | `/v1/responses` | `Authorization: Bearer <BRIDGE_PROXY_TOKEN>`; native Responses create, only when `BRIDGE_NATIVE_RESPONSES=true` and per-alias grants allow the requested features |

## Native Responses route (opt-in)

`POST /v1/responses` exposes the Azure Responses API without Chat translation. It is disabled by default and enabled only with
`BRIDGE_NATIVE_RESPONSES=true` and an explicit restart. Routing, bearer authentication, TLS and the trusted-origin/redirect rules are identical
to the Chat route; the outbound target is the configured origin plus `/openai/v1/responses`, and client-supplied Azure or session headers are
never forwarded.

The route is stateless and deny-by-default. The accepted top-level fields are `model`, `input`, `instructions`, `stream`, `max_output_tokens`,
`reasoning`, `tools`, `tool_choice`, `parallel_tool_calls`, `text`, `store` and `background` (false/null only). Hosted tools, input media,
file/vector-store/container IDs and MCP servers require an explicit per-alias grant in `BRIDGE_NATIVE_POLICIES`; plain function tools need no
grant. Unknown fields fail locally, and recognised-but-deferred fields return `unsupported_parameter` rather than being forwarded.

Provider storage needs three independent opt-ins: `BRIDGE_ALLOW_STORE=true`, `nativePolicies[alias].allowStore`, and `store:true` on the
request. Background jobs, response/conversation chaining, `include`, and the retrieve/delete/cancel routes are not implemented;
`background:true`, `previous_response_id`, `conversation` and `include` are rejected locally.

Streaming relays native event types, metadata, ordering and numeric usage. It never fabricates Chat chunks or `[DONE]`, and a mid-stream
failure emits one bounded `bridge.error` event. Tool calls are validated against the request's declared tools and grants, and are never
executed locally.

See the [native request contract](<docs/native-responses-api.md>), [feature permissions](<docs/native-feature-permissions.md>),
[SSE contract](<docs/native-sse-contract.md>) and [design record](<docs/responses-api-design.md>).

Configuration is validated before listening. `/healthz` reports liveness; `/readyz` reports local readiness, **not** that Azure credentials, quota, deployment availability, or WorkBuddy have been verified. Public config identity includes bind host/port and whether TLS is enabled, but deliberately excludes credentials, credential fingerprints and TLS key material. After changing credentials or TLS key/certificate files, explicitly stop/restart the running bridge; matching health identity does not prove credential/key equivalence. Port defaults to 8787; changing host, `BRIDGE_PORT` or TLS also requires updating the WorkBuddy URL. The Windows launcher is a local HTTP/loopback convenience and refuses LAN/TLS configuration; use direct Node for LAN/TLS.

## WorkBuddy: UI-first setup

In **Settings → Model**, add a **Custom** model:

1. URL: `http://127.0.0.1:8787/v1/chat/completions` (full local path).
2. API key: the local `BRIDGE_PROXY_TOKEN`, never the Azure key.
3. Model name: the configured alias, for example `gpt-6-local`, not necessarily the Azure deployment or model ID.
4. Enable the **Custom Protocol** advanced switch. Official WorkBuddy documentation says this only bypasses URL path validation/auto-completion and sends to the entered URL; it **does not** convert Chat requests into Responses. This adapter performs conversion.
5. Function-tool calling can be configured for the supported subset. Keep **`supportsImages: false`** until the installed-client/adapter/deployment path has been separately verified. Reasoning display is provider-generated summary text, not raw hidden reasoning or persisted state.

The public client docs do not establish a full wire contract for `reasoning_content`, extension-field round-tripping, usage chunks, session IDs, cancellation, or sampling defaults. Capture sanitized fixtures and record the exact installed WorkBuddy build before claiming compatibility. Do not edit a guessed internal configuration file when the UI suffices. [Official WorkBuddy model configuration](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model).

## Request and privacy policy

The [compatibility contract](<docs/compatibility.md>) enumerates supported, rejected, and ignored fields. The [staged compatibility plan](<docs/staged-compatibility.md>) explains the four-way classification and the WorkBuddy 5.8.3 field policy. Important policies:

- Standard Chat Completions fields are **recognised**, then classified as mapped, deliberately normalized, standard-but-unsupported (`unsupported_parameter`), or unknown (`unknown_parameter`). A field is never accepted and then silently dropped.
- Exact disabled/unset defaults are normalized (nullable options, zero penalties, empty bias/stop, text-only modalities, disabled logprobs). Enabled semantic controls the bridge cannot honour are rejected rather than clamped or replaced.
- Explicit supported effort is preserved, including `none` for Sol/Luna; Astra/6.1 Sol reject `none`. A profile-rejected effort is `unsupported_parameter`, never substituted.
- Sampling combinations are gated by effective effort/profile. Default policy rejects incompatible values. `BRIDGE_SAMPLING_POLICY=drop-defaults` only removes incompatible `temperature` or `top_p` exactly equal to `1`, and reports field names; it never silently replaces effort.
- `BRIDGE_INSTRUCTION_POLICY=reject-mixed` rejects mixing system and developer roles; other explicit policies preserve or normalize roles in chronological order, with block boundaries intact.
- WorkBuddy's message-level `startsNewUserRequest` (boolean), `agent` and `conversationRequestId` (bounded opaque JSON) are validated and ignored by the stateless adapter. None is forwarded to Azure, used as provider metadata, or used to infer session/branch identity. `BRIDGE_CLIENT_METADATA_FIELDS` extends the named list; `BRIDGE_CLIENT_METADATA_MODE=auto` (default) also absorbs any other non-standard message key after bounded validation, recording only its name. Standard/reserved message fields and unknown top-level fields are still rejected in both modes.
- Function tools default omitted or `null` `strict` to explicit `false`; explicit strictness and supported structured-output formats are preserved. Streaming tool-call fields are buffered until the terminal response validates complete calls; text/refusal/summary can still stream incrementally. This intentional tool latency prevents partial-call execution, but still requires actual WorkBuddy verification.
- `store:false` is sent by default; `store:null` resolves to that declared policy. Enabling provider storage requires explicit `BRIDGE_ALLOW_STORE=true` and a request/default storage opt-in. **Stored chaining is still not implemented.** Provider storage and prompt caching are separate controls: `store:false` does not disable prompt caching, keep inference local, or guarantee Zero Data Retention.
- Chat history does not preserve opaque reasoning, phases/compaction state automatically. There is no global previous-response ID or guessed session sidecar. Async tools, WebSockets/steering, cloud built-in tools, and `configuration_update` are deferred.
- Local validation failures log a bounded stage, code, sanitised parameter path and JSON type — never the request body, message text, tool arguments, opaque metadata or upstream error text. Use those fields to diagnose a client mismatch.

## GPT-6 cache controls and cost

The bridge validates `prompt_cache_key`, `prompt_cache_options: {mode: "implicit"|"explicit", ttl: "30m"}`, and supported content-block `prompt_cache_breakpoint: {mode: "explicit"}`. The bridge does not insert automatic explicit breakpoints. Optional environment defaults are `BRIDGE_PROMPT_CACHE_KEY` and JSON `BRIDGE_PROMPT_CACHE_OPTIONS`. Legacy `prompt_cache_retention` is rejected; `24h` is not the GPT-6 fix.

For Standard pay-as-you-go, explicit mode **without breakpoints** disables caching and cache-write charges. Implicit mode uses Azure's default policy plus supplied breakpoints. PTU-M supports automatic caching, but not explicit breakpoints, explicit no-cache policy, or cache-write counters; declare `profile.deploymentType: "ptu-m"` to enforce this locally.

Stable rendered prefixes must match and contain at least 1,024 tokens to be cacheable. Use a stable non-secret prefix-family key; do not generate a random key per request, hash changing history, or reorder tools for speculative hits. A key never guarantees a hit. GPT-6 cache writes can be charged; mapped and raw read/write/reasoning counters must be reconciled with actual Azure deployment pricing and billing. Continuity and caching provide **no guaranteed cost reduction**. [Azure prompt caching](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching).

## Resource bounds and diagnostics

Limits are positive configurable **bytes**, not model-token limits. Tune with workload/concurrency memory measurements; defaults are operational choices and do not claim support for the entire model input window.

| `BRIDGE_LIMITS` key | Default |
|---|---:|
| `requestBytes` | 8 MiB |
| `jsonBytes` | 32 MiB |
| `errorBytes` | 64 KiB |
| `sseLineBytes`, `sseEventBytes`, `sseBufferBytes` | 16 MiB each |
| `responseBytes` | 64 MiB |
| `maxConcurrent` | 16 |
| `maxQueue` | 32 |

`responseBytes` bounds upstream total and encoded downstream independently; `sseBufferBytes` constrains active event framing and retained output separately, not total process RSS. Requests above `maxConcurrent` wait for a slot, bounded by `maxQueue` and `timeouts.capacityWaitMs` (default 30 s); set `maxQueue: 0` for immediate 429. A capacity rejection is `rate_limit_error` with `Retry-After: 1`, and queue time is logged as `queuedFor`. Parallel agent workflows need a cap well above a single conversation's request count. Required MIME is JSON for uploads/nonstream upstream, SSE for streaming upstream.

`BRIDGE_TIMEOUTS` accepts positive milliseconds: `uploadMs=30000`, `upstreamIdleMs=300000`, `downstreamStallMs=30000`, `totalMs=1800000`, `shutdownMs=5000`. Upload, upstream idle, downstream stall and total lifetime are distinct; cancellation remains active while awaiting headers/reader/drain. `BRIDGE_MAX_OUTPUT_TOKENS` defaults to 128000 and bounds the forwarded output budget along with the profile cap. Reasoning and visible output share this cap; a low cap can be spent before an answer appears. The bridge does not tokenize/count full input locally.

Operational logs use the Node process's local timezone with ISO timestamps and an explicit UTC offset (for example `2026-10-21T11:45:08.951+08:00`), and allowlisted fields only; they omit prompts, tool arguments, opaque reasoning and credentials. Logs are not Azure billing or a full audit trail.

`BRIDGE_LOG_MODE` accepts `file` (default) or `console`. Console mode sends sanitized operational records to stdout without creating, rotating or pruning log files; it is recommended for systemd/journald. Legacy `BRIDGE_LOG_PATH=/dev/null` selects console mode only when `BRIDGE_LOG_MODE` is unset; migrate to explicit `BRIDGE_LOG_MODE=console`. Explicit file mode rejects the device path. File mode also mirrors sanitized records to stdout (and journald when captured by systemd). File writes are asynchronous with a bounded queue; saturation drops records rather than growing memory. Real startup requires a writable regular active file and creates a missing one with mode `0600`; it does not tighten permissions on an existing file. File mode requires a private owner-controlled writable archive directory with hardlink support and **one writer per log path** for rotation/retention; on Linux use `umask 077`, directory mode 700 and appropriate systemd write allowances. Startup checks active-file appendability, not all archive-directory operations; `--check-config-json` deliberately does not check log writability. Restrict journal access too. See the [Linux service guide](<LINUX.md#4-systemd-user-service-and-logging>).

In file mode, `BRIDGE_LOG_PATH` selects the active file (default `bridge.log`). It rotates **daily** to a dated sibling such as `bridge-2026-10-21.log`, and mid-day when it would exceed `BRIDGE_MAX_LOG_BYTES` (default 10 MiB) to `bridge-2026-10-21.1.log`, `.2`, and so on. Archives older than `BRIDGE_LOG_RETENTION_DAYS` (default **7**) are deleted automatically, including a legacy `bridge.log.old`; retention checks run at most hourly and only touch files matching this log's own archive names.

Use terminal outcome rather than HTTP 200 alone to judge a stream. First-token timing is the proxy's first text/refusal/summary or validated-tool emission; nonstream timing is completion time, not native Azure TTFT. Safe retry advice is forwarded, not automatically retried. Undeliverable terminal frames on a stalled/disconnected downstream cause closure rather than an unbounded drain wait.

The current build identifies itself as `adapter-v2.11-native-create`. It takes effect only in a newly started process: explicitly stop the old bridge before launching again. The launcher refuses to reuse an older build and never replaces it automatically. Existing log lines are not rewritten; earlier UTC (`Z`) records can coexist with new local-offset records. TLS certificate/key path changes and renewals also require an explicit restart; paths and certificate/key material are excluded from public identity.

## Offline tests and CI

Run all isolated tests and syntax checks without Azure or real credentials:

```powershell
node --test *.test.js
# In a confined environment without test-worker stdio pipes (Node 22/24):
# node run-offline-tests.cjs
# Node 24 also supports: node --test --test-isolation=none *.test.js
Get-ChildItem -File -Path *.js,*.cjs | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE) { throw "Syntax check failed" } }
```

The [CI workflow](<.github/workflows/test.yml>) runs Node 22/24 on Windows/Linux and parses the [launcher](<start-bridge.ps1>) AST on Windows without executing it. Tests use explicit injected configuration and ephemeral loopback fixtures, not production secrets/logs. See [review disposition](<docs/review-disposition.md>) for coverage and residual limitations. Real WorkBuddy/Azure checks require separate approval of [the acceptance plan](<docs/acceptance.md>).

## Windows Task Scheduler (instructions only)

For a persistent service, open **Task Scheduler → Create Task** under the account that owns the private environment and can write logs. Choose an **At log on** trigger and a suitable noninteractive account policy. No task is installed by this repository.

For predictable recovery, point the action directly at an explicit maintained Node executable (rather than a health-check launcher that may exit after finding another instance):

- **Program/script:** the actual Node executable, e.g. `C:\Program Files\nodejs\node.exe` (use the path field/browser; do not include arguments here).
- **Add arguments:** `"C:\Users\<your-user>\azure-bridge\bridge.js"` — quote the full script path, particularly if it contains spaces.
- **Start in:** `C:\Users\<your-user>\azure-bridge` — directory only, no surrounding quotes in this field.
- **Settings:** disable **Stop the task if it runs longer than** (XML `ExecutionTimeLimit=PT0S` for indefinite execution). The Microsoft default is 72 hours, not indefinite.
- Enable **restart on failure**, e.g. every 1 minute with 3 attempts; tune recovery to your needs. Under **If the task is already running**, select **Do not start a new instance**. Review battery/idle conditions so they do not unexpectedly stop a persistent bridge.

Save, run manually, inspect **Last Run Result**, service/config identity at `/healthz`, and sanitized logs. Task Scheduler force-ending a task may bypass graceful cleanup; prefer a normal foreground stop for shutdown checks. Use only actual quoted paths on your machine. [Microsoft execution-time limit](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit).

## Troubleshooting

- **Startup rejects configuration:** explicit trusted origin, distinct nonempty credentials, route/variant/version and profile/default compatibility are required; check locally before listening.
- **401:** WorkBuddy must use the exact local bearer token.
- **400:** a requested semantic field/value is unsupported or malformed; see error `param` and [the contract](<docs/compatibility.md>). Do not remove an explicit budget/effort/cache policy merely to suppress the error.
- **429/503/504 or SSE error:** distinguish local concurrency/timeout, upstream HTTP failure and stream corruption; inspect safe retry advice and correlation IDs. Do not automatically replay emitted tool calls.
- **No reasoning summary:** provider summaries are not guaranteed on every request; the bridge does not synthesize hidden reasoning.
- **Cache miss:** verify a stable ≥1,024-token rendered prefix, unchanged tools/schema/detail and the deployment type. One miss is inconclusive; use separately approved measured experiments.

## 中文简要说明

这是默认监听本机 `127.0.0.1` 的 Chat Completions → Azure Responses 转换器；推理仍在 Azure 执行。可通过 `BRIDGE_HOST` 显式选择 LAN IPv4/IPv6 字面地址，并成对配置 `BRIDGE_TLS_CERT`/`BRIDGE_TLS_KEY` 使用原生 HTTPS；相对证书路径以进程工作目录为基准。LAN 上的健康、就绪和模型列表仍无需认证，必须限制防火墙访问并建立客户端证书信任。Linux/systemd 推荐 `BRIDGE_LOG_MODE=console` 交给 journald；默认 `file` 模式需要私有可写目录。详见 [Linux 部署指南](<LINUX.md>)。必须显式配置客户端别名、Azure 部署名称、GPT-6 变体/版本以及可信 HTTPS origin。WorkBuddy 在「设置 → 模型」中填写完整本地 URL 和单独的本地令牌；Custom Protocol 开关只改变 URL 处理，不转换协议。图片能力保持关闭，直到实际客户端与部署获准联合验证。可选的原生 `POST /v1/responses` 路由默认关闭，需同时启用 `BRIDGE_NATIVE_RESPONSES=true` 并按别名配置 `BRIDGE_NATIVE_POLICIES`；托管工具、输入媒体、文件/向量库/容器与 MCP 默认拒绝。

默认 `store:false`，不实现不透明推理状态连续性；它不关闭提示缓存，也不保证零数据保留或降低费用。GPT-6 使用 `prompt_cache_options`（`ttl:"30m"`），不用旧的 `24h` retention。PTU-M 不支持显式断点。测试只使用离线模拟；实际 WorkBuddy/Azure 验收及其预算须另行批准。Windows 持久任务应配置无限运行、失败重启且不允许实例重叠。完整行为以[兼容性说明](<docs/compatibility.md>)、[分阶段兼容计划](<docs/staged-compatibility.md>)、[审查处置](<docs/review-disposition.md>)和[验收计划](<docs/acceptance.md>)为准。
