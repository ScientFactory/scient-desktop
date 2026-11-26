# Transcription

Scient dictation and recordings share the environment speech service, model
catalog and native worker. The Scient composer and citation controls capture
dictation. The Transcription settings page manages models and engine choices.
On desktop, Electron handles microphone permission and offers to remove
previous local model files after successful catalog dictation. Local inference
runs on the environment host. Supported cloud bindings and ChatGPT use their
respective server adapters. Mobile retains its provider-only cloud compatibility
route during the transition. Its OpenAI, xAI and OpenRouter slots use the
connected environment's designated Accounts key or external credential
reference. Mobile Set Key updates that slot and the server resolves its key
when handling an upload.

## Recording jobs

The server accepts authenticated commands at `POST /api/transcription/jobs`.
Commands require filesystem read and write grants and the orchestration operate
grant. Paths refer to the server host. The server runs one long transcription
at a time.

| Action               | Body fields besides `action` and `project`                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`              | Absolute `source`, `engine`, `model`, `language`, optional `rule`, `providerInstanceId`, `cloudEngineId`, `resume`, `range`, correction `mode`, `subtitleMode`, and `subtitles` |
| `status`, `cancel`   | Revision `id`                                                                                                                                                                   |
| `discover-subtitles` | Absolute media `source`                                                                                                                                                         |
| `use-subtitles`      | Absolute media `source` and `subtitles` selection                                                                                                                               |
| `list`               | None                                                                                                                                                                            |

`list` accepts `includeCreated` to include revision timestamps and sort newest first. With `query`, it also returns a short matching excerpt from a completed transcript.
`inventory` accepts an optional `language` and `details` flag. It returns
engine availability and recommendations without account secrets.
`revision` takes a revision `id`. A completed revision returns the published
segments and correction review items. An unfinished revision returns segments
from complete checkpoint records without modifying the ledger.

The Recordings UI registers copied media with `media-register` and reads it
with `media-list`. `recording-rename` stores a shown `title` in the media
record; an empty title returns to the file name, and registering again keeps
it. `recording-trash` moves the media file, every revision directory whose
`job.json` names that source, and their notes to the host's Trash, then
removes the media record. It refuses while the source is queued or
transcribing. These registrations stay in the project if the dialog is
dismissed. `start-batch` accepts up to 20 recordings in one project and runs
them serially through the same job admission and checkpoint pipeline. Pending
batch requests live in process memory. `pause` stops the active job with its
checkpoints intact. An explicit resume fails if its original settings,
vocabulary or source have changed. An explicit rerun gets a fresh revision.

### Lessons

A microphone capture can be a lesson. `capture-start` takes the capture `id`
and the recording `language`, renews the capture lease and returns the
recording default engine for that language as `captions`
(`{ kind: "local", modelId }`, `{ kind: "cloud", engineId }` or
`{ kind: "chatgpt", instanceId }`), or `transcription: "unavailable"` when no
engine can transcribe. Dictation carries no project, so a cloud default whose
key is kept for one project gets no captions; its job still uses that key.
`talk.openai` says whether an OpenAI speech engine with
upload consent exists.

The window cuts its own microphone stream into clips at a pause after 10
seconds, or at 30 seconds, and sends each to `voice.dictate` with that engine.
One clip is transcribed at a time and one waits; a newer clip replaces the
waiting one. `capture-caption` saves each result by window index under the
capture directory and rewrites `captions.md` there. Captions are provisional
and are deleted with the capture.

`capture-finish` with `lesson: { language }` publishes the recording, then
starts a normal transcription job with the recording default, as
`transcription: "started"`, or `"queued"` behind the running job. The job is
marked `lesson` in `job.json`. It uses Quick correction when the default is
Thorough, because nobody is there to approve an estimate. When it completes, the server makes notes with
the `lesson` recipe, which reads the whole transcript section by section. A
nonempty project notes recipe replaces the built-in lesson instruction. The
direct `notes.md` generator skips lesson jobs. Finishing keeps every saved
chunk in index order, so a lost chunk costs only its own audio. The window
keeps the lease while it saves, and the server refuses later chunks, captions
and touches for a capture it has already published.

`capture-talk` takes the window's WebRTC offer, resolves the key of the first
OpenAI speech engine with upload consent, and posts the offer to
`https://api.openai.com/v1/realtime/calls` with `gpt-realtime-2.1`. Its
instructions carry the latest captions that fit in 24,000 bytes. The key stays
on the server; the window reads the call's events on its own data channel. For
ChatGPT, notes `lesson-talk` with the capture ID launches a **Lesson questions**
project thread that knows the captions path, and the window holds a Scient
Agent live voice call in its own agent for that thread.

The authenticated notes endpoint, `POST /api/transcription/notes`, uses the same
grants and resolves a registered project before accessing revisions. Each notes
recipe (`summary`, `study-notes`, `action-items` or `lesson`) launches a project-root thread with the Transcripts skill. Its manifest
associates the thread and Markdown output with the recording's root revision,
so notes stay visible when the user switches transcript versions. Ask drafts store their thread ID, source revision and source-time range alongside the recording.

`project` is the absolute project folder. Use `auto` for automatic language
selection. Local jobs use the `local` engine and take an installed speech
catalog model ID or an absolute path to a local GGUF. ChatGPT jobs use
`chatgpt` for both engine and model and use the configured Codex instance.
Pass `providerInstanceId` to select an instance. Otherwise the server uses the
first enabled Codex instance. The OpenAI engine uses `gpt-transcribe`, and the
xAI engine uses `grok-voice-transcribe-2.0`. The OpenRouter engine uses a
configured transcription model and requests zero data retention.

Both decode passes start at the beginning. The first counts planned windows.
The second streams PCM again and recognizes only unfinished speech windows.
The decoder uses the host's `ffmpeg` or the server's `SERVE_EMU_FFMPEG` override.
Silero gates all window rules. Local jobs default to `meetily` unless the model
name identifies Cohere, which defaults to `fixed` at 28 seconds. Text-only
providers can explicitly request `short` for finer window-level timestamps.

Each revision has a directory under `Transcripts/`. `results.jsonl` is the
synced checkpoint ledger. It stores sample mappings and text for completed
windows. `transcript.json` and `transcript.md` are rebuilt from the committed
prefix. Resume uses the same revision if its source, decoder, engine and
settings fingerprints match and it is unfinished. A rerun creates another
revision. Text-only engines use source-window bounds and use `und` when they
return no language and none was selected. Local results use `und` under the
same condition. Transcript clients can derive direction from the segment
language and use the text to resolve unknown or mixed-language segments.

## Words

Global Words live in server settings. Project Words live in
`Transcripts/words.json`, and recording Words live in the recording directory.
A narrower scope wins when normalized term and language match. Dictation
reads the global and registered project vocabulary through `voice.readWords`
on the draft's environment. It passes at most 16 ranked suggestions to
recognizers that accept them, and applies explicit spelling variants
separately to the transcript. Correction uses the ranked vocabulary as context.

### Released-client transition

The legacy dictionary remains an additive compatibility view for older
clients. New terms and aliases fold into Words. The legacy protocol sends
whole snapshots without a base revision or an explicit deletion, so an
omission only removes the entry from that compatibility view. Use the Words
editor for authoritative edits, deletions, and language-specific entries.
Project writes are buffered in
server settings until the Words file can record the imported snapshot and
the number of applied writes together.

The client moves its legacy dictionary into a read-only archive after the
first confirmed server receipt. It keeps the batch and an acknowledgment per
environment so later connections can import it.
`MINIMUM_SUPPORTED_WORDS_CLIENT_VERSION` stays unset during the transition.
Set it to the enforced client version only after desktop and mobile use
Words, the old/new protocol matrix passes, and archives have reached all
intended environments. Until then, keep the legacy read, write, and audio
adapters, the project write history and receipts, and the client archive.

## Local worker arbitration

The environment speech service leases its ASR worker to recording jobs for
one recognition window at a time. Queued local dictation runs before the next
window. When the current window blocks dictation for two seconds, the service
retires the worker and repeats the unfinished window after dictation. The
abandoned attempt never reaches the checkpoint ledger. The Silero scoring
session keeps its state across ASR windows. Model and Silero transfers are
shared by artifact, and canceling one waiter preserves a transfer with other
waiters.

The HTTP route accepts ad-hoc project folders from sessions holding all three
required grants. Register or resolve project IDs before enabling this action
for project-scoped clients.

## Dictation batch RPC

Send `voice.dictate` a base64 24 kHz mono PCM16 WAV from the Scient recorder
with up to 180 seconds of audio. Pass `selection` as one of these shapes.

| `kind`    | Required field                                              |
| --------- | ----------------------------------------------------------- |
| `local`   | `modelId` from the installed speech catalog                 |
| `cloud`   | `engineId` for an account-bound cloud speech configuration  |
| `chatgpt` | `instanceId` for an enabled provider with ChatGPT dictation |

The optional `language` applies to the selected engine. A local model must
support the requested language. Local and account-bound cloud selections
receive audio resampled once to 16 kHz. ChatGPT receives the original WAV.
The RPC returns `{ text }` for the existing draft delivery and correction
flow. ChatGPT uses the selected instance’s sign-in. An account-bound cloud
engine requires upload consent for its current destination, which the server
checks again before each request. The agent upload setting governs agent-started
jobs.

While the local RPC is pending, poll `voice.dictationWait`. Its `waiting`
flag becomes true only when a dictation request has queued for two seconds.
Both RPCs require the environment orchestration operate scope.

## Agent access

The Scient transcription tools use the calling thread's verified project.
Start accepts a project-relative or absolute audio path that resolves inside
that project and uses catalog IDs for local models. File inputs must be
standalone media. Optional ranges use source seconds. Transcript timestamps
retain the source audio's time origin. Start and status can wait up to 30
seconds. A wait ending leaves the job running. The engine inventory reports
cloud configuration and ChatGPT connection and sign-in separately. A sign-in
probe that cannot finish returns an unknown sign-in state. Use the optional
language filter and details flag for model metadata.

The server setting **Agents may send audio to cloud engines**
(`transcription.agentsMayUseCloudEngines`) defaults to on. This applies to
agent-started ChatGPT and other cloud recognition jobs, including resumes.
Local defaults choose an installed Whisper model, with installed ivrit.ai
turbo preferred for Hebrew. Select Cohere Arabic or Parakeet explicitly to
use those alternatives.

After persisting a completed, failed, or canceled agent job, the server queues
a background notification in its originating thread. The message is kept with
the thread across client reconnects. A stable command ID deduplicates notices
for the same revision, thread, and outcome. A wait may return the result before
the queued notice is delivered. A process restart interrupts active jobs and
leaves them available for resume by revision ID.

## Accounts and dictation

The Accounts-backed speech adapter resolves the API-key account on the
server for its configured provider origin. Engine configuration stores the
account ID. Job provenance identifies the provider and account display name.

When dictation adopts speech bindings, resolve the bound account inside the
server speech service. Continue accepting existing mobile cloud-voice settings
and use the legacy settings credential when no account binding is configured.

`POST /api/transcription/engines` requires settings write and provider management.
Send `{ "action": "list" }` to list configurations. Add takes `provider`,
`model`, `accountId`, and `maxAudioBytes`. For `compatible`, include
`baseUrl` through the API prefix, such as `https://api.openai.com/v1`.
Update takes the same fields and the engine `id`. Remove and test take only the
action and ID. Test sends one second of silent audio and returns a status.

Create an Accounts API-key record with `details.speechOnly: true`, bearer
authentication, the provider origin in `sites`, and the token saved in Scient.
The speech-only designation is set at creation. Loopback HTTP endpoints use an
exact origin including the port. The agent-facing Accounts tools omit these
records, and connector and agent secret resolvers reject them.

For a cloud job, send `engine: "cloud"`, `cloudEngineId`, the configured
`model`, and the usual job fields. The provider-specific engine names also
accept a binding to that provider. The WAV planner applies the configured byte
limit and the duration limit of the selected rule.

## Correction and vocabulary

Pass `mode` (`off`, `quick`, or `thorough`) to `start`, or submit
`correct` with a completed revision `id` to create a child revision. The
server uses Quick by default when the text-generation selection refers to
a configured generator or enabled provider. `notes` supplies optional
context. Text generation uses the selected provider and the existing
text-generation routing policy. Each revision records that selection and
the correction prompt version.

Quick requests edits for flagged, low-confidence, and glossary-mismatch
segments. Thorough also checks variants observed elsewhere in the recording,
sends bounded context, and can corroborate proposals with a second recognition
pass. A proposed edit must preserve IDs, timing, digit runs, negation, token
order and script to auto-apply. Sentence marks can only be added at the end of
a segment when the following segment signals a new sentence. Names and notation flagged by the model, and
edits outside the automatic rules, go to review. The transcript keeps raw text
and an audit of applied edits and their reasons. Status and provenance report
why correction was skipped when a model is unavailable or there are no targets.

Correction requests an object with segment proposals and suggestions through the
configured generator. Codex uses its output schema, OpenAI-compatible APIs use
JSON Schema, and Anthropic APIs use tool input. A failed or rejected response
gets one repair attempt, with plain JSON as the fallback for custom model APIs.
The preflight includes that attempt. Transcript provenance records rejection
codes by window and attempt.

Use `review-accept` or `review-reject` with the completed revision `id` and
zero-based `item` index from its review items. Each decision creates a child
revision on top of the latest completed revision for that recording. Acceptance
updates the segment and retires competing proposals for that span. Rejection
records the decision and retains the segment text.

Use `correction-estimate` with a completed revision `id`, or an absolute
recording `source` and optional `language`, plus the intended correction
options. For an existing revision the preview counts segments and targets.
For a fresh recording it budgets calls and tokens from its measured duration.
The configured text-generation interface exposes no tokenizer. The preview
estimates one token per four characters for general text, two for Hebrew and
Arabic, and one for Han and Japanese kana. Fresh recordings use a duration-based
projection. Pricing uses configured usage rates when known.
Thorough requires the returned `estimateId` on `start` and `correct`.
The job records the estimate it uses.

For Thorough re-listen, pass `relisten` with a stronger installed local
`model`, `audioSeconds`, and `wallSeconds`. The correction pass runs within
its estimated call budget and limits local re-listen by both audio and wall
time. Local re-listen has zero provider charge. The estimate covers correction
and re-listen.

The words commands use `level` (`global`, `project`, or `recording`).
Recording operations also take a revision `id`. `words-list` returns the
scope's entries. `words-add` and `words-remove` take a `word`, identified
by term and language. A word may include a preferred spelling, variants,
and a note. Use `suggestions-list` with a completed revision `id`, then
`words-accept` with the selected `word` and its `suggestionRevision` ID.

Global words use server settings. Project words live beside the transcripts.
Recording words live with the first revision and follow its lineage. Each job
snapshots a ranked vocabulary. Compatible native engines, OpenAI, and xAI
receive a subset as recognition hints. Recording notes also supply context to
prompt-capable native engines. Native prompts use a 96-token budget
with the model tokenizer and a UTF-8 byte budget when it is unavailable. A
split retry drops hints. `recognitionHints` in the transcript
indicates that the recognizer received terms.
Before starting a cloud job, call the engine API with
`{ "action": "set-upload-consent", "id": "...", "allowed": true }`.
Consent persists until revoked or the engine is updated. Provenance records the
approved endpoint origin and that upload consent was present. Agent starts also
require the server setting `transcription.agentsMayUseCloudEngines` (default
on), labelled **Agents may send audio to cloud engines**.

Speech keys are released only to an exact origin. Plain HTTP is available for
literal loopback addresses `127.0.0.1` and `[::1]`. Any local process that takes
the configured port can receive the clear-text bearer key. Use a dedicated
local credential for a loopback endpoint.

Accounts activity records each attempted upload's provider, speech account and
job ID. Connection tests appear as `connection-test`. The recognizer retries
confirmed connection failures before upload, honors bounded `Retry-After`
values, and retries server errors at most once. A 429 without a retry time the
server can honor pauses the job. Success bodies are limited to 1 MiB per window.

### Subtitle sources

The jobs endpoint accepts `discover-subtitles` for a media path. It lists text and
unsupported embedded subtitle streams and neighboring subtitle files. Embedded
stream selections use the absolute FFmpeg stream index. File selections use an
absolute path and can specify `language`, `zoom-vtt` or `teams-docx` when needed.
Discovery looks for `ffprobe` beside the configured absolute `SERVE_EMU_FFMPEG`
path, then on the server's PATH. Detection of captions inside
video streams depends on FFprobe reporting their presence.

Start a local job with `subtitleMode: "assess-subtitles"` and a `subtitles` selection to
receive an assessment directly without creating a revision. Agreement uses
sampled local ASR as a reference. Language matching can fall back to text
inference when the model or track supplies no language.
The current thresholds are heuristic. A separate `use-subtitles` request starts a cancellable job that publishes
an aligned transcript with speaker attribution where available and records the
timing correction under `transcript.json`’s `subtitles` key, without opening an ASR engine. A start job with `subtitleMode: "both"` uses
aligned subtitle words as vocabulary hints with OpenAI, xAI, or a local model that supports vocabulary or prompts.
Subtitle-assisted requests start fresh revisions.

### Saved speech keys

The server resolves an Accounts key for speech using the exact destination origin, bearer authentication and a Scient-sealed value. General API keys, Custom models keys with compatible authentication, and speech-only keys can be used within their configured project scope. A scoped key requires a known project, including at the upload boundary. Agent-read controls govern access to the credential itself. Agent-started audio uploads also require the transcription cloud-upload setting and the engine's consent.

Engine setup requests for Add, Update, and Test accept the intended `projectId`. The server checks the key against that project and sends a specific error if it falls outside the key's scope. The project selection is used for the setup check. Job start and upload still check the running job's project.
