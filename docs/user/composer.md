# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On servers that support direct uploads, images upload as soon as you add them. The send button
becomes available after every upload finishes. Failed uploads can be retried or removed.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, T3 Code hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

Scient-managed skills are available from **Settings → Skills** on supported providers. **Agent may
use** lets the agent select a skill when the request clearly matches it. **Only with $name** keeps the
skill available only when you add its exact `$name` token. Skills provide instructions; they do not
add tools or permissions. Changes apply to the next message.

Project skills live at `.scient/skills/<name>/SKILL.md` inside an initialized Scient project. A
new valid project skill is available automatically on the next message and only in that project.
Use **Settings → Skills → Project skills** or the project's **Skills** settings to choose **Agent
access**, **$name only**, or **Deactivated**. Agents can create these ordinary project files when
asked; Scient never asks them to edit the private preference store.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.
