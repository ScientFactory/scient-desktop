# OMP v18.3.1 RPC captures

Real stdin/stdout JSONL recorded from the official `omp` 18.3.1 binary
(`omp/18.3.1`, macOS arm64, sha256
`67b807a99454a4d8e1cf982dce7b3343b2c2fc148f33e403dbfb3f1049b22570`) in RPC
mode. Each run used a fresh temporary `HOME`, `PI_CODING_AGENT_DIR`,
`--session-dir` and workspace, with network egress blocked except loopback.
The model was a local OpenAI-compatible stub server registered through an
`--extension`, so no real provider, credentials, or paid model calls were
involved. `omp update` was never run.

Each line is `{"dir":"in"|"out","frame":{...}}` in wire order: `in` frames
are what the driver wrote to stdin, `out` frames are what OMP wrote to stdout.
Every capture starts with `ready`, protocol v2 negotiation, and `set_model`.

Sanitization: the temporary root is `<TMP>`, the home directory is `<HOME>`,
and the stub port is `<STUB_PORT>`. `get_state` responses have `systemPrompt`
and `dumpTools` replaced with a marker. Everything else is verbatim, including
timestamps and ids. The only key-like string is the stub's own masked
`sk-test-****etic` in the 401 error text.

| Capture                      | Stub behaviour                        | Terminal outcome                                                                                                            |
| ---------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `success-text`               | text stream, finish `stop`            | `prompt_result{status:"completed"}`                                                                                         |
| `success-reasoning`          | reasoning deltas, then text           | `completed`                                                                                                                 |
| `auth-401`                   | HTTP 401                              | assistant `stopReason:"error"`, `errorStatus:401`; `prompt_result{status:"error", error:{httpStatus:401, retryable:false}}` |
| `provider-model-not-found`   | HTTP 404                              | `status:"error"`, `httpStatus:404`                                                                                          |
| `retry-recovered`            | one 429, retried inside the transport | indistinguishable from success                                                                                              |
| `retry-recovered-session`    | twelve 429s, then 200                 | `auto_retry_start`, `completed`, then `auto_retry_end{success:true}` after `session_settled`                                |
| `retry-exhausted`            | 429 always                            | `auto_retry_end{success:false, finalError}`; `status:"error"`, `retryable:true`                                             |
| `length-stop`                | finish `length`                       | `stopReason:"length"`, a compaction `notice`; `completed`                                                                   |
| `stream-error-after-partial` | socket drop after text                | `stopReason:"error"`, no `errorStatus`; `status:"error"`                                                                    |
| `stream-error-event`         | in-band error event                   | `stopReason:"error"`; `status:"error"`                                                                                      |
| `tool-call`                  | `read` tool call, then text           | tool execution frames; `completed`                                                                                          |
| `user-abort`                 | slow stream; host sends `abort`       | `stopReason:"aborted"`; abort response after `agent_end`; `status:"aborted"`                                                |
| `unknown-model`              | none                                  | `set_model` fails with `Model not found: …` (no `code`)                                                                     |
| `available-models`           | none                                  | model list with `thinking{mode, efforts, defaultLevel, requiresEffort}`                                                     |

The captures are copied unchanged from the capture run in
`ScientFactory-worktrees/omp-fixture-captures-20260926`, which also holds the
driver, the stub server, and per-scenario metadata.
