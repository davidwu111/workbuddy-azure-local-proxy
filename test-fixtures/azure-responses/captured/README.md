# Native Responses captures

This directory holds operator-run evidence from [capture-native.cjs](../../../capture-native.cjs), a guarded harness that talks only to the configured local bridge and never reads .env.
No capture file is committed in this revision; this README is the only tracked file here.

## Shapes

- `flat-error` - a real provider error shape from asking for an undeclared tool.
- `reasoning-nullable-summary` - nullable reasoning summary fields.
- `annotations-null` - null annotations with output-text logprobs.
- `image-streaming` - image generation tool streaming events.
- `output-boundary` - the max_output_tokens boundary as a buffered JSON response.
- `multi-call` - parallel tool calls inside one response.

## File schema

```json
{
  "shape": "<shape>", "capturedAt": "<ISO 8601 UTC>", "approval": "<approval reference>",
  "endpoint": "/v1/responses", "status": <number>, "contentType": "<string or null>",
  "request": <sanitized request body>, "events": [<parsed payloads>], "response": <object or null>,
  "notes": "<one bounded sentence>"
}
```

## Guards

- `--shape` one of the six names; `--out` optional; `--dry-run` prints the body and opens no socket. No network work happens before every guard passes.
- `BRIDGE_LIVE_APPROVAL` 1-128 printable ASCII without whitespace, not sk-/Bearer/JWT/hex; recorded as a non-secret reference.
- `BRIDGE_LIVE_BASE_URL` absolute http(s), no credentials/query/fragment/path; non-loopback needs `BRIDGE_LIVE_ALLOW_REMOTE=1`.
- `BRIDGE_LIVE_TOKEN` 1-4096 printable ASCII without whitespace.
- `BRIDGE_LIVE_TIMEOUT_MS` optional integer 1000-120000 (default 30000).

## Command

```sh
node capture-native.cjs --shape flat-error
```

Captures are sanitized (no headers, secrets redacted) but must be reviewed before committing.
