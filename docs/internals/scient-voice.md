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
one ready-model-only citation-comment mount, footer busy-state layout, one
IPC method-group loop, one preload-adapter mount, and one call from the desktop
artifact builder into the Scient-owned runtime staging adapter. Voice behavior
does not live in `ChatComposer.tsx`, the inherited preload, or the artifact
orchestrator.

Voice uses the host footer's surface and normal layout. While busy, the composer
retains the provider icon, hides and inerts ordinary toolbar actions, and stays
expanded. The citation microphone shares the idle card's right-side actions.
Both hosts keep the voice control mounted as its presentation changes. Recording
uses a centered lane beside a reserved action rail. Permission, transcription
and correction labels align with the waveform's left edge inside that lane,
using softer placeholder-colored, regular-weight text.

The waveform retains 112 recent levels in fixed-width bars with fixed gaps.
The lane reserves its full width, but bars appear progressively from left to
right as audio arrives. Worklet cadence is halfway between the original
2048-sample chunk rate and the preceding midpoint cadence. That preceding
cadence averaged the original rate and approximately 56 measurements per
second; both steps round to whole samples. At the usual 24 kHz recording rate
this is about 23 measurements per second, filling the full-width waveform in
about 4.9 seconds. Narrow viewports fill sooner and clip the oldest bars from the left
as soon as their visible width is filled; new speech stays visible at the right.
Audio capture retains all frames independently of the display history.
Waveform updates follow incoming worklet messages rather than a continuous
animation loop. Inline errors have a bounded width and ellipsis with the full
human-readable message available on hover. Presentation strips internal error
names and uses concise copy for recording-duration validation.

## Reliability invariants

- A generation token invalidates permission prompts, model setup, recording,
  and transcription that complete after cancel, dismiss, unmount, or a newer
  operation.
- Each new renderer transcription carries an immutable request ID through IPC.
  Cancellation only aborts the matching active request; stale and unknown IDs
  are harmless. Legacy cancellation can only affect an identity-less request.
  New renderers on older hosts invalidate local results without issuing global
  cancellation; already-running host inference may finish in the background.
- Automatic-stop completion is bound to the recording generation. Cancel or
  unmount during the final audio flush suppresses delivery of that clip.
- The Whisper adapter requests segment text and concatenates it verbatim,
  omitting the server's synthetic separator newlines. Whitespace inside segment
  text is preserved; optional correction runs after this normalization. Appending
  dictation preserves the existing draft, including intentional trailing spacing.
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

Citation comments consume this existing setup rather than providing another
model-management surface. Their microphone is absent until the desktop reports
a selected, verified, ready model. The comment control revalidates readiness
before recording and disappears without a placeholder if setup is missing or
cannot be verified; first-use choice, downloads, repair, and removal remain in
the composer and Settings → Voice.

## Runtime provenance and packaging

Signed macOS builds include `NSMicrophoneUsageDescription` and the hardened
runtime `com.apple.security.device.audio-input` entitlement on both the main
app and its Electron helpers. The main app retains its additional passkey
entitlements when configured; helpers use the shared baseline entitlement file.
Before capture, the desktop voice bridge requests native macOS consent if it is
not determined. A denial offers System Settings recovery; a restriction reports
that the Mac's policy must be changed. Cancellation or unmount while the native
prompt is open must prevent recording when that prompt later resolves. Other
platforms and older desktop bridges retain the renderer permission flow.

Packaging and mocked permission tests do not prove the macOS consent dialog.
Release validation requires a signed app with fresh microphone permission state,
covering approval and recording, denial and recovery, and an existing grant.

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

### Development apps on one machine

Every development app has its own state, so each one would otherwise build the
helper and download its models again. Development apps share both through
`~/.scient-next/dev-shared/voice/`; a released app never reads or writes it.

- **Helper.** `pnpm voice:runtime:stage` copies the helper from
  `whisper-runtime/<version>-<commit>-<platform>-<arch>/` when another checkout
  has already staged this exact pinned build, and adds what it builds. The dev
  launcher does the same copy before each start and never builds. An entry is
  used only if its receipt names this version, commit, platform and
  architecture and every file matches the recorded size and checksum.
  Packaging does not use this folder.
- **Models.** A model found in `models/` is copied into the app's own model
  folder and verified exactly like a download before it is installed; a model
  an app installs is copied there. Models are never used in place, so removing
  or repairing one in a dev app affects only that app. A removed model stays
  removed until that app is restarted or the model is requested again.
- **Choice.** A dev app with several models and no choice of its own starts
  from the model last chosen in another dev app (`selected-model.json`).

Microphone permission is granted by macOS to each app identity and cannot be
shared: a new development app asks once.

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
