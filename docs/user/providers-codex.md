# Codex in Scient

Codex is OpenAI's agent for working with project files, code, commands, and
connected tools. Scient can use an existing Codex installation or manage a
private copy, then connect it to your OpenAI account. Installing the tool and
signing in are separate steps.

For the behavior shared by all assisted providers, see [Providers in Scient](./providers.md).

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

**Sign out** logs out the configured Codex credential home. It can therefore affect the Codex CLI or
another app using those same account files; Scient explains that scope beside the action.

## Computers And Installations

Scient never silently replaces a healthy custom or system installation. A Scient-managed copy is
kept in the app's private data, and removing it does not remove a system or custom Codex install.

The local desktop offers managed installation only when the server reports a reviewed artifact for
the exact operating system and architecture. Remote clients use the runtime administered on their
server, and unsupported targets receive no invented fallback. The app displays the reviewed version
and download details before installation.

If an install, repair, or update fails, the previous working managed copy
remains available.

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
issue. Scient uploads the thread and Codex logs to OpenAI and shows a thread ID that you can copy
and share with OpenAI employees.

## Approve access to other apps

When a Codex tool needs access to an app such as Safari, Scient shows the app name and asks for
approval. You can approve, decline, or cancel the request from the desktop app
or a connected web client. Some tools also offer approval for the current
session or permanent approval.

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

Scient shows the authenticated email for providers that report one. The email is visible initially
so accounts can be distinguished; select it to hide or show it.

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
5. If you copied `~/.codex` into the shadow directory, first confirm that this really is the
   secondary shadow home and make a backup. Then move its non-`auth.json` entries out of that
   directory. Never clean the primary `CODEX_HOME`, and keep the backup until the secondary account
   has been verified in Scient.

## When To Use A Separate CODEX_HOME

Use a totally separate `CODEX_HOME path` only when you want a separate Codex workspace.

That means separate sessions and less account switching inside old threads. Most dual-account users
should use the shared-home plus shadow-home setup instead.
