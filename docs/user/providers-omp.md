# Oh My Pi in Scient

Oh My Pi is an external coding agent. Scient talks to the `omp` executable over its RPC
interface. It does not embed Oh My Pi's Bun SDK, and it does not run Oh My Pi through ACP.

Oh My Pi keeps its own home, credentials, skills, extensions, and model sign-in. Scient does not
download Oh My Pi, update it, or offer a universal sign-in. Enable it only after `omp` 18.2.8 or
newer is installed and available to the Scient server.

## Setup

Oh My Pi is off by default. In **Settings > Providers**, enable **Oh My Pi** and set the executable
path when `omp` is not on the server's `PATH`.

Scient starts one `omp --mode rpc --approval-mode yolo` process for each conversation. With the home
and profile left empty, that process uses the server's normal Oh My Pi home and credentials. Every
Oh My Pi instance with an empty home shares that login. Set **Oh My Pi home**
(`PI_CODING_AGENT_DIR`) or **Oh My Pi profile** (`OMP_PROFILE`) on an instance to give it a separate
agent directory. Scient stores only the session transcript path it can prove sits in its own
per-conversation session directory. If Oh My Pi writes the transcript somewhere else, the live
conversation can continue, and Scient will say that the conversation cannot be resumed.

The first version supports **Full access** only. The launch always passes `--approval-mode yolo`.
That flag matches the pinned Oh My Pi 18.2.8 interface and has not been confirmed by a live `omp`
run inside Scient. It is not an operating-system sandbox. Scient does not register its project or
scientific tools with this provider.

## What you can do

- Send text and images, and see streamed replies and Oh My Pi tool activity.
- Switch models in the same conversation when Oh My Pi reports them.
- Answer Oh My Pi's select, confirm, and input questions in Scient.
- Steer a running turn, and stop it. Stop closes that conversation's process. On macOS and Linux
  the process runs in its own process group and stop signals that group, escalating to a forced
  stop. On Windows, stop uses `taskkill /T /F`. Scient has not verified that against a live Oh My
  Pi child-process tree. If the turn is still open when the process ends, Scient records the
  outcome as uncertain and names the Oh My Pi request id. A turn Oh My Pi itself reports as failed
  stays a failure. A stop Oh My Pi acknowledges stays a cancellation.
- See subagent activity in the same conversation when Oh My Pi accepts subagent updates. If that
  command is missing, the conversation still starts and subagent updates stay hidden. Scient does
  not create a separate thread for each subagent.
- Send `/compact` when this conversation's command list includes it. Scient does not show a compact
  button for Oh My Pi, because native compaction has not been confirmed against a live `omp`.
- See Oh My Pi's command names in the provider snapshot. Session-changing commands such as
  `/new`, `/fresh`, `/clear`, `/delete`, `/fork`, and `/resume` are hidden and rejected. Scient does
  not import those commands or skills into its own skill library. The settings list comes from a
  probe that adds `--no-session --no-tools --no-extensions --no-skills --no-rules`. Those flags match
  the Oh My Pi 18.2.8 flag table and have not been confirmed by a live `omp` run inside Scient. A
  running conversation uses the command list from that process, including later updates.

Rollback, fork, and Scient-managed installation are not available.

## Resume

A resumed conversation reopens only the session file recorded for that provider instance and
directory. Scient stores that file under a hashed directory, not the raw thread id. The cursor also
records the last Oh My Pi request id when one exists. Scient does not use that id to skip a prompt,
so sending the same prompt again can run the work again. Resume checks that the file is a readable
regular file inside that directory after resolving symlinks. A cursor from another instance, another
executable, another major Oh My Pi version, or an unreadable path is rejected. Patch updates inside
the same major version can resume.
