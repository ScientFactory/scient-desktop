# Oh My Pi in Scient

Oh My Pi is an external coding agent. Scient talks to the `omp` executable over its RPC
interface. It does not embed Oh My Pi's Bun SDK, and it does not run Oh My Pi through ACP.

Oh My Pi keeps its own home, credentials, skills, extensions, and model sign-in. Scient does not
offer a universal sign-in. When provider update checks are on, a system installation shows a newer
stable release in the same major version. For an official `omp` executable, Scient runs OMP's own
`omp update --stable` command when you click Update, then verifies the reported version. Scient
does not replace an unknown or custom executable with an assumed package-manager command.
On the desktop app for macOS Apple silicon, Scient can install a private Oh My Pi 18.2.8. That copy
updates only when a reviewed catalog release is newer, and only after you click Update. Enable Oh
My Pi only after `omp` 18.2.8 or newer, and below major 19, is available to the
Scient server. Scient refuses a newer major it has not qualified instead of guessing.

## Setup

Oh My Pi is off by default. In **Settings > Providers**, enable **Oh My Pi** and set the executable
path when `omp` is not on the server's `PATH`.

Scient starts one `omp --mode rpc --approval-mode yolo` process for each conversation. With the home
and profile left empty, that process uses the server's normal Oh My Pi home and credentials. Every
Oh My Pi instance with an empty home shares that login. Set **Oh My Pi home**
(`PI_CODING_AGENT_DIR`) or **Oh My Pi profile** (`OMP_PROFILE`) on an instance to give it a separate
agent directory; choose one, not both, because a named OMP profile owns its agent directory. Scient
passes an explicit per-conversation `--session-dir` and stores only the session transcript path it
can prove sits in that directory. If Oh My Pi writes the transcript somewhere else, the live
conversation can continue, and Scient will say that the conversation cannot be resumed. Session
cursors created by older builds with the previous `PATH`-based identity are rejected rather than
silently migrated; start a new OMP session after upgrading.

The first version supports **Full access** only. The launch always passes `--approval-mode yolo`.
That flag matches the pinned Oh My Pi 18.2.8 interface. The launch, protocol negotiation, model
catalog, and session-directory behavior were qualified against the official macOS arm64 release;
Scient still does not claim that every model, extension, or provider backend is qualified. It is
not an operating-system sandbox. Scient does not register its project or
scientific tools with this provider.

## Custom models

Scient's shared **Custom models** settings can attach an OpenAI-compatible, OpenAI Responses, or
Anthropic Messages connection to an Oh My Pi instance. For each attached model, Scient starts the
agent with a small generated OMP extension that registers the model through OMP's provider API.
The extension is passed explicitly with `--extension`; it is not written into the user's OMP
profile, and `--no-extensions` does not disable this explicit extension.

API keys are placed only in the scoped child process environment under generated variable names.
The generated extension and command-line arguments contain no key. Model definitions are served
over an authenticated loopback endpoint and refreshed inside the running OMP process when Scient's
model metadata changes. Removing a connection, changing its endpoint or protocol, or rotating its
credential retires that OMP process; the next turn starts a fresh process with the new
configuration. This fail-closed boundary prevents an old credential or removed model from being used
by a live conversation.

A model must have usable context and output limits before OMP advertises it. Automatic models with
unknown limits, and models whose stored credential is unavailable, stay out of the OMP catalog.
Image and reasoning controls are advertised only when the shared custom-model settings explicitly
enable them or provide compatible evidence.

## What you can do

- Send text and images when the selected model advertises image input, and see streamed replies and
  Oh My Pi tool activity. An image must fit in one Oh My Pi RPC frame, so images above 512 KiB are
  rejected with an explicit message instead of being silently dropped. Oh My Pi 18.x does not
  reassemble chunked frames sent to it, so this limit stays until that changes upstream.
- Switch models in the same conversation when Oh My Pi reports them.
- Answer Oh My Pi's select, confirm, input, and editor questions in Scient. If an extension asks
  Scient to open a browser URL, the URL is shown as a safe clickable action in the thread; Scient
  does not open it automatically.
- Steer a running turn, and stop it. Stop first asks Oh My Pi to abort and keeps the conversation
  process alive when OMP confirms the turn reached an idle terminal state. If OMP does not settle
  within the cancellation deadline, Scient closes that conversation's process. On macOS and Linux
  the process runs in its own process group and forced stop signals that group. On Windows, stop
  uses `taskkill /T /F`; Scient has not verified that against a live Oh My Pi child-process tree.
  If the turn is still open when the process ends, Scient records the outcome as uncertain and
  names the Oh My Pi request id. A turn Oh My Pi itself reports as failed stays a failure. A stop
  Oh My Pi acknowledges stays a cancellation.
- See subagent activity in the same conversation when Oh My Pi accepts subagent updates. If that
  command is missing, the conversation still starts and subagent updates stay hidden. Scient does
  not create a separate thread for each subagent.
- Send `/compact` when this conversation's command list includes it. Scient does not show a compact
  button for Oh My Pi, because native compaction has not been confirmed against a live `omp`.
- See only explicitly qualified Oh My Pi command names in the provider snapshot. Session,
  export, sharing, model, configuration, and extension commands are hidden and rejected even when
  OMP discovers them. A slash invocation Oh My Pi does not know, such as a pasted
  `/Users/alice/notes.md` path, is sent as ordinary text, exactly as OMP would treat it. When
  command discovery itself fails, every slash invocation stays blocked so an unreported command is
  never forwarded. Scient does not import those commands or skills into its own skill library.
  The settings list is a conservative built-in list from a probe that adds `--no-session --no-tools
--no-extensions --no-skills --no-rules`; a running conversation validates against its live
  profile-specific catalog without publishing that catalog globally.

A native Oh My Pi update is refused while any OMP process for that executable is running, including
an idle conversation and a one-shot title or commit run, and the executable stays reserved for the
whole update. A conversation started while an update is running is refused. Managed OMP runtimes are
never updated by the native updater.

The OMP process environment is an explicit allowlist: the server's home, `PATH`, temp and locale
coordinates, proxy and certificate settings, XDG directories, shell identity, SSH agent socket,
virtualenv and conda state, and the named model-provider API keys OMP needs. Unrelated server
secrets are not forwarded, and a provider instance can add its own variables explicitly.

Native OMP rollback and fork commands are not exposed. On qualified desktop targets, Scient can
install and manage a private Oh My Pi runtime; that managed path is separate from the system
installation. Scient does not inject a private system prompt or awareness block into OMP; no project
or OMP-home configuration file is written for that purpose.

## Resume

A resumed conversation reopens only the session file recorded for that provider instance and
identity. Scient stores that file under a hashed directory, not the raw thread id. The cursor also
records the workspace, effective home/profile scope, resolved executable identity, launch policy,
protocol, and last Oh My Pi request id when one exists. Scient does not use that id to skip a prompt,
so sending the same prompt again can run the work again. Resume checks that the file is a readable
regular file inside that directory after resolving symlinks. A cursor from another instance,
workspace, home/profile, executable, protocol, major Oh My Pi version, or unreadable path is
rejected. Patch updates inside
the same major version can resume, including an in-place Homebrew or MacPorts upgrade of the same
formula, which keeps its install identity instead of the versioned directory.

## Qualification

The current qualified acceptance evidence covers:

- external OMP on macOS Apple silicon with a real OMP process;
- Oh My Pi RPC startup, streaming, steering, cancellation, attachments, resume, and custom models;
- the reviewed private macOS Apple-silicon runtime and its rollback/qualification path.

Windows process-tree cleanup, Linux process qualification, and hosted-account flows are not claimed
by this evidence. Those platforms remain unqualified until their own matrix runs. Windows
executable replacement during a native update is not verified either; the native updater owns that
platform behavior.

Raw Oh My Pi protocol frames are written to Scient's shared native provider event log, the same
diagnostics every other native provider produces.
