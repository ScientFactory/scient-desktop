# Muse Code

Muse Code is a beta integration and is disabled by default. Enable it in
**Settings → Providers** on the environment that runs your threads.
Use an existing [Muse Code](https://dev.meta.ai/docs/muse-code) installation,
or install Scient's private copy from **Settings → Providers** or the composer.
Set **Binary path** for a custom installation.

Scient's private copy is available for macOS and Windows on ARM64/x86-64 and
Linux glibc on ARM64/x86-64, from the desktop app on the machine that runs your
threads. Linux musl is not supported.

Provider status cannot verify your login or model access. A successful native
account operation says Muse finished saving the credential, not that every
model is available. Refresh status and select an accessible model before
sending a message.

## Sign-in and API keys

For supported Muse versions, **Sign in** in Settings or the composer starts
the official `muse login` flow. Approve its device code on Meta's page; do not
paste the code into Scient. Choose **Meta API key** to send a key to Muse's
native credential store through a secret input. Meta Managed Accounts require
an API key and cannot use browser sign-in. Older or unavailable runtimes retain
manual setup on the server host.

Scient does not read or copy Muse's saved tokens. Browser sign-in and saved API
keys belong to Muse's shared host account, including other instances and its
standalone CLI. Account changes stop Scient sessions sharing that account
before invoking the native credential operation. **Sign out** runs
`muse logout`, which removes both the saved browser login and a saved API key.

Scient ignores a `META_API_KEY` inherited by the server. An explicit instance
`META_API_KEY` takes priority over the saved key and browser login, retains that
instance's billing context, and disables native account mutation for the
instance. Remove the instance override separately; native logout cannot unset it.

## Remote access and instances

Connect from web, desktop, or mobile through [remote access](./remote-access.md).
Muse uses the selected environment's files and login; connecting devices do not
need Muse installed. Install and sign in separately on each host where you want
Muse to run.

Add a provider instance for a separate configuration. Instances on the same host
share its Muse login; give an instance its own `META_API_KEY` to bill it
separately. Existing conversations retain their instance when its model catalog
becomes unavailable.

## Models

Models and reasoning choices come from Muse on the selected host. After changing
Muse configuration, refresh provider status in **Settings → Providers**. On
mobile, pull down in thread settings to refresh models. If a saved model becomes
unavailable, select an available model before sending another message.

Muse can list models that your account cannot use. If a message fails with
"does not exist or you lack access", pick another model, or add one your account
can use under **Custom models** in the instance settings.

## Permissions and limitations

Muse offers two [permission modes](./permission-modes.md): **Supervised** asks
before commands and edits, and **Full access** runs them without asking. Muse has
no equivalent of **Auto-accept edits** or **Auto**, so they are not offered. Muse
does not offer a separate Plan mode in Scient.

Muse can use Scient's tools and selected Scient skills through its authenticated
MCP session. That connection requires Muse's native session-MCP capability;
Scient refuses setup when the required grant is missing. Switching providers
can pass conversation context as a handoff.

Muse-native skills do not appear in the composer's `$` menu. Muse still loads
them itself; manage them with `muse skills` on the host. Scient skills use the
shared [skill selection](./composer.md) and availability policy.

Forking a Muse conversation starts a new session with a copy of the conversation
context. Conversation rewind is unavailable.

Private runtime install, update, repair and removal use Scient's shared runtime
controls. They do not change credentials
or the host's installation. Custom paths remain authoritative. The managed
binary disables Muse self-update; external launcher maintenance stays separate.
Updates to external installations can run from Settings when Scient recognizes
their launcher; otherwise update Muse on the host manually.

To stop using Muse in an environment, disable it in **Settings → Providers**.
This keeps the host's Muse login, thread history, and workspace files.
