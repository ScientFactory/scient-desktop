# Scient Agent in Scient

Scient Agent is ScientFactory's agent. It reads and edits files, runs shell commands and code, uses
skills and MCP servers, delegates to subagents, and runs work in the background. Scient's tools,
skills, and workspace awareness are available to it.

It has its own executable, its own settings and sign-ins, and its own conversations.

Scient Agent is a fork of [Oh My Pi](./providers-omp.md). The two are separate products: you can
use both on the same computer, neither reads or changes the other's files, and a conversation
started in one cannot be continued in the other.

## Setup

Scient Agent is on by default and is the first provider in **Settings > Providers** and in the
model picker. On macOS (Apple silicon and Intel), Linux (x86-64 and ARM64, glibc) and Windows
(x86-64 and ARM64), **Install** is available when Scient has a qualified Scient Agent release. **Manage** provides update, repair, and removal for that private installation.
Installing the executable does not connect a model account.

Until the first qualified release is published, setup explains that no release is available.
You can use a locally built `scient-agent` executable (0.1.0 or newer): set **Binary path** if it
is not on the server's `PATH`. Scient preserves an explicit custom path rather than replacing
it with a managed installation. Linux with musl (Alpine) does not offer managed installation.

Until Scient finds the executable and a model, a new conversation starts with the next provider
that is ready.

Updates wait for running work before activating the verified replacement. A failed check leaves
the previous release in place. Removing the managed executable preserves model sign-ins,
conversations, projects, and other agent installations.

Scient starts one `scient-agent --mode rpc --approval-mode yolo` process for each conversation.
**Full access** is the only runtime mode. It is not an operating-system sandbox: the agent's
shell and code can reach whatever your user account can.

## Models

Scient Agent starts with no sign-ins. Give it a model in one of these ways:

- **Sign in to a model account.** In **Settings > Providers**, open **Manage** on Scient Agent.
  **Model accounts** lists every sign-in the agent supports: accounts you sign in to in your
  browser, and services you add an API key for. Choose one, finish in the browser, and paste a
  code or key if the agent asks for one. **Sign out** removes a sign-in the agent stored.
- **Custom models.** Attach an OpenAI-compatible, OpenAI Responses, or Anthropic Messages
  connection in Scient's **Custom models** settings. Scient passes the key to the agent privately
  for each process; it is never in the agent's environment or arguments.
- **Local models.** A model server running on this computer, such as Ollama, is found on its own.
- **Keys in your environment.** A provider key the server's environment already has, such as
  `ANTHROPIC_API_KEY`, is used.

The agent runs each sign-in itself and stores it in its own folder. For most accounts it signs
in the way that vendor's own tool does, so the vendor's terms for your account apply. A sign-in
that asks more than one question cannot be shown yet; for those, run `scient-agent login` in a
terminal with `SCIENT_AGENT_ROOT` set to the agent's folder in Scient's data directory
(`scient-agent/instances/<instance id>`), then refresh the provider.

Signing out removes the sign-in and then stops Scient Agent's running conversations, so none
keeps using it. They resume when you next use them. A stored sign-in that no longer works can be
renewed or signed out of from the same list.

When Scient Agent has no model at all, its provider card says so and how to add one.

## Where it keeps things

Scient Agent's settings, sign-ins, logs and caches are in a folder inside Scient's own data
directory, not in your home directory. Removing Scient's data removes them. A `.env` file in a
project or in your home directory cannot move them. Files a task creates go where the task puts
them, usually your project.

One thing is kept in your home directory. Some sign-ins to a model subscription register a small
helper with your operating system to receive the result, and the agent keeps that helper's record
in `~/.scient-agent/oauth`. The sign-in itself is stored in Scient's data directory.

In a project, Scient Agent reads `AGENTS.md` (or `CLAUDE.md` when there is no `AGENTS.md`), its
own `.scient-agent` folder, and other agents' project folders such as `.claude`.
It reads another agent's folder in your home directory (`~/.claude`, `~/.codex`, and similar) only
when you turn that on in the agent's own settings. It does not read `.omp` anywhere.

## Qualification

Verified on macOS Apple silicon with Scient Agent 0.1.0 (built from Oh My Pi 18.4.8):

- Scient recognises the executable, lists its models, and refuses an `omp` executable configured
  in its place; Oh My Pi refuses a `scient-agent` executable the same way.
- A conversation starts and stops, and the agent writes its own files only inside the folder
  Scient assigns.
- A full turn against a local Ollama model creates a file in the project, completes, and resumes
  after a restart. Oh My Pi refuses to resume that conversation.
- Scient Agent and a stock Oh My Pi 18.4.8 run at the same time; stopping one leaves the other
  running, and Oh My Pi's home is unchanged.

The managed installer has automated coverage for qualification, failed activation, offline
recovery, repair, and removal. Downloading a signed public Scient Agent release still requires
the first release to be published and qualified. Windows, Linux, and hosted model accounts are
not claimed by these checks.
