# Export a conversation

Save a conversation as a Markdown file to keep it, edit it, or send it to someone.

1. Open the thread's menu: right-click the thread in the sidebar, or use the menu in the chat
   header.
2. Choose **Export…**.
3. Choose what to include, then **Export** to save a file or **Copy** to put the Markdown on the
   clipboard.

On the desktop app, Export opens a save dialog. In a browser, the file downloads.

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

## Using the file later

The file is ordinary Markdown with a short header that identifies it as a Scient conversation.
Comments between messages mark where each message starts; they are invisible in most Markdown
viewers. Keep them if you may want to bring the conversation back into Scient later.
