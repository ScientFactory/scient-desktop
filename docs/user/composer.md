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

On web and desktop, attachments upload as soon as you add them. The send button becomes available
after every upload finishes. Failed uploads can be retried or removed.

In the retained mobile client, an empty composer shows an interrupt button while the agent is
working. Adding text or an attachment replaces it with the send button in both compact and expanded
composers.

On web and desktop, if you reload before a file finishes uploading, the draft keeps the file's name
and shows **Attach again** next to it. Attach the file again or remove it, then send.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message. On iOS, selecting them from **Photo Library** does the
same. The 10 MB image limit applies to the converted photo.

## Attach files

On web and desktop, attach files with the file picker, drag and drop, or paste.
There is no document-type allowlist: PDFs, spreadsheets, archives, audio, video,
code, and files with unfamiliar extensions can all be attached. Images without
a native image-input path, such as SVG and TIFF, are attached as ordinary files.
Files must be readable and non-empty, fit the server's displayed size limit,
and finish uploading before you send.

Images can be up to 10 MB. Other files use the server's advertised limit,
capped at 50 MB. Each message can contain up to eight attachments in total.

Attaching a file makes it available to the agent; it does not guarantee that
every provider can understand every format. Depending on the provider, it
receives the attachment directly or a server-local path it can read using its
available tools. Uploaded files are not automatically executed.

Click a video attachment to play it. If its format cannot play in the app, use
**Download video**. Other files keep their filename and can be downloaded.

In the retained mobile client (not yet a public Scient release), tap **+** for **Photo Library**
or, when the connected server supports file uploads, **Choose Files**. Photos, videos, and files can
also arrive through the system share sheet. Mobile keeps a local draft copy, allows previewing and
queueing while offline, resumes uploads after reconnecting, and preserves drafts and queued messages
across app restarts. Signing out keeps them on the device until the same account signs in again.

Tap an image or PDF before or after sending to open it. On iOS, the native viewer supports image
zoom, sharing, and PDF page navigation and search. On Android, images use the image viewer and PDFs
open through the system chooser. Videos open in a full-screen player with native controls on mobile;
supported iOS videos stream from their environment as they play. Unsupported formats can still be
saved or shared to another app.

On desktop and web, generic files cannot yet be queued. Keep them in the composer and
send when the current turn finishes, or use the steer shortcut when supported.
Editing a fork from a sent message with file attachments is not supported yet;
fork from a completed response to retain the conversation and its files.

On mobile, the model picker shows each OpenCode model's upstream provider, such as Anthropic,
GitHub Copilot, or OpenCode Zen, beneath its name. Search by that provider name to narrow the list
when starting a thread or changing an existing thread's model.

## Changing projects

On web and desktop, changing the project from a new thread keeps the current environment when that
project exists there. If it does not, T3 Code selects another environment that has the project.

## Notices above the composer

On web and desktop, loading and syncing statuses use the available banner width. Task progress
appears above the composer, while the timeline's working indicator shows only elapsed time.

When several notices are active, the additional notices peek above the attached banner. Hover over
the peek, or focus **Show other notices** and press `Enter` or `Space`, to reveal them. Press
`Escape` to close the stack. On a touchscreen, tap the peek.

## Prompt stash

Use the default shortcut, `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux, to stash the current
prompt and its attachments after uploads finish. Restore the entry later from the stash menu. A
stash containing files belongs to the environment where those files were uploaded. The server keeps
stashed files for 24 hours; after that, restore the prompt and use **Attach again** or remove the
expired file before sending.

## Voice input on iPhone

In the retained mobile client, supported iPhones with iOS 26 or later can record a message from the
composer. Tap the microphone, speak, then tap the checkmark to transcribe on the device. The draft
stays visible in an expanded composer; a collapsed composer becomes a compact recording strip. The
result is inserted where recording began so it can be reviewed and edited before sending.

The first use may download Apple's speech model and require a network connection. Later
transcription works offline for that language. Recordings are limited to five minutes. Canceling,
leaving the screen, or an audio interruption preserves the existing draft and attachments while
discarding the new recording. Scient deletes the local audio after transcription or cancellation
and sends only the normal message text.

## Commands and skills

When an agent provides an artifact-template card, **Use template** adds its
skill prompt to your existing draft. Review or edit it before sending; the
button does not send a message automatically or grant new permissions.

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

On mobile, these menus are available on the **New task** screen before you start a thread. They
use the skills and commands from the selected environment and provider.

On web and desktop, new profiles leave **Show skills in slash menu** off. Type `$` to select a skill,
or turn on this option in **Settings → General** to include skill aliases in `/` as well. Saved
preferences are preserved. Provider-native slash commands are still shown when skill aliases are off.

When enabled, skill results use the `/skill:Skill Name` label and add the
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
