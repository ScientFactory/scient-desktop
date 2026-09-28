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

Open a conversation file in any of these ways:

- **File → Import Conversation…** in the desktop app, or **Import conversation** in the sidebar,
  then drop the file on the dialog or choose it.
- Drag one `.scic` file anywhere onto the Scient window, including the chat and the message box.
  While you drag it, Scient shows **Drop to import conversation**. Other files dropped on the chat
  are still attached to your message, and so is a Markdown file; a Markdown file dropped
  elsewhere opens for import.
- Open a `.scic` file with the desktop app, for example by double-clicking it. During first-time
  setup, the file waits and opens for import when setup is finished.

Scient sends the file to the destination and checks it straight away; the dialog shows its
progress, and **Cancel** or Esc stops it at any point before you import. If you have more than
one connected environment, choose where the conversation goes under **Destination**; this device
is chosen first. If the destination stops being available or loses its connection while the
dialog is open, Scient stops and asks you to choose another; after a lost connection you can
also choose **Try again** once it reconnects. It never sends the file somewhere else on its own.
Dropping another file on the open dialog checks that file instead.

The check shows what is in the file without showing its messages: how many messages and
attachments it has, which provider and model it came from, what was left out when it was made
(such as the work log or reasoning), and any notes about it. Nothing is added until you choose
**Import**. Choose the project and the model for your next message; Scient suggests the model
new conversations in that project use. **Import** creates a new, separate conversation there,
marked **Imported — unverified**, because anyone can edit a conversation file. Your next message
starts a fresh session with the model you chose. The file never carries the sender's
credentials, running agent, tool permissions, approval decisions, or workspace files, so
importing into a different project does not bring the sender's files with it.

Imported conversations start in Supervised mode, which asks before commands and file changes.
The dialog says so when your usual mode is different.

If the desktop app asks whether to send the file to another computer and you choose **Cancel**,
the import stops without an error.

You can also import a `.md` file. A Markdown file exported by Scient comes back as a
conversation with its messages as text. If some of its message markers are damaged, the dialog
says **Some messages couldn't be read**: tick the box to import the messages Scient could read,
or start a conversation with the whole file instead. Any other Markdown file is attached to a new
conversation as a document, not turned into messages; the dialog then offers
**Start conversation**.

## Using Markdown later

The file is ordinary Markdown with a short header that identifies it as a Scient conversation.
Comments between messages mark where each message starts; they are invisible in most Markdown
viewers. Keep them if you may want to bring the conversation back into Scient later.
