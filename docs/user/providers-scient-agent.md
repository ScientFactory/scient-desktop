# Scient Agent in Scient

Scient Agent is Scient's own agent. It is built from [Oh My Pi](./providers-omp.md) and keeps
what Oh My Pi can do: read and edit files, run shell commands and code, use skills and MCP
servers, delegate to subagents, and run work in the background. Scient's own tools, skills, and
workspace awareness are available to it, as they are to Oh My Pi.

It is a separate product from Oh My Pi. It has its own executable, its own settings and sign-ins,
and its own conversations. You can use both on the same computer; neither reads or changes the
other's files, and a conversation started in one cannot be continued in the other.

## Setup

Scient Agent is off by default. This version of Scient does not install it for you: build or
download the `scient-agent` executable (0.1.0 or newer), then in **Settings > Providers** enable
**Scient** and set **Binary path** if `scient-agent` is not on the server's `PATH`.

Scient starts one `scient-agent --mode rpc --approval-mode yolo` process for each conversation.
**Full access** is the only runtime mode. It is not an operating-system sandbox: the agent's
shell and code can reach whatever your user account can.

## Models

Scient Agent starts with no sign-ins of its own. It does not use Oh My Pi's.

- **Custom models.** Attach an OpenAI-compatible, OpenAI Responses, or Anthropic Messages
  connection in Scient's **Custom models** settings. Scient passes the key to the agent privately
  for each process; it is never in the agent's environment or arguments.
- **Local models.** A model server running on this computer, such as Ollama, is found on its own.
- **Keys in your environment.** A provider key the server's environment already has, such as
  `ANTHROPIC_API_KEY`, is used as Oh My Pi would use it.

Signing in to a model subscription from inside Scient is not available yet.

## Where it keeps things

Everything Scient Agent owns (settings, sign-ins, logs, caches) is in a folder inside Scient's
own data directory, not in your home directory. Removing Scient's data removes it. Files a task
creates go where the task puts them, usually your project.

In a project, Scient Agent reads `AGENTS.md` (or `CLAUDE.md` when there is no `AGENTS.md`), its
own `.scient-agent` folder, and other agents' project folders such as `.claude`, as Oh My Pi does.
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
