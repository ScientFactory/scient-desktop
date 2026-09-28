# Export a conversation

Save a conversation as Markdown, PDF, or Word, or transfer it to another Scient installation with a
portable `.scic` file.

1. Open the thread's menu: right-click the thread in the sidebar, or use the menu in the chat
   header.
2. Choose **Export**, then the format: **Markdown (.md)…**, **PDF (.pdf)…**, **Word (.docx)…**, or
   **Scient file (.scic)…**.
3. Choose what to include, then press the Save button (**Save .md**, **Save PDF**, **Save .docx**,
   or **Save .scic**).

For Markdown, Word, and Scient files, Save opens a save dialog on the desktop app; in a browser, the
file downloads. The ⓘ button next to the dialog's title says what the format is for.

To export only the start of a conversation, hover a message and choose **Export up to here…**, then
the format. The dialog opens with that message selected as the last one to include.

To put the conversation on the clipboard instead, choose **Copy ▸ Conversation as Markdown** in the
thread's menu. It copies the whole conversation as text-only Markdown, without the work log or
reasoning.

Choose **PDF** for a print-ready document with a heading for each speaker and the images, math, and
diagrams inside the file. The PDF opens in Scient's PDF reader; use **Save Copy** there to keep a
copy. The work log and reasoning appear as indented blocks under each answer. PDF needs the Scient
desktop app; in a browser the dialog says so and offers no Save button.

Choose **Word** for an editable `.docx`: equations stay editable, and images, tables, footnotes, and
citations are kept. Word export needs Pandoc. The first time, the Word dialog offers
**Install Pandoc**, a one-time download that shows its progress in the dialog; once it is
installed, the Word options appear. If Pandoc cannot run on this computer, the dialog says why.

Choose **Scient file** when the recipient wants to open and continue the conversation in their own
Scient. A Word or PDF file is for reading and editing, not for restoring a conversation.

## What the file contains

The export contains the whole conversation as it is saved on the server, including messages the
chat view has not loaded yet. Each message appears under a heading with the speaker and the time.
Line breaks appear where chat shows them.

If a response is still being written, that turn is left out and the file says so.

## Options

- **Work log** adds the tools, commands, and results under each answer, in collapsible sections.
- **Reasoning** adds the thinking chat shows in its collapsed blocks.

Both are off each time you open the dialog. While either is on, the dialog reminds you that the
export may include file paths, commands, and their output, so check the file before you share it.

- **Range** exports the **Whole conversation**, or **Up to a message…**: from the start of the
  conversation through the message you choose.

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

## Using Markdown later

The file is ordinary Markdown with a short header that identifies it as a Scient conversation.
Comments between messages mark where each message starts; they are invisible in most Markdown
viewers. Keep them if you may want to bring the conversation back into Scient later.
