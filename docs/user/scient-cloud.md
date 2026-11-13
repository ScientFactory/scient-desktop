# Sync and share links

Scient Cloud syncs your conversations so you can read them from anywhere, share one with a
link, and continue a conversation on another of your computers. Your project files never leave your
computer; only conversations do.

Everything here needs a Scient account. Sign in from Settings > Sharing & access.

## Sync conversations

Turn on **Sync conversations** in Settings > Sharing & access. From then on, this computer syncs
its conversations to your account a little after each reply settles. It works in the
background and never slows down a running conversation.

- **What is synced:** each conversation's messages, the agent's work log and reasoning, which model
  answered, and attached files up to 25 MB each. The Git branch and commit the project was on are
  noted so file mentions can link to GitHub.
- **What is not synced:** your project files, side chats and delegated sub-conversations, and files
  over the size limit (the synced conversation says they stayed on your computer).
- **Archive and delete:** an archived conversation stays in the cloud marked as archived. Deleting a
  conversation deletes it from the cloud too.
- **Storage:** the row shows when this computer last synced and how much of your allowance is used.
  The free allowance is 1 GB, with up to 64 MB per conversation. When it is full, sync pauses and
  the row says so; your conversations on this computer are not affected.
- **Turning it off** stops syncing right away. What is already in the cloud stays readable until you
  delete it. Unlinking this computer from Scient Connect also turns sync off. **Open** on the row
  goes to your synced conversations.
- **Delete from Scient Cloud** removes everything this computer synced and turns sync off. What your
  other computers synced stays.

Synced conversations are stored encrypted with a key unique to your account. Scient's service holds that
key so it can show your conversations in the browser, so this is not end-to-end encryption. Share
links (below) are end-to-end encrypted by default.

## Read your conversations anywhere

Open **Cloud conversations** in the sidebar, in the desktop app or at
[app.scientfactory.com](https://app.scientfactory.com). Conversations are grouped by computer and
project, newest first. They are read-only, readable even while the computer that made them is
off. If a reply was still running when the computer went offline, it shows the last finished
reply and says so.

## Share a conversation with a link

Choose **Share link…** in a conversation's menu. **Preview** shows exactly what the link will show:

- **Private details are hidden from the shared copy for you.** Passwords and keys saved in Accounts, API keys and other
  token-like text become `[redacted]`, email addresses become `[email]`, and your home folder
  becomes `~`. Each finding is listed; **Show** puts one back and **Hide** hides it again. A text attachment that contains
  private details is left out unless you keep it.
- **Leave out** removes a message from the link.
- **The agent's reasoning** is left out unless you turn it on.
- **Who can open it:** anyone with the link, only people you name (they sign in with that email), or
  only you. You can also set an expiry date.
- **Encrypted** is on by default: the link ends with `#` and a key, and that part never reaches
  Scient's servers. Anyone with the complete link can open it, if **Who can open it** allows them. An unencrypted link can show a
  title preview when pasted into chat apps, and you can let search engines list it.

**Create link** gives you the link to copy. The link shows a copy frozen at that moment. To share new
messages, choose **Share link…** again (or **Update** in Settings > Sharing & access > Shared links)
and **Update link**; people with the link see the new version at the same address. **Stop sharing**
deletes the shared copy at once.

The key of an encrypted link is kept on the computer that made it. Another computer can still stop
sharing, change access or update the link, but updating there makes a new key, so you send the new
link again.

People who open the link see the conversation with math, charts, diagrams and code, and can save it
as Markdown or PDF. **Continue in Scient** saves a file that Scient opens as the reader's own new
conversation (Import conversation in the sidebar). A
**Report it** link lets readers flag a link that breaks the rules.

## Continue on another computer

A conversation runs on one computer at a time. To pick it up on another of your computers:

1. Turn on sync on the computer you are moving from.
2. On the computer you are moving to, open the conversation in **Cloud conversations** and choose
   **Continue on this computer**. If sync is off there, the button becomes **Turn on sync and
   continue**: continuing needs it on both computers so the conversation can move back later.

Scient finds the same project on this computer by its Git remote (and the folder inside the
repository). If it can't tell which project, it asks. The conversation continues as a new
conversation here, marked **Continued from** the other computer, with its history given to the agent
as context. Like every imported conversation, it starts in Supervised mode.

The first computer then shows **Continued on** this computer and stops accepting new messages in that
conversation, so the two never run side by side. **Take it back** there continues the latest synced version on
the first computer the same way.

Files do not move. Commit and push your work before switching, and pull on the computer you move to.
If the first computer was offline when you continued, it learns about the move when it comes back;
anything it ran in the meantime stays in its own conversation, like a fork.

## Platforms

Sync, sharing and continuing work the same way on macOS, Windows and Linux, and the reader
works in any current browser, including on phones.
