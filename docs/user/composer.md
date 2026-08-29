# Message Scient

Use the composer to tell your selected AI what you want to understand, create,
change, or run in the current project. Describe the outcome, important
constraints, and any files or evidence it should use. What the AI can do is
also controlled by the selected provider, available tools, and
[permission mode](permission-modes.md).

## Send a message

Messages can contain up to 120,000 characters. If a draft is longer, Scient
keeps it in the composer and shows how many characters need to be removed.
Shorten the draft or split it into multiple messages, then send again in the
same thread.

On servers that support direct uploads, images upload as soon as you add them. The send button
becomes available after every upload finishes. Failed uploads can be retried or removed.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

On mobile, the model picker shows each OpenCode model's upstream provider, such as Anthropic,
GitHub Copilot, or OpenCode Zen, beneath its name. Search by that provider name to narrow the list
when starting a thread or changing an existing thread's model.

## Prompt stash

Use the default shortcut, `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux, to stash the current
prompt and its images after uploads finish. Restore the entry later from the stash menu. Image
stashes belong to the environment where the images were uploaded and expire with the server's
temporary attachment retention.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

On mobile, these menus are available on the **New task** screen before you start a thread. They
use the skills and commands from the selected environment and provider.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, Scient hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

Scient-managed skills are available from **Settings → Skills** on supported providers. **Agent may
use** lets the agent select a skill when the request clearly matches it. **Only with $name** keeps the
skill available only when you add its exact `$name` token. Skills provide instructions; they do not
add tools or permissions. Changes apply to the next message.

Project skills live at `.scient/skills/<name>/SKILL.md` inside an initialized Scient project. A
new valid project skill is available automatically on the next message and only in that project.
Use **Settings → Skills → Project skills** or the project's **Skills** settings to choose **Agent
access**, **$name only**, or **Deactivated**. Agents can create these ordinary project files when
asked; your access choice remains controlled in Settings.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. Scient opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

## Continue with another provider

Forking lets you continue a conversation with a different provider or model
without changing the original. Use **Fork** beside a sent message or completed
response, use the compact **Fork** action in the model picker, or run `/fork`
to start from the latest completed response. In the new conversation, choose
the provider and model you want before sending.

**New worktree** is off by default, so the fork uses the current workspace without rewinding its
files. Turn it on to create an isolated worktree at the selected checkpoint. The switch is
unavailable when the project is not a Git repository or the fork point has no saved checkpoint.

Forking from a completed response keeps the conversation through that response.
Forking from a sent user message places that message and its images in the new
composer as an unsent draft. A temporary setup failure is safe to retry; Scient
does not open a partially created conversation.

## Queue or steer while an agent is working

When the current turn is running, ordinary `Enter` saves the complete message
and its images in that thread's queue instead of interrupting the turn. Queued
messages appear above the composer and send in order, one turn at a time, after
the active turn becomes ready.

Use `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux to request an
immediate steer instead. A steer is submitted to the active provider rather
than added to the queue. Provider command acceptance and actual same-turn
adoption are separate: a provider that cannot accept that prompt can report a
failure without turning the message into a silently queued item.

Queued rows can be reordered or deleted. **Edit** first removes the item from
the queue and restores its text and readable images to an empty composer; it
does not create an invisible second copy. A failed auto-send remains visible at
the head of the queue with an explicit retry instead of being skipped or
retried silently.

Queues belong to one server thread, survive app restarts, and are limited to 20
items and 64 MiB per thread. A local draft that has not created a server thread
yet has no persistent queue.
