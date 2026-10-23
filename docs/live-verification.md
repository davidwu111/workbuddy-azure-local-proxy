# Live verification harness — approval required, not run

**Status: no live check has been run. This document does not authorize spending, an Azure request, a bridge restart, or any change to a running service.** It describes a guarded procedure for a future operator-approved probe. The harness (`live-check.cjs`) was **not executed** for Step 6; only its refusal path was checked without credentials. No real key, token, Azure origin, or deployment name appears here.

## Scope and evidence boundary

The harness sends bounded Chat Completions requests to the bridge's **local** `POST /v1/chat/completions` endpoint. It never contacts Azure directly and never reads `.env` or another configuration file. The bridge remains responsible for the configured Azure origin, credential, routing and native/feature policy.

A successful run can show only that one approved alias answered one bounded Chat request through the local bridge. It does **not** establish:

- native `POST /v1/responses` behavior or transport preservation;
- tool, MCP, audio, code-interpreter, file-search, web-search or image behavior;
- Azure deployment/version/region support, quota, cache behavior, latency or price;
- Linux, installed-client or production-listener behavior.

The 53-event Chat acceptance matrix is an offline test, not live evidence.

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

As of **2026-10-23**, no live check has been run against Azure or a bridge deployment. The offline suite and the Step 6 acceptance matrix use synthetic payloads and in-process writers only. The harness's missing-approval refusal path was observed with exit code `2` and no evidence file; that is a guard check, not a live probe. **This document does not authorize spending.** A future run requires a separate approval covering every field above.
