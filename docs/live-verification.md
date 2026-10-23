# Live verification harness — approval required, run once on 2026-10-23

**Status: one authorised native capture run was made on 2026-10-23 under approval reference `approved-yefan`; no other live check has been run.** That run used the native capture harness against the local bridge only, and its six shapes are recorded below. This document does not authorize spending, an Azure request, a bridge restart, or any change to a running service. The Chat harness (`live-check.cjs`) was **not executed** for Step 6; only its refusal path was checked without credentials. No real key, token or Azure origin appears here.

## Scope and evidence boundary

The harness sends bounded Chat Completions requests to the bridge's **local** `POST /v1/chat/completions` endpoint. It never contacts Azure directly and never reads `.env` or another configuration file. The bridge remains responsible for the configured Azure origin, credential, routing and native/feature policy.

A successful run can show only that one approved alias answered one bounded Chat request through the local bridge. It does **not** establish:

- native transport: only an authorized run of the `capture-native.cjs` capture harness can speak to `POST /v1/responses` behavior or transport preservation; one such run exists (2026-10-23, approval `approved-yefan`) and is recorded below, but it covers only those six shapes;
- tool, MCP, audio, code-interpreter, file-search, web-search or image behavior;
- Azure deployment/version/region support, quota, cache behavior, latency or price;
- Linux, installed-client or production-listener behavior.

The 53-event Chat acceptance matrix is an offline test, not live evidence.

## Native route capture (added, run once on 2026-10-23)

The `capture-native.cjs` harness exists at the repository root and has been run **once**, on 2026-10-23 under approval reference `approved-yefan`, through the local bridge to the approved Azure deployment. Before that run only its refusal path and its `--dry-run` path had been exercised; the six sanitized captures now in `test-fixtures/azure-responses/captured/` are its only output. It posts exactly one request to the local bridge's `POST /v1/responses` at `BRIDGE_LIVE_BASE_URL`; it never contacts Azure directly and never reads `.env`.

Each `--shape` value asks for one deliberately minimal exchange:

- `flat-error` — provokes a provider rejection so the real flat error payload is recorded.
- `reasoning-nullable-summary` — observes whether reasoning items carry `summary: null`.
- `annotations-null` — observes whether `output_text` parts carry `annotations: null`.
- `image-streaming` — exercises image generation with `stream: true`.
- `output-boundary` — sends `max_output_tokens` at the configured cap.
- `multi-call` — asks for two function calls.

One authorised run covered all six shapes on 2026-10-23 under approval reference `approved-yefan`, against the local bridge with alias and deployment `gpt-6-luna`, variant `gpt-6-luna`, declared version `2026-09-22`, PAYG.

| Shape | Observed | What it establishes |
|---|---|---|
| `flat-error` | `HTTP 400` with the JSON body `{"error":{"message":"logprobs are not supported with reasoning models.","type":"invalid_request_error","code":"unsupported_parameter","param":"include"}}`; no SSE `error` event. | A pre-flight validation failure returns a flat JSON error rather than an SSE frame. The flat SSE `error` event remains unobserved. |
| `reasoning-nullable-summary` | `HTTP 200` stream, 9 events, and no reasoning item at all for a one-word answer even with `reasoning:{effort:"low",summary:"auto"}`. The separate non-stream `output-boundary` response did contain one: `{"id":"rs_...","type":"reasoning","content":[],"encrypted_content":"gAAAA..."}`, with `summary` serialized as an empty array. | That short request can return no reasoning item, and a reasoning item can arrive with empty `content` plus `encrypted_content`. An explicit item-level `summary: null` was not observed on this deployment. |
| `annotations-null` | `HTTP 200` stream; the `output_text` part carried `annotations: []` and `logprobs: []`. | Only the empty-array form was seen; an explicit `null` for either field was not observed. |
| `image-streaming` | `HTTP 400` with `{"error":{"message":"imagegen deployment must be provided through header: x-ms-oai-image-generation-deployment","type":"image_generation_user_error","code":"invalid_request_error","param":"tools"}}`. | Azure requires a routing header that the bridge never forwarded from clients. `models.<alias>.nativeHeaders` now supplies it from configuration; this capture predates that change and was not re-run. |
| `output-boundary` | `HTTP 200` non-stream at `max_output_tokens:128000`; usage `input_tokens 13`, `output_tokens 18`, `reasoning_tokens 11`. | This deployment accepted the 128000 cap for this request once. |
| `multi-call` | The first run failed mid-stream with `bridge.error` / `invalid_native_shape` after `response.function_call_arguments.delta`, because the event registry required `name` on `response.function_call_arguments.done`. After `name` was made optional and type-checked when present, the same request produced 11 events and two function calls (`probe_a`, `probe_b`), each `.done` carrying `arguments` and no `name`, terminal status `completed`. | Azure omits `name` on that event because the name belongs to the item; the relaxed check suffices for this shape once. |

The guards below are all enforced before any socket is opened; any failure prints one bounded line and exits `2`:

| Guard | Requirement |
|---|---|
| `--shape` | One of `flat-error`, `reasoning-nullable-summary`, `annotations-null`, `image-streaming`, `output-boundary`, `multi-call`. |
| `BRIDGE_LIVE_APPROVAL` | Non-secret reference, 1-128 printable ASCII characters; rejected if it looks like `sk-`, `Bearer`, a JWT or a 32+ hex secret. |
| `BRIDGE_LIVE_BASE_URL` | Absolute `http(s)` URL with no credentials, query or fragment; a non-loopback host also requires `BRIDGE_LIVE_ALLOW_REMOTE=1`. |
| `BRIDGE_LIVE_TOKEN` | Bearer token for the local bridge. |
| `BRIDGE_LIVE_TIMEOUT_MS` | Optional integer 1000-120000 ms; default 30000. |

Optional shape inputs are `BRIDGE_LIVE_ALIAS`, `BRIDGE_LIVE_IMAGE_MODEL` and `BRIDGE_LIVE_MAX_OUTPUT_TOKENS` (integer 1-1000000).

Placeholder-only invocations (a dry run opens no socket):

```text
BRIDGE_LIVE_APPROVAL=<approval-reference> BRIDGE_LIVE_BASE_URL=http://127.0.0.1:8787 BRIDGE_LIVE_TOKEN=<proxy-token> node capture-native.cjs --shape flat-error --dry-run
BRIDGE_LIVE_APPROVAL=<approval-reference> BRIDGE_LIVE_BASE_URL=http://127.0.0.1:8787 BRIDGE_LIVE_TOKEN=<proxy-token> node capture-native.cjs --shape flat-error
```

`--dry-run` prints the exact request body and exits `0` without opening a socket; the second line is only the shape a real run would take. There are no retries, redirects are refused (`redirect: "error"`), and a body larger than 8 MiB or an SSE line larger than 200000 bytes exits `3`.

A run writes `test-fixtures/azure-responses/captured/<shape>.json` as UTF-8 with mode `0600`, using the schema `{shape, capturedAt, approval, endpoint, status, contentType, request, events, response, notes}`, where `events` holds the parsed SSE payloads in order and `response` holds the JSON response or the terminal event's `response`.

Evidence never includes request or response headers. The token and the approval reference are replaced with `[redacted]` wherever they appear; `sk-` runs of 20 or more characters, header-shaped keys, and any `*_key`/`*_token` string longer than 16 characters are also redacted. If the token still appears in the serialized JSON, the capture is refused with exit `4`.

`captured-fixtures.test.js` replays any capture that is present and skips a shape whose file is absent; it also scans captures for credential-shaped strings.

A capture proves only that one deployment returned one shape once. It does not establish version support, quota, cache behaviour, price, or compatibility with any client.

## Approval fields

A separate, explicit approval must name every field below before the harness may run. The approval reference is the only approval value the harness reads; the rest govern the operator's procedure.

| Field | Requirement |
|---|---|
| Approval reference | Non-secret, bounded, 1–128 printable ASCII characters; recorded in evidence. Never use a token or key. |
| Azure origin | Exact approved resource origin, recorded in the approval (not in this document or evidence). |
| Alias / deployment / variant / version | Exact configured local alias and the Azure deployment, variant and version it maps to. The harness receives only the local alias. |
| Permitted prompt | Exact harmless prompt text. The harness sends it but never records or prints it. Keep it ≤200 characters. |
| Max calls | Integer 1–3. The harness issues at most this many sequential probes and stops on the first failure. |
| Output cap | Integer 1–512 output tokens. |
| Budget and stop condition | Currency cap, time window, maximum calls, and the rule to stop on any non-2xx, timeout, stream error, missing `[DONE]`, or ambiguous observation. |
| Evidence location and retention | Exact output path, who may read it, retention deadline and deletion method. Default `./live-evidence.json`; never overwrite an existing file. |
| Listener and remote policy | Approved loopback host/port; non-loopback base URLs are refused unless a separate approval explicitly sets `BRIDGE_LIVE_ALLOW_REMOTE=1`. |
| Operator and window | Named operator and approved execution window. |

Do not place a key, local bearer token, prompt, response body, or tool data in the approval record, evidence, commit, screenshot or report. Prefer the token environment variable over `--token`, because a command-line token can appear in process listings.

## Guard model

The harness refuses before any network code runs unless all of these are present and valid:

- `BRIDGE_LIVE_APPROVAL`
- `BRIDGE_LIVE_MAX_CALLS` (integer 1–3)
- `BRIDGE_LIVE_MAX_OUTPUT_TOKENS` (integer 1–512)
- `--confirm`
- an explicit base URL and local alias
- an explicit bearer token for the local bridge

Exit codes:

- `2` — refused by a guard (no network attempt).
- `1` — a probe ran but the run was not fully successful, or evidence could not be written.
- `0` — every approved call completed with HTTP 2xx, a parsed stream and `[DONE]`.

There are **no automatic retries**. A non-2xx response, timeout, stream error or missing `[DONE]` stops the run immediately. An unreachable bridge is reported as unreachable without a retry.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `BRIDGE_LIVE_APPROVAL` | Yes | Non-secret approval reference, 1–128 printable ASCII characters. |
| `BRIDGE_LIVE_MAX_CALLS` | Yes | Integer 1–3. Maximum sequential probes. |
| `BRIDGE_LIVE_MAX_OUTPUT_TOKENS` | Yes | Integer 1–512. Sent as the Chat output budget. |
| `BRIDGE_LIVE_BASE_URL` | Yes unless `--base` | Local bridge base URL or exact Chat endpoint. Loopback by default. Must not contain credentials, a query or a fragment. If the path is not already `/v1/chat/completions`, the harness appends it (or `/chat/completions` to a path ending in `/v1`). |
| `BRIDGE_LIVE_TOKEN` | Yes unless `--token` | Bearer token for the local bridge. Never printed or recorded. |
| `BRIDGE_LIVE_MODEL` | Yes unless `--model` | Configured local model alias. |
| `BRIDGE_LIVE_PROMPT` | No | Approved prompt, ≤200 characters. Defaults to a fixed harmless sentence. Never recorded. |
| `BRIDGE_LIVE_ALLOW_REMOTE` | No | Set to exactly `1` only with separate approval for a non-loopback base URL. |
| `BRIDGE_LIVE_TIMEOUT_MS` | No | Per-request timeout, integer 1000–120000 ms; default 30000. |
| `BRIDGE_LIVE_OUT` | No | Evidence path; `--out` wins; default `./live-evidence.json`. |

CLI flags: `--confirm` (required), `--base <url>`, `--token <token>`, `--model <alias>`, `--out <path>`. `--help` prints usage and performs no probe.

## Exact step order

The harness needs the local bridge running. Starting it belongs to step 3; do not restart it again during the probe.

1. **Stop the bridge.** Confirm the approved listener is no longer accepting connections.
2. **Back up the configuration.** Keep the backup outside the repository and outside the evidence directory; restrict access; record its location in the approval, not in a tracked file.
3. **Enable the native flag only if needed, then start the bridge.** This harness uses Chat, so `BRIDGE_NATIVE_RESPONSES` is not required and should stay at its approved value (default off). If a separate native check is approved, record the old and new flag values. Start the bridge with the approved loopback listener, TLS/trust settings and alias routing; verify process identity and that the configured alias resolves as approved.
4. **Run the harness.** Set the approval and limits, export the local token without echoing it, and pass `--confirm`. Example shape (placeholders only): `node ./live-check.cjs --confirm --base "http://<loopback-host>:<port>" --model "<approved-alias>" --out "<evidence-path>"`. Do not add retries or a second invocation because the first was inconclusive.
5. **Record the evidence.** Confirm the file exists at the approved path, is not world-readable where the platform supports modes, and contains no prompt, token, header, body or tool data. Record the operator, time, approval reference and observed result in the approval log.
6. **Restore.** Stop the bridge; restore the backed-up configuration; confirm the native flag and every other changed value match the backup; restart only if the approved operating state requires it; verify the listener and configuration identity. Retain or delete the evidence exactly as approved.

## Stop and rollback conditions

Stop immediately and do not retry if any of these occurs:

- HTTP status is not 2xx;
- the request times out or the bridge is unreachable;
- the SSE stream is malformed, errors, or ends without `[DONE]`;
- usage, finish reason or alias identity is ambiguous;
- the approved call or currency cap would be reached;
- the listener or configuration identity differs from the approved one.

Rollback:

1. Stop the bridge if it is still running.
2. Restore the backed-up configuration exactly; do not hand-edit around the backup.
3. Confirm `BRIDGE_NATIVE_RESPONSES` is absent or `false` unless the approved operating state says otherwise.
4. Diff the restored configuration against the backup; confirm file modes, listener binding and TLS settings.
5. Restart only when approved, then verify process/listener identity.
6. Preserve any sanitized evidence required by the approval; delete it at the retention deadline. If an incident requires retention, keep only the sanitized record.

A refused or failed harness run is **not** permission to try again. A new run needs a new or amended approval and a new evidence path.

## Recorded evidence

The JSON evidence contains only:

- UTC timestamp and schema version;
- approval reference;
- endpoint host and port (never the full URL);
- local model alias;
- approved limits;
- attempted/completed call counts and overall outcome;
- per call: HTTP status, latency, sanitized `finish_reason`, sanitized numeric usage counters, whether `[DONE]` was seen, outcome and a bounded error code.

It never records the prompt, request/response bodies, headers, `Authorization`, the token, model output, tool data, or raw provider error text. Unknown usage keys are dropped. The file is created with mode `0600` and an exclusive-create flag; an existing file is never overwritten. On Windows, POSIX mode is requested on a best-effort basis and is not a substitute for filesystem ACLs.

## Evidence record skeleton

```json
{
  "schema": "azure-bridge/live-evidence/v1",
  "recorded_at_utc": "<ISO-8601 UTC>",
  "approval_reference": "<non-secret-approval-reference>",
  "endpoint_host_port": "<loopback-host>:<port>",
  "model_alias": "<approved-local-alias>",
  "limits": {
    "max_calls": 1,
    "max_output_tokens": 64,
    "timeout_ms": 30000,
    "remote_allowed": false
  },
  "calls_attempted": 1,
  "calls_completed": 1,
  "overall": "completed",
  "stop_reason": null,
  "calls": [
    {
      "call": 1,
      "http_status": 200,
      "latency_ms": 0,
      "finish_reason": "stop",
      "usage": {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0
      },
      "done_seen": true,
      "outcome": "ok",
      "error_code": null
    }
  ]
}
```

This skeleton is illustrative only; its zeroes and placeholders are not measured evidence. A real record must be produced by an approved run.

## Current status

As of **2026-10-23**, the only live check that has been run is the single authorised native capture run recorded above; no other live check has been made against Azure or a bridge deployment. The offline suite and the Step 6 acceptance matrix use synthetic payloads and in-process writers only. The Chat harness's missing-approval refusal path was observed with exit code `2` and no evidence file; that is a guard check, not a live probe. **This document does not authorize spending.** A future run requires a separate approval covering every field above.
