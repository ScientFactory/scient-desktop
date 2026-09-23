# OMP v18.2.8 qualification fixtures

These fixtures were captured from the official macOS arm64 `omp` release
`18.2.8` (SHA-256 verified against the release `SHA256SUMS.txt`) using an
isolated `HOME`, agent directory, workspace, and `--session-dir`.

The fixtures are intentionally redacted and minimized. They preserve the
wire shapes needed by the RPC client and runtime tests without retaining
user prompts, credentials, machine paths, or model-generated content.

- `startup.jsonl`: ready frame, protocol negotiation, and a local command
  catalog update.
- `state-and-models.jsonl`: representative `get_state` and
  `get_available_models` responses with absolute paths replaced by
  placeholders.
- `prompt-events.jsonl`: the beginning of a real prompt lifecycle, including
  the user `message_start`/`message_end` pair that must not be projected as
  assistant output.

The live qualification run was performed outside the repository. The binary
is not committed.
