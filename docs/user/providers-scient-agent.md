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
model picker. This version of Scient does not install it for you: build or download the
`scient-agent` executable (0.1.0 or newer), and set **Binary path** if `scient-agent` is not on
the server's `PATH`. Until Scient finds the executable and a model, a new conversation starts
with the next provider that is ready.

Scient starts one `scient-agent --mode rpc --approval-mode yolo` process for each conversation.
**Full access** is the only runtime mode. It is not an operating-system sandbox: the agent's
shell and code can reach whatever your user account can.

## Models

Scient Agent starts with no sign-ins. Give it a model in one of these ways:

- **Custom models.** Attach an OpenAI-compatible, OpenAI Responses, or Anthropic Messages
  connection in Scient's **Custom models** settings. Scient passes the key to the agent privately
  for each process; it is never in the agent's environment or arguments.
- **Local models.** A model server running on this computer, such as Ollama, is found on its own.
- **Keys in your environment.** A provider key the server's environment already has, such as
  `ANTHROPIC_API_KEY`, is used.

Signing in to a model subscription from inside Scient is not available yet. Until it is, the
agent's own terminal command works: run `scient-agent login` with `SCIENT_AGENT_ROOT` set to the
agent's folder in Scient's data directory (`scient-agent/instances/<instance id>`), so the
sign-in is stored where Scient runs the agent. Then refresh the provider in **Settings >
Providers** so its models appear.

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

Not claimed: Windows and Linux, hosted model accounts, and managed installation.
