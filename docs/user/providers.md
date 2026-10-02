# Providers in Scient

A provider supplies the AI models that work inside Scient. For example, you
can connect Codex, Claude, Cursor, Grok, Droid, Antigravity, Pi, Oh My Pi, or Scient Agent, then choose an
available model for each conversation. Different providers can have different
models, tools, account requirements, and usage limits.

Scient connects the provider to your current project and presents its work in
one interface. The provider still owns its account, subscription, and models.
You can use an existing provider installation or, when available, let Scient
install a qualified private copy on the machine where the project runs.

Thread titles and other generated text use **Settings > Text generation**; source control can
choose a separate writer. If Pi or Oh My Pi is the automatic fallback provider, Scient uses that
instance's discovered default model, or its first available non-legacy built-in model (a custom
model when only custom models remain). An explicit model choice takes priority. If discovery has
not supplied a usable model, choose one in Settings or
refresh the provider; automatic titles keep their normal fallback. This automatic choice does
not guarantee the lowest price.

## The fastest setup path

When no provider is ready, choose one from **Choose your AI** in the composer. Scient shows the next
available step without requiring you to leave the conversation:

- **Enable** makes a disabled provider available;
- **Install** adds a qualified Scient-managed runtime when no usable provider tool exists;
- **Sign in** starts the provider's official account flow; and
- **Manage** opens the complete runtime and account controls in **Settings > Providers**.

Scient verifies the provider again after installation or sign-in. It reports Ready only when the
runtime, account configuration, and available models are usable together.
Pi instead reports **Models available** after discovery, and Oh My Pi reports Ready once discovery
lists models; for both, authentication and quota remain specific to each configured model provider
and are verified when used.

In **Settings > Providers**, a shipped provider opens on **Models** when that tab is available; use
**Configuration** for paths, environment variables, and advanced instance settings. An
authenticated email reported by a provider is shown initially so you can distinguish accounts;
select it to hide or show it. Other sensitive configuration values remain redacted by default.

## Existing and Scient-managed installations

Scient distinguishes three local runtime sources:

- **Custom**: an explicit binary path configured for this provider instance.
- **System**: a healthy provider tool already available on the Scient server.
- **Scient-managed**: a qualified copy stored privately in Scient's app data.

A healthy custom or system installation remains first-class. Scient does not silently replace or
modify it. **Use Scient-managed** is offered beside a healthy system installation whichever of the
two versions is newer: a private copy that Scient installs and maintains is a choice of its own, and
a tool that updates itself is usually ahead of the release Scient has qualified. In Settings and in
a provider's **Manage** dialog, choosing it first shows both versions; confirming installs and
verifies a private copy for default provider instances while leaving the system installation
untouched. Removing that private copy returns eligible instances to the healthy system runtime.

When the Scient-managed version is older than your installation, the switch never starts from one
click. Scient says so with both versions, for example "Scient-managed Droid 0.230.0 is older than
your installed Droid 0.231.0. Scient will use its own verified copy; your installation stays as it
is.", and waits for **Back** or **Use Scient-managed**. The same holds when Scient does not know the
installed version, because the tool reports none it can read or because the provider is disabled
(Scient never runs a disabled provider's tool, not even to ask its version): the decision then says
"system version unknown" and that the Scient-managed version may be older. This applies on every
surface, including the **Use Scient-managed** button under a failed setup's runtime diagnostics,
which starts right away only when the managed version is known to be the same or newer. Scient reads
the installed version again when it prepares the switch and when it starts it. If the installation
was updated in between, so that what you decided on changed, Scient does not carry out the earlier
decision: it shows the switch again with the current versions.

Repair and Update of a private copy you never chose (one left by an earlier Scient version that was
never selected) would put that copy in use too, so beside a system installation they are the same
decision as **Use Scient-managed**: both versions, or "system version unknown", then **Back** or
**Use Scient-managed**. Codex keeps one refusal of its own: while Codex from your `PATH` stands in
for a private copy that failed its check, Scient does not repair or update that copy with a version
older than the `PATH` one, and names both versions when it declines.

The versions shown are those of the provider instance you act on. The Scient-managed copy is shared:
once it is in use, every instance of that provider that uses the default runtime switches to it.
Another instance of the same provider whose environment sets a different `PATH` is not checked, so
if its own system installation is newer than the qualified release, it moves to the older managed
copy too, without a decision that named its version. Give such an instance an explicit binary path
to keep it on its own installation; custom paths are never switched.

Runtime controls always apply to the machine running the Scient server. A remote browser controls
that environment; it does not install or remove provider software on the device displaying the UI.

For system or custom installations, an executable update action is available only when Scient can
verify which installer owns that binary. Otherwise the version notice remains informational and
you update it with the original installer. Scient rechecks ownership before running an update;
it does not guess a package manager from whichever command happens to be on your PATH. This is
separate from the verified private-runtime actions below.

## What each action changes

| Action   | What it does                                                             | What it preserves                                                               |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Install  | Downloads, verifies, tests, and activates a qualified private runtime.   | System/custom installations and provider credentials.                           |
| Update   | Safely replaces a Scient-managed runtime with a newer qualified version. | The previous working copy until activation succeeds, plus provider credentials. |
| Repair   | Installs or restores the latest qualified managed release.               | The previous working copy until repair succeeds, plus provider credentials.     |
| Remove   | Deletes only Scient's private runtime.                                   | System/custom installations and provider credentials.                           |
| Sign out | Asks the provider to revoke the account session and verifies the result. | Every provider runtime.                                                         |

When provider update checks are enabled, Scient checks its qualified stable-release catalog when the
app starts, periodically while it remains open, and when you click **Install**, **Update**, or
**Repair**. A newly qualified release can appear as **Update** without restarting Scient. **Refresh
providers** in Settings also checks the catalog immediately without changing its normal automatic
schedule. If a Scient-managed runtime has an update, Scient shows a notice with **Update** and
**Settings**. **Update** installs it in place and reports when the verified version is active or why
it failed, with **Retry**. **Settings** opens the provider in the correct environment. Clicking
**Install** or **Update** starts the operation directly, without a second confirmation; the one
exception is an install that would use an older Scient-managed version instead of your system
installation, which waits for the decision described above. In Settings, it runs without opening the
management card: the button shows **Installing**, **Updating**, or **Verifying**, with a small
download percentage when available. Click that button to open details. A **Failed** button opens the
existing error and recovery controls; errors before an operation starts appear as notifications. The
local computer independently verifies and tests the release before activation.

Scient downloads, verifies, and tests a new runtime while you keep working. Switching to it restarts
that provider, so while one of its turns or background tasks (subagents, workflows, monitors) is
running, the button shows **Waiting**; your conversations continue on the next message. Cancel a
waiting change from its details. While a change waits, that provider's sign-in actions are
unavailable.

Scient never installs a provider update without your action. If the private Codex copy fails its
startup check, Scient keeps working with Codex from your PATH and marks the card **Using system
Codex** with the reason. Scient checks the private copy again when you refresh providers and every 10
minutes, and switches back once it passes and no Codex work is running; **Repair** or **Update** also
restores it. While the PATH copy stands in, Scient offers updates only for the private copy. When
the Codex in use is a version this Scient release does not support, the card offers **Install** of
the verified private copy beside it.
Repair also uses the latest qualified release and can restore it
when you already have that version. Offline, Scient uses the latest qualified release it already
knows about; it does not claim to have checked for newer releases.

**Remove** still asks for confirmation. Removing a runtime does not sign out. Signing out does not uninstall anything. Disabling a provider
also preserves both its runtime and its credentials.

## Accounts, subscriptions, and codes

Scient starts official provider-owned account flows. It never asks for or receives your provider
password, and it does not create a second credential store. A sign-in page may let a new user create
an account or purchase access, but those choices, prices, and eligibility rules belong to the
provider.

The exact flow varies:

- some providers open a browser and return automatically;
- some show a device code that you copy from Scient to the provider page;
- some occasionally show a returned authorization code that you paste into Scient; and
- some provider tools open the browser themselves without exposing a URL to Scient.

Scient shows a code field only when the active provider operation says it can accept one. A submitted
code goes to that live process and is not saved as provider state.

Being signed in does not always mean the account has a supported subscription, remaining quota, or a
usable model. Scient keeps those states separate and reports the provider's actual result.

## Disabled, remote, and unsupported providers

A disabled provider can be enabled directly from its lifecycle surface when the current client has
permission to change settings. Enabling never starts installation or sign-in automatically.

Managed installation is offered only by a writable local desktop host on an approved target. Remote,
read-only, manual-only, and unsupported environments show truthful guidance without a broken action.
You can still use an installation administered directly on the server when that provider supports it.

## Provider guides

- [Codex](./providers-codex.md)
- [Claude](./providers-claude.md)
- [Antigravity](./providers-antigravity.md)
- [Grok](./providers-grok.md)
- [Droid](./providers-droid.md)
- [Cursor](./providers-cursor.md)
- [Pi](./providers-pi.md)
- [Oh My Pi](./providers-omp.md)
- [Scient Agent](./providers-scient-agent.md)

Pi uses its own multi-provider model and credential configuration. Scient can manage its runtime
on a qualified target, but does not offer a universal Pi account sign-in or sign-out action. Model
discovery is not proof that a particular credential or subscription works.

Oh My Pi uses the `omp` executable you install or, on the desktop app for macOS, Windows and
Linux, a Scient-managed private copy. Scient never runs `omp update` on your installation; it shows the
command when a newer release is available. Scient does not sign in to Oh My Pi. Full access is the
only runtime mode, and Oh My Pi's own approval mode is explicit `yolo`.

Scient Agent is Scient's own agent, built from Oh My Pi and kept entirely separate from it. It
uses a `scient-agent` executable you point Scient at; Scient does not install it yet.

OpenCode uses its own multi-provider credential and runtime configuration. Scient does not present
one universal OpenCode account, sign-out action, or Scient-managed installation because its upstream
connections may use unrelated API keys, OAuth accounts, or local models.

## Troubleshooting

- Open **Settings > Providers** and use **Manage** to inspect runtime source, account state, and
  recovery actions.
- Use **Repair** only for a Scient-managed runtime. Update a custom or system installation with the
  tool that installed it.
- If a provider reports an account but no usable models, check subscription access, quota, billing,
  or provider availability before signing in again.
- Runtime diagnostics describe the server and may show paths from another computer when you are
  connected remotely.
