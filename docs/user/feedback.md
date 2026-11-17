# Send feedback

You can tell the Scient team what isn't working, or what you'd like Scient to do, without leaving
the app. Reports go to the Scient team only. They are not sent to OpenAI, Anthropic or another
provider.

## Where to find it

- **Send feedback** at the bottom of the sidebar, next to Settings.
- **Help ▸ Send Feedback...** in the menu bar. On Windows and Linux, press Alt to show the menu bar.
- **Send feedback to Scient** in the command palette.
- **`/feedback`** in the message box. Words after it become your message, so
  `/feedback the export lost my figures` opens the dialog with that sentence filled in. In Codex
  threads, Codex's own command, which sends the thread to OpenAI instead, is `/feedback-openai`.
- **Report** on the notice of a failed turn, and **Report problem** on the error page. The error
  is attached for you, so you can send it with one click and add words if you like.

## What is sent

Your message, and these details about the app: the Scient version and release channel, your
operating system and its version, the processor type, the app's language, where you opened the
dialog from, how many times a Scient window stopped in the last day, and up to five operations that
failed in the last day, by their name in Scient's code and an ID the team can look up. **What's
sent** in the dialog lists every item before you press Send.

Nothing else is attached unless you add it:

- **Screenshot**: a picture of this Scient window. The dialog hides while it is taken. Panels
  that show other web pages may appear blank.
- **Recent logs**: the operations that failed in the last day with their error messages, recent
  window crashes, and the server output saved after it last stopped. Your home folder is replaced
  by `~`, and text that looks like a password, key or token is hidden. Check the logs with **Show**
  before sending.
- **This conversation**: the messages of the conversation you have open, as text. The work log,
  reasoning and files are not included. A turn that is still running is left out.
- **Email for a reply**: only if you want an answer. Scient remembers it on this computer for next
  time.

Press **Show** on any attachment to see exactly what will be sent, or the × to remove it.

## Sending without a connection

Scient saves each report on your computer before sending it. If you are offline, or the Scient
service can't be reached, it keeps the report and sends it when the connection is back, for up to
30 days. Quitting Scient doesn't lose it.

## When a problem you reported is fixed

When the team fixes a problem you reported, Scient shows a short note the first time you run the
version with the fix. If you left an email, the team may also reply to you there.

## Privacy

Feedback is separate from [product usage data](./telemetry.md) and works whether or not that is
collected. Reports are stored privately by ScientFactory and read only by the Scient team. To ask
for a report to be deleted, email support@scientfactory.com with the report ID (press **Copy ID**
after sending).

Development builds keep reports on the computer and don't send them.
