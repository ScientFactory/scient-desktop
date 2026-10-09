# Export a conversation

Save a conversation as Markdown, PDF, or Word, or transfer it to another Scient installation with a
portable `.scic` file.

1. Open the thread's menu: right-click the thread in the sidebar, or use the menu in the chat
   header.
2. Choose **Export**, then the format: **Markdown (.md)**, **PDF (.pdf)**, **Word (.docx)**, or
   **Scient file (.scic)**.
3. Choose what to include, then press the Save button (**Save .md**, **Save PDF**, **Save .docx**,
   or **Save .scic**).

Save opens a save dialog on the desktop app; in a browser, the file downloads (PDF needs the desktop
app). The ⓘ button next to the dialog's title says what the format is for.

To put the conversation on the clipboard instead, choose **Copy ▸ Conversation as Markdown** in the
thread's menu. It copies the whole conversation as text-only Markdown, without the work log or
reasoning.

Choose **Export ▸ PDF (.pdf)** for a print-ready document with a heading for each speaker and the
images, math, and diagrams inside the file. Like the other formats, it opens a save dialog; when it is saved, choose **Open** on the
notice to read it in Scient's PDF reader. The options below apply to PDF too: the work log and
reasoning appear as indented blocks under each answer, and long ones continue onto the next page.
An image that cannot be shown prints as a labelled box, listed in the notes at the end of the PDF.
PDF needs the Scient desktop app; in a browser the option is unavailable and says why.

Choose **Word** for an editable `.docx`: equations stay editable, and images, tables, footnotes, and
citations are kept. Word export needs Pandoc. The first time, the Word dialog offers
**Install Pandoc**, a one-time download that shows its progress in the dialog; once it is
installed, the Word options appear. If Pandoc cannot run on this computer, the dialog says why.

Choose **Scient file** when the recipient wants to open and continue the conversation in their own
Scient. A Word or PDF file is for reading and editing, not for restoring a conversation.

## What the file contains

Every export covers the whole conversation as it is saved on the server, including messages the
chat view has not loaded yet. Each message appears under a heading with the speaker and the time.
Line breaks appear where chat shows them.

If a response is still being written, that turn is left out and the file says so.

## Options

- **Work log** adds the tools, commands, and results under each answer, in collapsible sections.
- **Reasoning** adds the thinking chat shows in its collapsed blocks.

Both are off each time you open the dialog. Turning either on briefly shows a reminder above that
switch: the export may include file paths, commands, and their output. Check the file before sharing.

When the conversation has images or attachments, the Markdown dialog offers **Text only (.md)**,
which lists attachments by name, or **With attachments (.zip)**, which keeps the files next to the
Markdown in one `.zip`. Attachments that are no longer available are listed by name and noted in the
file.

## Import and continue

Open a conversation file in any of these ways:

- **File → Import Conversation…** in the desktop app, or **Import conversation** in the sidebar,
  then drop the file on the dialog or choose it.
- Drag one `.scic` file anywhere onto the Scient window, including the chat and the message box.
  While you drag it, Scient shows **Drop to import conversation**. Other files dropped on the chat
  are still attached to your message, and so is a Markdown file; a Markdown file dropped
  elsewhere opens for import.
- Open a `.scic` file with the desktop app, for example by double-clicking it or choosing
  **Open with Scient**. Scient first shows a compact local confirmation with the conversation's
  title and counts. Choose **Read conversation** if you want to read it first; the window grows
  to show it.
  Nothing is imported or uploaded in this window. **Cancel** leaves your workspace unchanged;
  **Import…** opens the project chooser. Import happens only when you
  confirm there, and no agent runs automatically. During first-time setup, the accepted file
  waits until setup is finished. Very large conversations may not fit the local preview;
  you can still choose **Import…** to have the complete file checked.

The file-opening window shows a bounded text preview, not a full-fidelity rendering of every
attachment or diagram. A packaged app launched solely to preview a file does not start its
workspace/backend until you continue; cancelling the last preview exits that file-only session.
An already-running app keeps its workspace. A managed development runner may already have
started its development servers independently.

On Linux, Scient's AppImage registers the conversation MIME type when run. If your file manager
does not associate the file automatically, choose Scient using **Open with**. Changing your
preferred application remains your operating system's decision. Native file-manager previews
(Quick Look or Explorer's Preview pane) require separately built preview components; the file
association alone does not provide them.

Inside Scient, choose a file and a **Project**. Once both are selected, Scient uploads the file to
the project's environment and checks it in the background, before you press **Import**.
**Import** creates the conversation only after those checks finish. Projects are grouped by environment
when more than one is available; there is no separate destination selector. **Cancel** or Esc
stops the check before import. If the chosen project's environment becomes unavailable,
Scient asks you to choose another project or try again after reconnecting. It never switches
the destination on its own.
Dropping another file on the open dialog checks that file instead.

Nothing is added until you choose **Import**. The conversation uses the model a new chat in the
chosen project would use; you do not need to choose a model in the import dialog.
**Import** creates a new, separate conversation there,
marked **Imported — unverified**, because anyone can edit a conversation file. Your next message
starts a fresh session with that model. The file never carries the sender's
credentials, running agent, tool permissions, approval decisions, or workspace files, so
importing into a different project does not bring the sender's files with it.

Imported conversations start in Supervised mode, which asks before commands and file changes.

If the connection drops after you choose **Import**, the import may still finish. Scient waits
for the connection to return, checks, and then either opens the new conversation or lets you try
again; it never imports the conversation twice.

If the desktop app asks whether to send the file to another computer and you choose **Cancel**,
the import stops without an error.

You can also import a `.md` file. A Markdown file exported by Scient comes back as a
conversation with its messages as text. If some of its message markers are damaged, the dialog
says **Some messages couldn't be read**. Choose **Import readable messages** or **Start with
the whole file** instead. Any other Markdown file is attached to a new
conversation as a document, not turned into messages; the dialog then offers
**Start**.

One import holds up to 5,000 messages, work-log entries, and other items. For a longer
conversation, export it again with **Work log** and **Reasoning** turned off: its messages still
come across, without the tool details and thinking. If it is still too long, Scient can't import
it as a conversation; export it as PDF or Markdown to keep a copy you can read. A Markdown
transcript that is too long can still start a conversation: choose **Start with the whole file**
to attach the file as a document. Anything an import
leaves out, such as damaged Markdown sections, is noted on the imported conversation. If the
file's times are later than the moment you import it, because the other computer's clock was ahead,
Scient moves all of them back by the same amount so that the conversation stays in order, and the
notice on the conversation says by how much.

## Using Markdown later

The file is ordinary Markdown with a short header that identifies it as a Scient conversation.
Comments between messages mark where each message starts; they are invisible in most Markdown
viewers. Keep them if you may want to bring the conversation back into Scient later.

## Word export and Pandoc

Word export runs Pandoc, which Scient downloads into its own folder the first time you need it;
nothing is installed system-wide. Pandoc is free software under the GNU GPL, version 2 or later.
**Settings → Documents → Word export** shows the Pandoc release, its licence, and a link
to that release's source code; the full notice is under **Open source licenses**. Search Settings
for "Word" or "Pandoc" to find it.

If Pandoc was installed but can no longer start, the export says so and Settings offers **Reinstall
Pandoc**. Word export stops a conversion that takes longer than two minutes; try leaving out the work
log and reasoning, or export the conversation as PDF or Markdown.
