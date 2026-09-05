# Providers in Scient

A provider supplies the AI models that work inside Scient. For example, you
can connect Codex, Claude, Cursor, Grok, Droid, or Antigravity, then choose an
available model for each conversation. Different providers can have different
models, tools, account requirements, and usage limits.

Scient connects the provider to your current project and presents its work in
one interface. The provider still owns its account, subscription, and models.
You can use an existing provider installation or, when available, let Scient
install a qualified private copy on the machine where the project runs.

## The fastest setup path

When no provider is ready, choose one from **Choose your AI** in the composer. Scient shows the next
available step without requiring you to leave the conversation:

- **Enable** makes a disabled provider available;
- **Install** adds a qualified Scient-managed runtime when no usable provider tool exists;
- **Sign in** starts the provider's official account flow; and
- **Manage** opens the complete runtime and account controls in **Settings > Providers**.

Scient verifies the provider again after installation or sign-in. It reports Ready only when the
runtime, account configuration, and available models are usable together.

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
modify it. When **Use Scient-managed** is available, choosing it installs and verifies a private copy
for default provider instances while leaving the system installation untouched. Removing that private
copy returns eligible instances to the healthy system runtime.

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
app starts, periodically while it remains open, and when you click **Install**, **Update**, or **Repair**.
A newly qualified release can appear as **Update** without restarting Scient. Clicking **Install** or
**Update** starts the operation directly, without a second confirmation. In Settings, it runs without
opening the management card: the button shows **Installing**, **Updating**, or **Verifying**, with a
small download percentage when available. Click that button to open details. A **Failed** button opens
the existing error and recovery controls; errors before an operation starts appear as notifications.
The local computer independently verifies and tests the release before activation.
Scient never installs a provider update without your action. Repair also uses the latest qualified release and can restore it
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
