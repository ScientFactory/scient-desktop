# Providers in Scient

Scient connects to AI providers through the provider tools running on the Scient server. You can use
an existing installation or, when the server offers it, let Scient install a reviewed private copy.
Provider accounts and subscriptions remain owned by the provider.

## The fastest setup path

When no provider is ready, choose one from **Choose your AI** in the composer. Scient shows the next
available step without requiring you to leave the conversation:

- **Enable** makes a disabled provider available;
- **Install** adds a reviewed Scient-managed runtime when no usable provider tool exists;
- **Sign in** starts the provider's official account flow; and
- **Manage** opens the complete runtime and account controls in **Settings > Providers**.

Scient verifies the provider again after installation or sign-in. It reports Ready only when the
runtime, account configuration, and available models are usable together.

## Existing and Scient-managed installations

Scient distinguishes three local runtime sources:

- **Custom**: an explicit binary path configured for this provider instance.
- **System**: a healthy provider tool already available on the Scient server.
- **Scient-managed**: a reviewed copy stored privately in Scient's app data.

A healthy custom or system installation remains first-class. Scient does not silently replace or
modify it. When **Use Scient-managed** is available, choosing it installs and verifies a private copy
for default provider instances while leaving the system installation untouched. Removing that private
copy returns eligible instances to the healthy system runtime.

Runtime controls always apply to the machine running the Scient server. A remote browser or mobile
client cannot install or remove software on its own device through these controls.

## What each action changes

| Action   | What it does                                                             | What it preserves                                                               |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Install  | Downloads, verifies, tests, and activates a reviewed private runtime.    | System/custom installations and provider credentials.                           |
| Update   | Safely replaces a Scient-managed runtime with a newer reviewed version.  | The previous working copy until activation succeeds, plus provider credentials. |
| Repair   | Downloads and verifies a fresh copy of the reviewed runtime.             | The previous working copy until repair succeeds, plus provider credentials.     |
| Remove   | Deletes only Scient's private runtime.                                   | System/custom installations and provider credentials.                           |
| Sign out | Asks the provider to revoke the account session and verifies the result. | Every provider runtime.                                                         |

Removing a runtime does not sign out. Signing out does not uninstall anything. Disabling a provider
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

Managed installation is offered only by a writable local desktop host on a reviewed target. Remote,
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
