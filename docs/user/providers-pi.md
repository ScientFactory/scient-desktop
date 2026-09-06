# Pi in Scient

Pi is a coding-agent runtime that can use several model providers. Scient connects to the official
Pi RPC interface; it does not run Pi through an ACP wrapper. Native Pi configuration, credentials,
extensions, and skills remain Pi-owned. Models added through Scient use separate Scient-managed connections.

## Setup

Enable **Pi** in **Settings > Providers**. Pi is off by default. On an Apple Silicon Mac, Scient can
install a qualified private Pi runtime through the existing **Install** action. Repair, update, and
remove affect only that private runtime, not your system installation or Pi credentials.

For recognized system package installations, Scient can check for updates and run the owning
package manager when you choose **Update**. Extensions are not updated. Unrecognized installations
remain manual-only; use the tool that installed Pi.

Alternatively, install Pi using its [official instructions](https://github.com/earendil-works/pi),
then configure its executable path if `pi` is not on the Scient server's `PATH`. The integration is
tested against Pi 0.84.4 and 0.85.0 and requires 0.84.4 or newer. The managed runtime remains pinned to
the qualified 0.84.4 archive. Other operating-system targets require a separately installed runtime;
Scient does not currently offer a qualified managed Pi build for those targets.

Use **Settings > Custom models > Add model**, or **Connect models** in Pi's setup:

1. Choose a service or a local/custom endpoint, then enter its exact model ID and API key (optional for a keyless endpoint).
2. Select the Pi agents under **Use with**, then save. Reuse a saved connection to add another model with the same key.
3. Choose **Test** to send a small request through Pi. API charges may apply. A passing test verifies
   a basic response for that configuration, not tool quality, image support, or future quota.

Connection settings and keys are shared by their models. Edit a model to change its agent access,
name, limits, or capabilities; advanced options also expose the connection's endpoint and key removal.
New hosted models use **Automatic** model settings. Pi uses its native definition for an exact known
model; where unavailable, Scient can use verified service metadata. Existing saved limits stay unchanged:
edit the model and select **Automatic** to replace them. Unknown or local deployments may need
**Configure manually**, with limits supported by that deployment.
Capabilities are checked when you save; Scient does not refresh them during a conversation.
The connection's **Manage** action also lets you rename it, replace/remove its saved key, or delete it.
Deleting a model keeps its connection and key; deleting a connection removes both and detaches all its models.

If a saved key is missing or unreadable, only that connection's models become unavailable. Use
**Test** for the setup error, then use **Manage** to re-enter the connection's key.
Connection setup and testing are available in desktop and web, not yet in the mobile app.

You can still configure models and API keys, or complete Pi's supported `/login` flow, in Pi itself
on the execution machine. Refresh the provider catalog afterward. There is no universal **Sign in to Pi** or
**Sign out of Pi** action: individual model providers can use unrelated credentials. A model appearing
in the catalog confirms discovery, not successful authentication or available quota.

For a separate Pi profile, set `PI_CODING_AGENT_DIR` in this provider instance's environment settings.
Scient does not import or overwrite that profile's credentials. Scient-added keys are stored separately
in the execution environment's restricted-permission secret store, not in ordinary settings or Pi's
configuration. They are not encrypted by an OS keychain. Only selected agents receive access; use
trusted endpoints, and HTTPS for hosted APIs. A customized Pi-based product or private
wrapper is not automatically compatible with this stock-Pi integration.

### Local models

Run the downloaded model in a compatible server, then choose **Local / custom endpoint** in Scient
and enter its base URL and exact model ID. Leave the API key empty for a keyless server.
The URL is resolved on the execution environment: `localhost` means the machine running Pi, not
necessarily the machine displaying Scient.

Alternatively, continue using the Pi profile's `models.json`. Follow Pi's
[custom-model configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md),
including its placeholder-key requirement for keyless local servers.

Scient's provider model list lets you favorite, hide, and order available models. Changes to
Scient custom connections apply to new sessions and before the next ordinary turn of an existing
session; they do not change an already-running request.

If a response stops at its token limit, Scient keeps the partial answer and shows a quiet notice.
You can send a follow-up to continue; queued messages proceed normally without an automatic retry.

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

If a response exhausts its token allowance and Pi cannot recover automatically, Scient keeps any
partial answer and shows a dismissible notice above the composer. Continue the conversation or adjust
the model limits; queued messages wait for recovery rather than advancing past an incomplete answer.

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
