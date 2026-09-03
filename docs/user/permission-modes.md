# Permission modes

A permission mode controls how much the AI can do on its own and when it stops
to ask you. It changes the approval boundary, not the quality of the model or
the instructions you gave it.

The mode is set per thread, from the mode control in the message composer. Changing it in one
thread does not change any other thread. A thread created from inside another thread keeps that
thread's mode; otherwise new threads start in **Full access** unless you pick something else
before sending.

## The Modes

**Supervised**: ask before commands and file changes. The agent pauses and shows you what it
wants to run or edit, and waits for approval. Work outside the workspace is restricted.

**Auto-accept edits**: auto-approve edits, ask before other actions. File changes go through
without prompting; commands and anything else still stop for approval.

**Auto**: routine actions proceed without you; risky ones still ask. How this is enforced depends
on the provider: Codex delegates routine approvals to an AI reviewer, Claude uses its own auto
permission mode, Cursor uses Smart Auto review, and providers without an equivalent (such as
OpenCode) fall back to asking, like Supervised.

**Full access**: allow commands and edits without prompts. The default. The agent runs
unattended until it finishes or asks a question of its own.

Approvals appear inline in the conversation. Approve or reject one and the agent continues from
there.

For Grok, **Always allow this session** remembers the matching command or tool input. Other
actions still ask for approval. It does not change the thread to **Full access**.

## Choosing a Mode

Use **Full access** for work in an isolated worktree, reproducible analysis
environment, or other project where unattended commands and edits are expected.

Use **Supervised** when working with irreplaceable data, an unfamiliar workflow,
external systems, or any project where an unwanted command or edit would be
expensive.

**Auto-accept edits** suits refactors where the edits are the point and you only care about the
shell commands.

## Provider Behavior

Each provider maps these modes onto its own approval and sandbox controls. Some
providers cannot support every mode exactly and fall back to asking. The labels
above describe the behavior Scient requests; a provider can still ask for an
additional approval when its own safety rules require one.
