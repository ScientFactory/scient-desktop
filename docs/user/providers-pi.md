# Pi in Scient

Pi is a coding-agent runtime that can use several model providers. Scient connects to the official
Pi RPC interface; it does not run Pi through an ACP wrapper. Pi owns its model configuration,
credentials, extensions, and native skills.

## Setup

Enable **Pi** in **Settings > Providers**. Pi is off by default. On an Apple Silicon Mac, Scient can
install a qualified private Pi runtime through the existing **Install** action. Repair, update, and
remove affect only that private runtime, not your system installation or Pi credentials.

Alternatively, install Pi using its [official instructions](https://github.com/earendil-works/pi),
then configure its executable path if `pi` is not on the Scient server's `PATH`. The integration is
tested against Pi 0.84.4 and 0.85.0 and requires 0.84.4 or newer. The managed runtime remains pinned to
the qualified 0.84.4 archive. Other operating-system targets require a separately installed runtime;
Scient does not currently offer a qualified managed Pi build for those targets.

Configure models and API keys, or complete Pi's supported `/login` flow, in Pi itself on the machine
running Scient. Refresh the provider catalog afterward. There is no universal **Sign in to Pi** or
**Sign out of Pi** action: individual model providers can use unrelated credentials. A model appearing
in the catalog confirms discovery, not successful authentication or available quota.

For a separate Pi profile, set `PI_CODING_AGENT_DIR` in this provider instance's environment settings.
Scient does not copy your credentials into a second store. A customized Pi-based product or private
wrapper is not automatically compatible with this stock-Pi integration.

### Local models

Run the downloaded model in a local server compatible with an API Pi supports, then add that
server's endpoint and exact model ID to the Pi profile's `models.json` (normally
`~/.pi/agent/models.json`, or inside `PI_CODING_AGENT_DIR`). Refresh Pi's provider catalog in Scient
and select the model in a new conversation. Follow Pi's
[custom-model configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md),
including its placeholder-key requirement for keyless local servers.

Scient's model list lets you favorite, hide, and order discovered models. Define new models in
Pi's configuration, not as custom model entries in Scient Settings.

Scient runs the Pi agent, not the model server: importing model weights and starting/managing a
local inference server are not built into this integration. Model discovery does not establish
tool-calling support or model quality; verify those with the actual model and serving runtime.

## Access and conversations

Choose a discovered model and explicitly select **Full access** before sending. Pi does not supply
Scient's supervised sandbox. Its tools and extensions can read or modify files and run commands
with the server user's permissions; use trusted workspaces and extensions. Scient does not silently
change a supervised task to Full access.

Scient displays assistant output using its usual buffered-output setting, tool activity, model
failures, available thinking levels, and Pi's reported context usage. Pi's native text and reasoning
deltas are translated into runtime events; a separate reasoning transcript is not displayed by the
current shared conversation UI. You can change models between turns. Images require an
image-capable model; other attached files are supplied as local paths for Pi's tools to inspect.

Steering sends another message into the current turn. **Stop** cancels pending work and closes that
thread's Pi process. The next turn resumes its exact private session file. Scient deliberately rejects
native commands or extensions that switch the session behind its back; create a new Scient thread
instead of using `/new` or switching to an unrelated Pi session.

## Scient tools and Pi extensions

Scient adds a session-local extension that makes the tools authorized for that conversation available
to Pi and supplies Scient's workspace awareness. It does not change your project files or global Pi
configuration. `/scient-status` reports the current connection.

Native Pi skills and prompt templates can appear in the command catalog. Extension commands can be
typed directly, but passive catalog discovery does not execute your extensions. Pi extension prompts
for confirmation, selection, or text are shown as questions in Scient. Terminal-specific widgets,
custom TUI screens, editor layout changes, and arbitrary Pi UI elements are not reproduced.
Native editor requests are text questions, not a full Pi editor: initial text is shown as context
and you submit the complete replacement. Shared question controls trim surrounding whitespace.
Selection answers preserve Pi's exact native values and cannot be replaced by arbitrary free text.

Project-local skills and templates are discovered for the selected workspace. Pi's own project-trust
rules still apply: in Pi 0.85.0, RPC mode ignores untrusted project resources by default. To use those
resources, review the project and save its trust decision through Pi's interactive `/trust` command,
then restart the Pi session and refresh Scient. Selecting Full access in Scient does not create a
Pi trust decision. See Pi's [project settings and trust documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md).

Recognized native commands are sent verbatim: their extensions, skills, or templates own argument
handling and prompt expansion. Scient still applies the conversation's tool and skill permissions,
but does not append model-directed skill instructions to native command arguments. Send attachments
in a regular message, separately from a native command.

Provider-side history rollback and importing arbitrary external Pi session files are not supported.
Scient's own conversation history remains visible. The aggregate Usage page does not yet scan Pi
transcripts; Pi's reported per-conversation context usage is separate. Native skill installation/configuration remains
Pi-owned; Scient tools and Scient-managed skills use the existing Scient capability boundaries.

See [Providers in Scient](./providers.md) for shared runtime and environment behavior.
