# Scient local voice architecture

Status: Scient-owned desktop feature. It is not an upstream T3 subsystem and
does not change T3 provider, thread, project, persistence, cloud, or mobile
contracts.

## Boundaries

- `packages/scient-voice` owns the pinned model manifest, model verification,
  WAV validation, the whisper.cpp loopback runtime, serialization,
  cancellation, timeouts, and lifecycle tests. Its engine API is explicitly
  model-aware and imports neither React nor Electron.
- `apps/desktop/src/app/DesktopVoice.ts` owns model selection and lifecycle
  orchestration over one manager per manifest entry and one shared native
  runtime. IPC projects internal paths out of model state before returning it
  to the renderer. The selected model is persisted in desktop settings.
- `apps/web/src/scient/voice` owns capture, the Electron-client adapter,
  operation guards, and small composer presentation components. The UI depends
  on `VoiceTranscriptionClient`, not directly on whisper.cpp.
- `packages/contracts/src/voice.ts` is the bounded serializable IPC contract.
  The main-process IPC decoder rejects oversized base64 before the core
  allocates its decoded audio buffer, and the core independently enforces the
  10 MiB decoded-audio limit.
- `apps/server/src/scient/voice/` owns optional provider transcript correction.
  It resolves the selected server provider, requires an enabled, installed,
  ready, authenticated instance with an advertised correction capability, and
  applies a bounded provider-specific adapter. `packages/contracts/src/voice.ts`
  also owns the correction request/result/failure contract; client settings
  keep correction disabled by default.

The direct inherited-host changes are deliberately narrow: one composer mount,
one positioned-footer class, one IPC method-group loop, one preload-adapter
mount, and one call from the desktop artifact builder into the Scient-owned
runtime staging adapter. Voice behavior does not live in `ChatComposer.tsx`,
the inherited preload, or the artifact orchestrator.

## Reliability invariants

- A generation token invalidates permission prompts, model setup, recording,
  and transcription that complete after cancel, dismiss, unmount, or a newer
  operation.
- Every recorder start owns its microphone stream and audio graph, so cleanup
  from an older start cannot stop a newer recording.
- A normal stop flushes the AudioWorklet's final partial frame before the graph
  is closed. Cancel intentionally discards it.
- The recorder requests a 24 kHz AudioContext. If the platform chooses another
  hardware rate, the encoder uses area-filtered downsampling rather than
  alias-prone point sampling.
- The shared native runtime serializes inference, while the desktop allows one
  catalog download at a time. A newer transcription cancels the previous
  request. Model removal rejects conflicting model mutations, cancels active
  inference, and stops the helper that may hold the model open before deleting
  files.
- The helper binds to loopback on a random port and a cryptographically random
  request path. It receives only an allowlist of OS environment variables, not
  provider or cloud credentials.
- Recorded audio never enters provider correction. Correction receives only the
  bounded local transcript text and optional language preference. The request
  is limited to 20,000 characters and a 12-second server window, and requires
  the selected provider to be ready and authenticated.
- Transcript correction is fail-open: the exact local transcript remains
  visible and usable while correction is pending, and every unsupported,
  unauthenticated, unavailable, timed-out, malformed, or provider-error path
  falls back to it.
- A model is trusted only after size, GGML header, and SHA-256 verification.
  The first status check in each app process re-hashes the installed model;
  later checks reuse a size/mtime cache for that process.
- Model downloads are cancellable and resumable. App shutdown aborts an active
  download and waits for the native helper to exit. The desktop performs a
  free-space preflight before downloading and returns a safe error when the
  device cannot accommodate the model plus working room.

## Model management

The catalog currently contains three local multilingual Whisper artifacts:

- `Multilingual Small` (`q5_1`, about 181 MiB): the migration-safe default,
  faster and lighter.
- `Multilingual Medium` (`q5_0`, about 514 MiB): higher expected accuracy with
  higher memory and compute requirements.
- `Multilingual Turbo` (Large-v3 Turbo `q5_0`, about 547 MiB): the most capable
  option, reserved by the recommendation heuristic for powerful computers.

The desktop recommends Turbo on a native machine with at least ten available
logical CPUs, 24 GiB RAM, and enough free space. It recommends Medium with at
least eight available logical CPUs and 16 GiB RAM; otherwise it recommends
Small. This is a conservative heuristic, not a benchmark. The recommendation
is advisory and can be changed in Settings → Voice.

Settings exposes each model's download, resumable progress, active selection,
and removal actions. Removing the selected model first switches to another
verified installed model when one exists; otherwise voice returns to setup.
Existing installations retain any valid saved selection. If that selection is
missing, the sole verified installed model is selected without downloading it
again; multiple installed models remain an explicit user choice.

## Runtime provenance and packaging

`scripts/stage-whisper-runtime.ts` stages whisper.cpp `v1.9.1` from commit
`f049fff95a089aa9969deb009cdd4892b3e74916`. Source and supported prebuilt
archives have pinned SHA-256 values. The script asserts the private
`--request-path` behavior from source, preserves the upstream MIT license, and
writes a per-file provenance receipt.

macOS is built from pinned source with Accelerate and embedded Metal support,
with macOS 12 as the explicit helper deployment target. On macOS 11 the voice
runtime fails closed before launch rather than invoking unavailable Metal APIs.
Linux arm64/x64 and Windows x64 use verified upstream archives. There is no
verified Windows arm64 runtime, so that artifact fails closed instead of
silently shipping voice without a helper. Desktop packaging stages the runtime
as an external resource; native executables are never stored in Git.

For a development checkout, run:

```text
pnpm voice:runtime:stage
```

## Deliberate exclusions

M1 does not run speculative background benchmarks, continuous partial
transcriptions, cloud audio transcription, or a mobile voice adapter. Those
would add different privacy, runtime, and stale-draft failure boundaries. The
only provider path is the explicit, default-off correction of already-local
transcript text described above.

The default multilingual Small quantized model keeps setup bounded, but model
accuracy remains a separate product-quality gate. The manifest-driven model
boundary allows additional local models without changing capture, IPC,
composer, or runtime lifecycle code; no larger-model accuracy claim is implied
by this implementation.
