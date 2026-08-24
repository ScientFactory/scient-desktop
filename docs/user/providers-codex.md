# Codex in Scient

Scient keeps installing the Codex tool and connecting a Codex account as two separate, visible
facts. A saved provider configuration is not treated as a working connection.

## The Easiest Setup Path

When no provider is ready, the composer shows **Choose your AI** in place of a disabled model
control. Choose Codex there to install it, sign in, or recover from a failed step without leaving
the composer. **Settings > Providers** shows the same lifecycle facts and exposes the next direct
action: **Install**, **Sign in**, **Update**, or **Manage**.

The flow:

1. detects a healthy custom, system, or Scient-managed Codex runtime;
2. offers managed installation on reviewed macOS, Windows, and Linux desktop targets;
3. starts a private managed installation only after the user explicitly chooses **Install Codex**,
   using the reviewed artifact selected for that computer;
4. opens Codex's official browser or device-code sign-in flow and lets Codex's local callback page
   confirm that the browser can be closed; and
5. asks Codex for fresh account, model, and runtime state before reporting the provider as ready.

Scient never asks for or receives the provider password. Codex continues to own its credentials,
refresh, expiry, and revocation.

`Sign out on this computer` logs out the configured Codex credential home. It can therefore affect
the Codex CLI or another app using those same account files; Scient explains that scope beside the
action.

## Computers And Installations

Scient never silently replaces a healthy custom or system installation. A Scient-managed copy is
kept in the app's private data, and removing it does not remove a system or custom Codex install.

The current support boundary is intentionally explicit:

| Computer or host                            | What Scient currently promises                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Local Scient desktop on Apple-silicon macOS | Fully assisted installation of the reviewed Codex artifact, plus guided sign-in             |
| Intel Mac                                   | Fully assisted installation of the reviewed Codex artifact, plus guided sign-in             |
| Windows on ARM64 or x64                     | Fully assisted installation of the reviewed Codex executable, plus guided sign-in           |
| Linux on ARM64 or x64                       | Fully assisted installation of the reviewed static Codex artifact, plus guided sign-in      |
| Remote or web-hosted Scient server          | Use the runtime already administered on that server; the client cannot take ownership of it |
| Other operating systems or architectures    | No managed Codex promise; Scient explains that the target is unsupported                    |

The application selects a target-specific official Codex artifact for each supported operating
system and architecture. Every managed download is bounded by the catalogued byte size and verified
against its exact SHA-256 digest before Scient runs or activates it. Unknown operating systems and
architectures remain unsupported instead of receiving an invented fallback.

If a managed install, repair, or download fails, that operation cleans its incomplete staging
directory and the previous working copy remains active. Routine status refreshes never delete an
active operation's staging directory. A manual rollback button is deliberately not offered until
Scient has two separately reviewed releases to roll between.

When a newer reviewed managed version is available, **Update** downloads and verifies the
replacement without deactivating the current version. Scient switches versions only after the new
copy passes its smoke test. Provider-tool updates and provider sign-in are serialized so one cannot
change shared runtime state underneath the other.

## Why Use More Than One Account?

Common reasons:

- use a work account for work projects
- use a personal account for personal projects
- switch to another account when one account hits limits
- keep one shared Codex history instead of maintaining two separate Codex setups

## I Only Use One Codex Account

Use the default provider.

In Settings, your Codex provider can stay like this:

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

Use the guided action in the composer or in **Settings > Providers**. If you deliberately use a
custom or externally managed Codex runtime, the advanced terminal flow remains available.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` or `/feedback` followed by a description of the
issue. T3 Code uploads the thread and Codex logs to OpenAI and shows a thread ID that you can copy
and share with OpenAI employees.

## Approve access to other apps

When a Codex tool needs access to an app such as Safari, T3 Code shows the app name and asks for
approval. You can approve, decline, or cancel the request from the desktop app, web app, or mobile
app. Some tools also offer approval for the current session or permanent approval.

## I Want Work And Personal Codex Accounts

Use one real Codex home and one shadow home.

Recommended setup:

```text
~/.codex      shared Codex home
~/.codex_p    second account auth
```

The idea is:

- both accounts can see the same Scient/Codex sessions
- each account keeps its own login
- existing threads can continue with either account

### Set Up The First Account

Connect it through Scient's guided Codex flow or log in through your externally managed Codex
installation.

This is the account used by `~/.codex`.

In Scient Settings, name it something obvious:

```text
Display name: Codex Work
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

### Set Up The Second Account

Add a second Codex provider in Scient, then use the same guided sign-in action for that provider.
Configure it with a separate shadow home:

```text
Display name: Codex Personal
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex_p
```

The equivalent terminal login remains available as an advanced recovery path:

```bash
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login
```

The important part is that both providers use the same `CODEX_HOME path`, but only the second one
has a `Shadow home path`.

## Which Account Am I Using?

Open Settings and look at the provider row.

Scient shows the authenticated email for providers that report one. Emails are blurred by default;
click the blurred email to reveal it.

Use display names and accent colors to make accounts easy to tell apart in the model picker.

## I Need A Different API Key Or Endpoint

Use the provider's Environment variables section in Settings.

This is useful when a Codex-compatible setup needs account-specific variables. Add the variables to
the provider instance that should receive them, and mark API keys or tokens as sensitive. Sensitive
values are stored as server secrets and are not sent back to the app after saving.

## Can I Switch Accounts In An Existing Thread?

Yes, when both Codex providers share the same `CODEX_HOME path`.

For example:

```text
Codex Work      CODEX_HOME path: ~/.codex
Codex Personal  CODEX_HOME path: ~/.codex, Shadow home path: ~/.codex_p
```

Those two providers are considered compatible for continuation, so the locked model picker can show
both.

If you add a third Codex provider with a completely different `CODEX_HOME path`, Scient treats it
as a different workspace. It will not be offered for existing threads created under `~/.codex`.

## If Both Accounts Look The Same

If two Codex providers show the same account or the same unexpected model list:

1. Check the email in Settings.
2. Refresh provider status.
3. Confirm the second provider has `Shadow home path` set.
4. Confirm the shadow directory has its own `auth.json`.
5. If you copied `~/.codex` into the shadow directory, remove everything except `auth.json`.

Example cleanup:

```bash
find ~/.codex_p -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## When To Use A Separate CODEX_HOME

Use a totally separate `CODEX_HOME path` only when you want a separate Codex workspace.

That means separate sessions and less account switching inside old threads. Most dual-account users
should use the shared-home plus shadow-home setup instead.
