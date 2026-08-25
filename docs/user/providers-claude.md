# Claude in Scient

Scient keeps installing the Claude tool and connecting a Claude account as two separate, visible
facts. A saved provider configuration is not treated as a working connection.

For the behavior shared by all assisted providers, see [Providers in Scient](./providers.md).

## The Easiest Setup Path

When Claude is not ready, choose it from **Choose your AI** in the composer or open **Settings >
Providers**. The same guided surface appears in both places:

1. Scient preserves and verifies a healthy custom or system Claude installation when one exists;
2. otherwise, the local desktop app can install a reviewed official Claude Code executable in
   Scient's private app data;
3. the available sign-in button starts Claude Code's official account flow and opens its secure
   page in your browser; and
4. Scient asks Claude for fresh account and model state before reporting it as ready.

Connecting another AI does not hide Claude. Every enabled provider remains available from the
model picker's provider rail. After Claude confirms the account and reports models, Scient hands
Claude's declared default model to the existing composer selection path and closes onboarding. You
can work immediately or reopen the normal model picker to choose another Claude model.

**Sign in to Claude** uses Claude Code's official sign-in flow for an existing Claude.ai Pro, Max,
Team, or Enterprise subscription. **Use Anthropic Console** remains available as an alternative for
an Anthropic Console account. Existing API-key, Bedrock, Vertex, Foundry, and custom-endpoint setups
remain advanced provider configurations rather than being rewritten by the guided account flow.

Most browser sign-ins return to Claude automatically. If the browser itself displays a one-time
code, expand **Browser showed a code?** and paste it into the compact recovery field. This is an
occasional fallback for environments where the local callback cannot complete, not a normal extra
step. The code is sent only to the live Claude process and is not saved as provider state.

Scient never asks for or receives your Claude password. Claude Code continues to own its
credentials, refresh, expiry, and revocation.

## Computers And Installations

Scient never silently replaces a healthy custom or system installation. A Scient-managed copy is
private and removable, and removing it does not remove a system Claude install, a custom binary,
or Claude-owned account data.

For a Scient-managed copy, expand Claude in **Settings > Providers** to repair or remove the
private runtime. If the executable stops working, **Manage** opens directly on that recovery path
instead of asking you to sign in again.

Managed installation is offered only when the local desktop server reports a reviewed artifact for
its exact operating system and architecture. Remote clients continue using the runtime administered
on their server. The app displays the reviewed version and download details before installation.

Scient checks Claude Code and the Claude Agent SDK together before advertising models that require a
newer provider capability. A model remains hidden until the active runtime combination actually
supports it.

## Advanced And Multiple-Account Setups

The remaining sections are for people who deliberately want more than one Claude setup or an
external Claude-compatible route. For Codex, see [Codex](./providers-codex.md).

Common reasons:

- use separate work and personal Claude accounts
- try a different Claude Code configuration without disturbing your main setup
- run Claude through a router such as Claude Code Router
- use external providers exposed through a Claude-compatible workflow

## I Only Use One Claude Account

Use the default provider.

The guided Scient flow is recommended. The equivalent Claude subscription recovery command is:

```bash
claude auth login --claudeai
```

Use `claude auth login --console` instead when you deliberately want an Anthropic Console account.

In Scient Settings, your Claude provider can stay like this:

```text
Display name: Claude
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

An empty `CLAUDE_CONFIG_DIR path` means Scient uses Claude Code's normal config directory.

When you set this field, Scient points Claude Code at that directory with the
`CLAUDE_CONFIG_DIR` environment variable. It does not change `HOME`, so your system keychain and
the rest of your environment stay as they are.

## Where Claude Skills Are Loaded

Scient looks for Claude skills in the Claude config directory's `skills` folder, then
`<workspace>/.agents/skills`, then `<workspace>/.claude/skills`.

If the same skill name exists in more than one folder, the later folder wins.

## I Want Work And Personal Claude Accounts

Use a different Claude config directory for each account.

Example:

```text
default config dir           work account
~/.claude_personal_home      personal account
```

### Set Up The First Account

Log in with the first Claude subscription:

```bash
claude auth login --claudeai
```

In Scient Settings:

```text
Display name: Claude Work
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

### Set Up The Second Account

Log in with a separate config directory:

```bash
mkdir -p ~/.claude_personal_home
CLAUDE_CONFIG_DIR=~/.claude_personal_home claude auth login --claudeai
```

Use `--console` instead of `--claudeai` when that provider should use an Anthropic Console account.

Use `CLAUDE_CONFIG_DIR`, not `HOME`. Setting `HOME` writes the login to
`~/.claude_personal_home/.claude`, which is not where Scient looks.

Then add another Claude provider in Scient:

```text
Display name: Claude Personal
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_personal_home
```

Use the email shown in Settings to confirm each provider is using the intended account. Emails are
blurred by default; click the blurred email to reveal it.

## Can I Switch Claude Accounts In An Existing Thread?

Usually, no.

Scient only offers Claude providers that use the same config directory for an existing thread. A
different config directory is treated as a different Claude environment.

This is different from the recommended Codex setup. Claude Code keeps account and local state across
multiple files under its config directory, so Scient keeps separate config directories isolated
instead of trying to share part of the state.

## I Want To Use OpenRouter

Use this when you want Claude Code to talk to OpenRouter directly, without running a local router.
This is the simplest external-provider setup.

OpenRouter provides a Claude Code integration through Claude's Anthropic-compatible environment
variables.

### Configure A Claude OpenRouter Provider

Add or edit a Claude provider in Scient Settings:

```text
Display name: Claude OpenRouter
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_openrouter_home
```

In that provider's Environment variables section, add:

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN sk-or-...                Sensitive
ANTHROPIC_API_KEY                              Empty value
```

Mark `ANTHROPIC_AUTH_TOKEN` as sensitive. Scient stores the value as a server secret and does not
send it back to the app after saving.

If you want this setup isolated from your normal Claude account, create that home first:

```bash
mkdir -p ~/.claude_openrouter_home
```

If you previously used the same Claude home with a normal Anthropic login, run `/logout` in a Claude
Code session for that home before using OpenRouter. Otherwise Claude Code may keep using cached
Anthropic credentials instead of the OpenRouter token.

### Pick OpenRouter Models

OpenRouter can route Claude Code's default model roles to OpenRouter model IDs.

Example:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-4.6
```

Add those to the same provider's Environment variables section if you want stable model choices.

### Verify OpenRouter Is Being Used

Open a Claude session and run:

```text
/status
```

You should see the Anthropic base URL set to:

```text
https://openrouter.ai/api
```

You can also check the OpenRouter activity dashboard for requests from your API key.

### Common OpenRouter Mistakes

- Use `https://openrouter.ai/api`, not `https://openrouter.ai/api/v1`, for Claude Code.
- Set `ANTHROPIC_AUTH_TOKEN` to your OpenRouter API key.
- Set `ANTHROPIC_API_KEY` to an empty string so Claude Code does not try to use an Anthropic login.
- Put these variables on the Claude provider instance, not in global shell startup files.

OpenRouter's setup can change over time. Use its upstream Claude Code guide for the current details:
<https://openrouter.ai/docs/guides/guides/claude-code-integration>.

## I Want To Use Claude Code Router

Claude Code Router is useful when you want a local routing layer with more control than a direct
OpenRouter setup.

Scient does not need a special Claude Code Router provider. Treat the router as a Claude
environment: give a Claude provider its own `CLAUDE_CONFIG_DIR path`, and put whatever variables
the router tells you to export into that provider's Environment variables section. Mark tokens
and API keys as sensitive.

```text
Display name: Claude Router
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_router_home
```

Follow the upstream project's README for the router's own install, startup, and configuration
steps: <https://github.com/musistudio/claude-code-router>.

## I Want Different Claude Settings, Not A Different Account

Create another Claude provider with the same account if you want a named preset.

Examples:

- "Claude Default"
- "Claude Router"
- "Claude Experimental"

If the preset needs different Claude files, give it a different `CLAUDE_CONFIG_DIR path`. If it needs
different API keys, base URLs, or router settings, use Environment variables.

Do not put environment variable assignments in `Launch arguments`.
