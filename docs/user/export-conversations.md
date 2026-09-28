# Export a conversation

Save a conversation as Markdown, PDF, or Word, or transfer it to another Scient installation with a
portable `.scic` file.

1. Open the thread's menu: right-click the thread in the sidebar, or use the menu in the chat
   header.
2. Choose **Export…**.
3. Choose what to include, then **Export** to save a file or **Copy** to put the Markdown on the
   clipboard.

On the desktop app, Export opens a save dialog. In a browser, the file downloads.

Choose **PDF** to get a readable document with a heading for each speaker and the images inside the
file. The PDF opens in Scient's PDF reader; use **Save Copy** there to keep a copy. The options
below apply to PDF too: the work log and reasoning appear as indented blocks under each answer.
PDF needs the Scient desktop app; in a browser the option is unavailable and says why.

Choose **Scient (.scic)** when the recipient wants to import and continue the conversation in
Scient. Choose **Word** for an editable `.docx`; Word export requires Scient's managed Pandoc tool,
which the export dialog can offer to install when unavailable. A Word or PDF file is for reading
and editing, not for restoring a native conversation.

## What the file contains

The export contains the whole conversation as it is saved on the server, including messages the
chat view has not loaded yet. Each message appears under a heading with the speaker and the time.
Line breaks appear where chat shows them.

If a response is still being written, that turn is left out and the file says so.

## Options

- **Work log** adds the tools, commands, and results under each answer, in collapsible sections.
- **Reasoning** adds the thinking chat shows in its collapsed blocks.

Both are off each time you open the dialog. The work log and reasoning can contain file paths,
command output, and secrets, so check the file before you share it.

- **Range** exports the whole conversation, or everything up to a message you choose.

When the conversation has images or attachments, you can export **Text only (.md)**, which lists
attachments by name, or **With attachments (.zip)**, which keeps the files next to the Markdown in
one `.zip`. Copy always copies text only. Attachments that are no longer available are listed by
name and noted in the file.

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
