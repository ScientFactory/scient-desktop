# Export a conversation

Save a conversation as Markdown, PDF, or Word, or transfer it to another Scient installation with a
portable `.scic` file.

1. Open the thread's menu: right-click the thread in the sidebar, or use the menu in the chat
   header.
2. Choose **Export**, then the format: **Markdown (.md)…**, **PDF (.pdf)…**, **Word (.docx)…**, or
   **Scient file (.scic)…**.
3. Choose what to include, then press the Save button (**Save .md**, **Save PDF**, **Save .docx**,
   or **Save .scic**).

Save opens a save dialog on the desktop app; in a browser, the file downloads (PDF needs the desktop
app). The ⓘ button next to the dialog's title says what the format is for.

To put the conversation on the clipboard instead, choose **Copy ▸ Conversation as Markdown** in the
thread's menu. It copies the whole conversation as text-only Markdown, without the work log or
reasoning.

Choose **Export ▸ PDF (.pdf)…** for a print-ready document with a heading for each speaker and the
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

Both are off each time you open the dialog. While either is on, the dialog reminds you that the
export may include file paths, commands, and their output, so check the file before you share it.

When the conversation has images or attachments, the Markdown dialog offers **Text only (.md)**,
which lists attachments by name, or **With attachments (.zip)**, which keeps the files next to the
Markdown in one `.zip`. Attachments that are no longer available are listed by name and noted in the
file.

## Import and continue

In Scient, use **File → Import Conversation…** (or open a `.scic` file with the desktop app), select
the file, and choose **Preview**. Review the messages, attachments, omissions, and warnings before
choosing a destination project and a ready provider/model. **Import and continue** creates a new
local thread. Your next message starts a fresh provider session; the file does not carry over the
sender's credentials, running agent, tool permissions, or approval decisions. Importing into a
different project does not automatically transfer the sender's workspace files.

You can also import a `.md` file. Scient conversation Markdown has a header and message markers;
if any markers are damaged, the preview identifies them and requires you to acknowledge that only
clean messages will be imported. An ordinary Markdown document is added to a new conversation as
a document, not impersonated as a transcript.

One import holds up to 5,000 messages, work-log entries, and other items. For a longer
conversation, export it again without the work log, or only up to an earlier message. Anything an
import leaves out, such as damaged Markdown sections, is noted on the imported conversation.

## Using Markdown later

The file is ordinary Markdown with a short header that identifies it as a Scient conversation.
Comments between messages mark where each message starts; they are invisible in most Markdown
viewers. Keep them if you may want to bring the conversation back into Scient later.

## Word export and Pandoc

Word export runs Pandoc, which Scient downloads into its own folder the first time you need it;
nothing is installed system-wide. Pandoc is free software under the GNU GPL, version 2 or later.
**Settings → Scientific Computing → Word export** shows the Pandoc release, its licence, and a link
to that release's source code; the full notice is under **Open source licenses**. Search Settings
for "Word" or "Pandoc" to find it.

If Pandoc was installed but can no longer start, the export says so and Settings offers **Reinstall
Pandoc**. Word export stops a conversion that takes longer than two minutes; try leaving out the work
log and reasoning, or export the conversation as PDF or Markdown.
