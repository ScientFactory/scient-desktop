# Oh My Pi in Scient

Oh My Pi is an external coding agent. Scient talks to the `omp` executable over its RPC
interface. It does not embed Oh My Pi's Bun SDK, and it does not run Oh My Pi through ACP.

Oh My Pi keeps its own home, credentials, skills, extensions, and model sign-in. Scient does not
offer a universal sign-in. Scient never runs Oh My Pi's own updater, because `omp update` cannot
install a chosen version, follows npm `latest` across major versions, and has no rollback.

You can use Oh My Pi in two ways:

- **Your own installation.** When provider update checks are on, Scient shows a notice for a newer
  stable release in the same major version, read from the channel that installed it: npm `latest`
  for bun, npm and the standalone installer, the `can1357/tap` formula for Homebrew, and the GitHub
  release for mise and as a fallback. A failed check is retried on the next refresh. The notice
  gives the command to run yourself, usually `omp update`, and names Scient-managed Oh My Pi when
  Scient has a qualified private runtime for your computer. Nix installations are not checked.
- **Scient-managed Oh My Pi.** On the desktop app for macOS (Apple silicon and Intel), Windows
  (x64 and ARM64) and Linux (x64 and ARM64, glibc), Scient can install a private copy of Oh My Pi (18.2.8 in the catalog bundled with this release) through the same
  install, repair, update and removal pipeline as its other managed providers. Each release in
  Scient's catalog is checksum-verified and qualified first, including an RPC handshake and a state
  request against the installed binary. The copy updates only when the catalog has a newer qualified
  release, and only after you click **Update**. It leaves any system installation untouched.

Oh My Pi 18.2.8 or newer, below major 19, is supported. Scient refuses a newer major it has not
qualified instead of guessing.

## Setup

Oh My Pi is off by default. In **Settings > Providers**, enable **Oh My Pi** and set the executable
path when `omp` is not on the server's `PATH`. On the desktop app, you can instead choose
**Install** to use Scient-managed Oh My Pi.

Scient starts one `omp --mode rpc --approval-mode yolo` process for each conversation. With the home
and profile left empty, that process uses the Oh My Pi home and credentials the server's
environment selects (`PI_CODING_AGENT_DIR` or `OMP_PROFILE` when set, otherwise `~/.omp`). Every
Oh My Pi instance with an empty home shares that login. Set **Oh My Pi home**
(`PI_CODING_AGENT_DIR`) or **Oh My Pi profile** (`OMP_PROFILE`) on an instance to give it a separate
agent directory; choose one, not both, because a named OMP profile owns its agent directory. Scient
passes an explicit per-conversation `--session-dir` and stores only the session transcript path it
can prove sits in that directory. If Oh My Pi writes the transcript somewhere else, the live
conversation can continue, and Scient will say that the conversation cannot be resumed.

The first version supports **Full access** only. The launch always passes `--approval-mode yolo`.
It is not an operating-system sandbox. See [Qualification](#qualification) for what has been
verified against a real `omp`; Scient does not claim that every model, extension, or provider
backend is qualified. Scient's own tools, skills, and workspace awareness are available;
see [Scient tools and skills](#scient-tools-and-skills).

## Custom models

For an instance without saved model visibility preferences, the picker initially shows
Anthropic Sonnet 5.5, Opus 5.5 and Fable 5.5, and Codex GPT-6-Astra, GPT-6-Luna and
GPT-6.1-Sol. The Antigravity account route initially shows Gemini 3.8 Flash, Gemini
3.1 Pro, and Claude Opus 4.6. These defaults apply only when the native runtime reports
those IDs. Other entries in these three native groups start hidden, including dated
variants. Other Google routes and model groups keep their existing visibility. This
curation does not verify account access.
The Anthropic catalog uses the same model IDs for OAuth and API-key accounts, so its
visibility defaults apply to that group with either authentication method.

All discovered models remain in **Settings > Providers > Oh My Pi**. Turn on a model's
visibility switch to show it again. Once you customize the list, the saved list takes
precedence over these initial defaults, including when you enable every model. Visibility
preferences belong to the client; another device starts with its own defaults.

Models known to be unavailable stay out of model selectors and automatic selection. They remain
on this instance's provider page with an explanation and their picker switch off. During the server
session, Scient remembers previously discovered models that disappear from a successful catalog
refresh. Refresh after fixing the account or model configuration to make them selectable again.
Changing the instance configuration or runtime version clears that remembered catalog.

Native discovery checks configuration and credentials; it does not prove subscription entitlement,
successful inference, or remaining quota. Models whose access is unverified remain selectable.
Scient does not send paid requests to every model to check access, or infer a denial from a failed
catalog refresh.

Scient's shared **Custom models** settings can attach an OpenAI-compatible, OpenAI Responses, or
Anthropic Messages connection to an Oh My Pi instance. For each attached model, Scient starts the
agent with a small generated OMP extension that registers the model through OMP's provider API.
The extension is passed explicitly with `--extension`; it is not written into the user's OMP
profile, and `--no-extensions` does not disable this explicit extension.

API keys never enter Oh My Pi's environment, the generated extension, or its command-line
arguments. Each Oh My Pi process receives them, with the token for Scient's model endpoint, in a
private file that the extension reads and deletes while Oh My Pi starts (see
[Scient tools and skills](#scient-tools-and-skills)). Model definitions are served over that
authenticated loopback endpoint and refreshed inside the running OMP process when Scient's model
metadata changes. Removing a connection, changing its endpoint or protocol, or rotating its
credential retires that OMP process; the next turn starts a fresh process with the new
configuration. This fail-closed boundary prevents an old credential or removed model from being used
by a live conversation.

A model must have usable context and output limits before OMP advertises it. Automatic models with
unknown limits, and models whose stored credential is unavailable, stay out of the OMP catalog.
Image and reasoning controls are advertised only when the shared custom-model settings explicitly
enable them or provide compatible evidence.

In the model picker, an Oh My Pi instance with both kinds of models shows them in two sections:
**Your Oh My Pi accounts** (models from Oh My Pi's own sign-ins and API keys, grouped by provider)
and **Scient custom models**, where each model is labeled with its connection's name. Select a
section's header to collapse or expand it; Scient remembers the choice on this device. The section
holding the selected model opens with the picker, and searching lists every match.

## What you can do

- Send text and images when the selected model advertises image input, and see streamed replies and
  Oh My Pi tool activity. Oh My Pi reads each command as one line no larger than the frame size it
  advertises at startup (1 MiB for 18.x). Images that fit in that frame with the message are sent
  inline. Larger images, up to 10 MB each, are listed in the message as local files, and Oh My
  Pi's `read` tool opens them for the model (verified with Oh My Pi 18.3.1). An image above 10 MB
  is rejected with a message that states the limit.
- Switch models in the same conversation when Oh My Pi reports them.
- Inspect each tool's command or file target and its latest text output. Scient keeps that
  information when Oh My Pi sends a progress update without repeating it, and bounds large
  inputs and output previews. Stop marks unfinished tools as stopped and retains their partial
  output. A lost process, or a turn that ends without reporting a tool's outcome, marks that tool
  failed because its result cannot be confirmed. A tool that already reported its result keeps
  that result; late or repeated updates do not reopen it.
- Answer Oh My Pi's select, confirm, input, and editor questions in Scient. If Oh My Pi asks
  Scient to open a browser URL, the URL is shown as a safe clickable action in the thread; Scient
  does not open it automatically. The thread history keeps only the URL's address and path, not its
  query, so sign-in parameters such as an OAuth `state` are not stored. When Oh My Pi offers a local
  launch link that redirects to the full URL, the action opens that link.
- Steer a running turn, and stop a turn or background work from the thread banner. Stop closes
  that conversation's Oh My Pi process so detached jobs cannot keep running. The next message
  starts a new process and resumes the conversation. On macOS and Linux, the process runs in its
  own process group and forced stop signals that group. On Windows, stop uses `taskkill /T /F`;
  Scient has not verified that against a live Oh My Pi child-process tree. A turn still open when
  the process closes is recorded as aborted.
- See model failures as failed turns. Oh My Pi reports a model error, an unexpected abort, or a
  retry that gave up inside the turn rather than as a protocol error; Scient marks the turn failed
  with Oh My Pi's message (up to 512 characters). A reply cut off at the output limit completes and
  keeps its `length` stop reason. A failed compaction is shown as a warning.
- See subagent activity in the same conversation when Oh My Pi accepts subagent updates. If that
  command is missing, the conversation still starts and subagent updates stay hidden. Scient does
  not create a separate thread for each subagent. Oh My Pi runs subagents as background jobs that
  can outlive their turn, and stopping a turn does not stop them, so a subagent stays shown as
  running under the turn that started it until it reports its own end, Oh My Pi reports the session
  settled, or the conversation closes. When a background subagent finishes after its turn ended,
  Oh My Pi may run the agent again on its own to read the result; Scient shows that as a
  continuation in the same thread, including after a turn whose outcome was uncertain. You can
  send a new message while background work is pending. With Oh My Pi 18.3.1 or newer, your
  message's turn ends only when Oh My Pi reports that message's own result, so a background run
  that starts at the same moment cannot end it early. If that result never arrives, the turn is
  marked uncertain after a minute of idle waiting. An acknowledged message that never starts
  is bounded the same way; active generation, compaction, and unanswered questions do not count.
  When a background result reaches Oh My Pi while it answers you, the answer can use it, and the turn shows a "Background result" entry where it arrived.
  Slash commands wait until background work settles, because Oh My Pi would reject some of them
  as busy; Scient says so and sends nothing. The same applies to a model change or command if a
  background run resumes while the message is being prepared.
- Send `/compact` when this conversation's command list includes it. Scient does not show a compact
  button for Oh My Pi, because native compaction has not been confirmed against a live `omp`.
- See only explicitly qualified Oh My Pi command names in the provider snapshot. Session,
  export, sharing, model, configuration, and extension commands are hidden and rejected even when
  OMP discovers them. A slash invocation Oh My Pi does not know, such as a pasted
  `/Users/alice/notes.md` path, is sent as ordinary text, exactly as OMP would treat it. When
  command discovery itself fails, every slash invocation stays blocked so an unreported command is
  never forwarded. Scient does not import those commands or skills into its own skill library.
  The settings list is a conservative built-in list from a probe that adds `--no-session
--no-tools --no-extensions --no-skills --no-rules`; a running conversation validates against its
  live profile-specific catalog without publishing that catalog globally.
- Rely on a fixed event set. With Oh My Pi 18.3.1 or newer, Scient pins the session's events to the
  kinds it understands (`set_event_filter`) at startup, so a new Oh My Pi event cannot break or
  flood the conversation. Older releases do not have the command; their unknown events are reported
  once and ignored.

While Scient activates, repairs, or removes its private Oh My Pi runtime, a new Oh My Pi process for
that executable (a conversation, a status check, a title or commit message, or a custom-model test)
waits for up to 30 seconds and then fails with "Oh My Pi is being updated". The activation first waits
for running turns and stops idle conversations, then waits up to 30 seconds for short background
work to finish; if a conversation or that work is still running, the change fails and the previous
runtime stays in place.

### Environment

Every Oh My Pi process inherits the Scient server's full login environment, like Scient's other
providers: model-provider keys and cloud credential chains (for example AWS for Bedrock and
`GOOGLE_APPLICATION_CREDENTIALS` for Vertex), `GH_TOKEN`, `GIT_*`, the SSH agent, proxies and
certificates, toolchains such as `JAVA_HOME` and `DOCKER_HOST`, and Oh My Pi's own variables such as
`PI_CODING_AGENT_DIR`, `OMP_PROFILE` and `PI_CONFIG_DIR`. The provider instance's environment
variables apply on top.

Scient removes its own server internals before starting the process: every variable starting with
`T3CODE_`, `T3_`, `SCIENT_` or `VITE_` (server ports, homes, auth and MCP tokens, analytics and dev
settings), `ELECTRON_RUN_AS_NODE`, `ELECTRON_RENDERER_PORT`, `PORT`, and
`PI_CODING_AGENT_SESSION_DIR`, which Scient sets per conversation. Names are matched without regard
to case. Only what the Scient server inherited is filtered: a variable you configure on the
instance is passed as you set it, whatever its name, except `PI_CODING_AGENT_SESSION_DIR`. Scient adds no
variables of its own: the credentials for custom models and for this conversation's Scient tool
connection reach Oh My Pi another way (see [Scient tools and skills](#scient-tools-and-skills)). An instance **Oh My Pi home** replaces any inherited `PI_CODING_AGENT_DIR`,
`OMP_PROFILE` and `PI_PROFILE`; an instance **Oh My Pi profile** replaces any inherited
`OMP_PROFILE`, `PI_PROFILE` and `PI_CODING_AGENT_DIR`. Scient also adds `127.0.0.1`, `localhost`
and `::1` to `NO_PROXY`, so an inherited proxy never receives the requests Oh My Pi makes to
Scient's own local endpoints. `NO_PROXY` and `no_proxy` both get every entry either of them had,
plus these, because tools disagree about which spelling wins.

Native OMP rollback and fork commands are not exposed. On qualified desktop targets, Scient can
install and manage a private Oh My Pi runtime; that managed path is separate from the system
installation.

## Scient tools and skills

Each conversation's Oh My Pi process also loads a second generated extension, passed with
`--extension` next to the custom-model one. It makes the Scient tools authorized for that
conversation available to Oh My Pi, including Scient skills, and appends Scient's workspace
awareness to Oh My Pi's system prompt. The tools use the same names as with Pi, such as
`scient_skills_list` and `scient_skill_load`, and appear in Oh My Pi's main tool list. Oh My Pi's
own skills stay separate and keep their native names.

The extension file is private to your account, holds no credential, and is deleted when the
conversation's process closes. If the Scient server itself crashes, the next start removes the
extension files, and any credential file Oh My Pi never read, that it left behind. The tool connection's address and token, and your custom-model
keys, are handed to each Oh My Pi process in a private file that its extensions read and delete
while Oh My Pi starts, before any tool runs. They are never in Oh My Pi's environment, so commands
the agent runs cannot see them. Subagents that Oh My Pi runs inside the same process get the same
Scient tools. Every tool call is
checked by Scient against the permissions granted to that conversation. Stopping the conversation
revokes the token, so a leftover process cannot keep using Scient tools. Nothing is written to your
project or to your Oh My Pi home.

## Resume

A resumed conversation reopens only the session file recorded for that provider instance and
identity. Scient stores that file under a hashed directory, not the raw thread id. The resume
identity is the provider instance, the effective Oh My Pi home and profile, the workspace, the RPC
protocol, and the Oh My Pi major version. The executable is not part of it: the transcript lives in
Scient's own per-conversation session directory, so switching between a system installation and
Scient-managed Oh My Pi, or a package-manager upgrade that moves the executable, resumes the same
conversation. The cursor also records the launch policy and the last Oh My Pi request id when one
exists. Scient does not use that id to skip a prompt, so sending the same prompt again can run the
work again. Resume checks that the file is a readable regular file inside that directory after
resolving symlinks. A cursor from another instance, workspace, home or profile, protocol, major Oh My
Pi version, or an unreadable path is rejected.

Cursors written before this identity format are handled explicitly. A cursor from the first
format, whose executable identity depended on `PATH`, is rejected with a message asking you to start
a new session. A cursor from the second format resumes when its recorded scope still matches this
instance, session directory, workspace, home and profile; otherwise it is rejected with the same
message.

## Qualification

The evidence covers macOS Apple silicon only:

- opt-in suites run against a real system `omp` 18.3.1, each in a temporary home with synthetic
  keys and local stub or Ollama models: discovery, session start and stop, a full model turn and
  resume, custom models and their refresh, inline and `read`-tool images, Scient tools and
  awareness, and background jobs: a continuation, Stop, and a message sent while a job runs;
- the background continuation and Stop cases against the Scient-managed 18.2.8 binary, which
  keeps the first turn open across a job's pause instead of reporting pending work;
- the Scient-managed 18.2.8 runtime: install, RPC handshake, state request, reloading its install
  record, and removal;
- recorded 18.3.1 protocol captures (success, reasoning, tool call, abort, authentication and
  unknown-model errors, retries, output-limit stop) replayed through the client and adapter.

The Scient-managed runtime pipeline has also been run natively on macOS arm64 and x64, Linux glibc
arm64 and x64, and Windows x64 and ARM64 hosted runners with Oh My Pi 18.4.3: download, checksum,
smoke test, the RPC handshake and state request after install and after repair, and removal (five
times on each Windows runner). The bundled 18.2.8 binaries for targets other than macOS arm64 have
not been run natively; a qualified newer release from the catalog supersedes them when update
checks are on.

Conversations on Windows and Linux (process-tree cleanup during a turn, full model turns) and
hosted-account flows are not claimed by this evidence.

Scient's shared native provider event log records Oh My Pi's notifications and every command Scient
sends with its response, the same diagnostics other native providers produce. Before anything is
written, Scient redacts API keys and tokens it knows (credential variables in the environment, your
custom-model keys, the model endpoint token, and the Scient tool token), key- and bearer-shaped
strings, authorization and cookie headers, image data, and what you type into an Oh My Pi prompt.
The same known keys and tokens are removed from everything the conversation shows, so a provider
that echoes a rejected key back (`401 Incorrect API key provided: ...`) shows `[REDACTED]` in the
turn error and warnings. A key shorter than 12 characters, such as a placeholder `ollama` key for a
local endpoint, is redacted in errors and logs but left in ordinary replies and tool output.

Oh My Pi's own files are outside Scient's control. Oh My Pi 18.3.1 writes a provider's error
message, including a key the provider echoed, to its log under `~/.omp/logs` (it follows `HOME`,
not the Oh My Pi home setting) and to the conversation's session transcript in Scient's state
directory. Oh My Pi has no setting to turn its file log off, and its session file is needed to
resume the conversation.
