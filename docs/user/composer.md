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
**Download video**. Sent PDF and HTML attachments open in the file viewer;
other files keep their filename and can be downloaded.

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

On web and desktop, an existing thread settles its composer into a single-line resting state when
the composer loses focus. At wider sizes, scrolling the conversation also rests a focused composer,
except when scrolling toward the end while already there. When the thread-context strip has room,
the model and mode controls stay available beside the thread context; otherwise they return when the
composer is focused. Focus the composer or start typing to expand it again. The conversation keeps
the expanded composer's space clear above its last message while the composer rests, so expanding it
again never covers what you scrolled to. New-thread layouts keep the full composer. **Settings → General → Collapse composer** chooses which triggers rest it:
**On unfocus**, **On scroll**, both, or neither. With neither selected the composer stays expanded.

At phone-sized web or desktop window widths, existing threads animate between their compact and
expanded layouts. Up to three image attachments remain visible in either resting layout, followed
by a count when more are attached. At wider sizes, videos, files, and other draft context remain
visible at their natural height; the phone-sized compact row reveals those details when expanded.

On mobile, the model picker shows each OpenCode model's upstream provider, such as Anthropic,
GitHub Copilot, or OpenCode Zen, beneath its name. Search by that provider name to narrow the list
when starting a thread or changing an existing thread's model.

## Model defaults

Scient remembers the last provider, model, and model options you selected and reuses that
selection for new threads. A model configured in a project's settings overrides the remembered
selection for that project; resetting the project setting returns it to the remembered selection.

Model options shown as provider defaults remain display values until you choose them in Scient.
Scient only sends options you selected explicitly, so an unset reasoning level or service tier can
still come from the provider's own configuration.

## Quote an assistant response

On web and desktop, select text in an assistant response, then choose **Cite in composer** from the
menu that appears when you release the selection. This inserts an inline quote chip at your cursor
and opens an optional comment bubble beside the selected text; press `Enter` or choose **Save** to
attach the comment, or leave it blank to keep just the quote. You can type before and after the
chip, such as a quote followed by "what do you mean?". A selection must stay within one response
and fit in 8,000 characters.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment, and the remove button to delete the quote and its comment from
the draft. Copying, reloading, and restoring a [stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

Select a chip in the composer or a sent message to open the source thread, scroll to the response,
and highlight the quoted passage — including in older history. The
highlight pulses, holds for a moment, then fades on its own; press `Escape` to stop the navigation
or clear it early. If the source is unavailable or its text has changed, the saved quote stays
readable and Scient shows a warning.

Mobile shows the full saved quote and its comment in sent messages. It does not offer
**Cite in composer** or navigation to a quote's source.

## Images and videos in messages

On web, desktop, and mobile, select a link to an image or video to open it inside Scient.
Workspace image and video links open the file viewer. Links to media outside the workspace
open a media preview.
Videos opened from the file explorer or a file-viewer tab also play inside Scient. They
stream from the environment as needed, rather than downloading the entire video before playback.
Paths in inline code, such as `/tmp/recording.mp4`, work the same way. Image embeds stay inline;
video embeds show a player with the browser's controls, full screen included. Visible video previews load
an initial frame when supported, but stay paused until you press Play. Video file references use
a filmstrip icon.

On web and desktop, hover over a preview to see its full file path or original URL. Right-click
to copy that reference, save the image or video, or copy an image to the clipboard. The video
player's built-in controls can download a video too. If the player cannot decode a video, its error message
offers a link to open the source in the browser. Workspace media also offers **Copy relative
path** and **Open in file viewer**. These actions are available in expanded previews too.

On mobile, touch and hold an inline image or a video thumbnail to see its source,
copy the path or URL, or choose **Save or share**. Workspace files can open in the file viewer
from the same menu. Saving downloads a copy only when you request it; it does not change how
the video buffers during playback. On iOS, touch and hold a file reference in a message to
copy its full or relative path or open it in the file viewer.

Use Markdown image syntax to embed either kind of media:

```markdown
![Screenshot](/tmp/screenshot.png)
![Recording](/tmp/recording.mp4)
[Open recording](/tmp/recording.mp4)
```

Relative paths resolve from the thread's workspace. Absolute paths and `file://` links refer to
the environment's machine, even when you connect remotely or use your phone. Supported media
can live outside the workspace, including in Downloads or `/tmp`.

Scient serves the original file without adding it to attachment storage. If that file is moved
or deleted, its preview can no longer load from the environment. A browser or device may still
have a cached copy. Supported video formats and codecs depend on the browser or device.

Bare paths in ordinary prose and paths inside code blocks stay text. Raw HTML `<video>` tags
are not supported; use the Markdown embed syntax above.

## Files outside the workspace

When an agent links to a file it wrote outside the workspace, such as a Markdown report in
`/tmp`, select the link to open it in the file viewer. The viewer shows the file read-only, with
rendered Markdown available as usual; it cannot edit files outside the workspace. The workspace
file tree stays hidden because it does not describe the open file. HTML and PDF files outside the
workspace open the same way as ones inside it. Because such a file is served on its own, an HTML
page outside the workspace cannot load scripts, styles, or images from files beside it.

## HTML and PDF files in the file viewer

On web and desktop, the file viewer shows HTML and PDF files as a rendered page. Use the
source toggle in the viewer's header to switch an HTML file between the page and its markup; the
choice persists like the rendered-Markdown toggle. A link to a line always opens the source. HTML
runs in an isolated frame with no access to your Scient session. On desktop, the integrated
browser remains available from the same header for a full browser view.

## Changing projects

On web and desktop, changing the project from a new thread keeps the current environment when that
project exists there. If it does not, Scient selects another environment that has the project.

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

In a thread with prior conversation context, send `/compact` to reduce context usage. Web and desktop also offer this action from the context meter, and the work log records token counts when the provider reports them.

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

A skill token runs the skill wherever it sits in your message. Scient sends it to each provider in
the form that provider runs, so the text before and after the token is kept. Skills that only you may
start, and never the agent on its own, work the same way. A skill you switched off in the provider's
settings does not appear in either menu.

Provider commands such as `/compact` only run when they open the message, so the `/` menu offers
them only there. Scient's own commands, such as `/model` and `/plan`, and skills stay available on
any line.

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

Scient checks the selected response, retained attachments, and available
workspace before creating the fork. A stopped or failed answer is not a
completed fork point; choose an earlier completed response or a sent user
message instead. `/fork` and the provider picker's Fork action resolve the
latest completed response on the server.

Errors appear inside the fork dialog. **Retry** resumes the same attempt,
including its original title and workspace choice. Losing the connection does
not discard the staged draft or create another conversation. This recovery
survives reloading the app in the same browser profile. If you switch
conversations during setup, Scient finishes the fork in the background without
moving you away from your current conversation. Open the ready fork from the
sidebar, or return to the same Fork action to resume it.

If the original worktree was removed, **New worktree** can still restore its
saved checkpoint when the project repository retains it. Scient never silently
substitutes a different workspace. Missing retained files must be restored, or
you can choose a fork point before they were attached.

You can rename the fork afterward without affecting its history or source link.
The **Conversation forked here** marker opens the original conversation, even
after either conversation is renamed. Archived originals can still be opened;
deleted originals remain unavailable.

Choose any configured, available provider and model before the fork's first
send. The provider-switch Fork action moves an unchanged ordinary composer
draft after setup succeeds. A draft changed during setup stays in the original
conversation. Queued messages and queue edits always stay with the original;
forking never sends them.

If the first request's provider acknowledgement is lost, Scient does not
automatically send it again. A response to that request lets you continue in
the same fork. If no response arrives, create a fresh fork from the last
completed response to start an independent session. Retained history is sent
as bounded context, so very long histories and older images may be omitted
from the provider's input while remaining visible in Scient.

Server-checked eligibility and in-place setup retries require an updated
server. Older servers retain their previous fork behavior and recovery limits.

## Queue or steer while an agent is working

On desktop and web, press **Enter** while an answer is running to queue your
message and images in that thread. Messages start one at a time after the
previous answer has fully finished. They continue in their original thread when
you visit another thread or close its view. Sending while other messages are
waiting normally adds your message behind them. After **Stop**, an ordinary new
message starts work while that queue waits, as described below.

Use **Cmd+Enter** on macOS, **Ctrl+Enter** elsewhere, or a queued row's **Steer**
action to request an immediate steer. The provider must support adopting the
message into its current turn; a rejection remains visible.

Drag queued rows to change their order, or delete them. **Edit** removes a row
from the waiting list and puts its text and images into the same composer. If
you were already writing, that ordinary draft is temporarily hidden and kept
intact. Send the edit to return it to its previous place and restore your
ordinary draft. Messages that already started cannot be overtaken.

An item being edited cannot send itself. Other waiting messages can continue
while you edit. The existing **Stash** action saves the edit for later, releases
its queue position, and brings back your ordinary draft. Restore the saved text
and attachments through the usual stash menu.

**Stop** leaves queued messages in place. When you send another message, that
answer runs first; the queue waits until it finishes successfully, then advances
one message at a time. Restarting work or the server does not send queued messages
by itself. A failed answer also leaves the remaining queue waiting for later
successful work. No extra **Retry** is needed after that answer finishes.

**Retry** is for a queue delivery error; it cannot bypass a running answer or
release messages waiting after Stop. If an ordinary Send races another start,
Scient preserves the draft and asks you to send again so it can join the queue safely.

Queues survive app restarts and hold up to 20 messages and 64 MiB per thread.
Generic files still cannot be queued. Local threads that have not reached the
server yet have no persistent queue. Edited drafts recover from this browser's
local storage; keep the owning window or reopen it to finish an edit. Older
clients must update before sending to a server using the new queue protocol.
