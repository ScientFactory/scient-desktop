# Import projects and conversations

Open **Import projects and conversations** directly under **Settings → Getting Started**,
or choose it on the final **Start working** step of onboarding. It is optional: **Add project**
continues to work as before. Import checks the primary machine only after you open it.

Scient finds directories that Claude Code or Codex has used. The default
selection includes projects active within the last 30 days. Select **Choose**
to include older projects or change the selection.

A large or malformed history can reach the scan limit. Scient keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Codex and Claude conversations active within the last
30 days. You can continue those conversations in Scient.

Conversation import is best effort. Scient keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so Scient does not remove user text. It reads one conversation at
a time and skips files larger than 16 MiB. It ignores malformed records and skips
unreadable or unparseable conversations.

Each import attempt reads up to 100 conversation files and 64 MiB per project,
with up to 100,000 input records. Run import again to continue a large batch.
Completed conversations are not imported again. You can continue without the
remaining history.

Closing or skipping import leaves your setup unchanged. During import, wait for it to finish
before closing. If some history fails, retry or continue without the rest; completed conversations
are not duplicated. A read-only connection cannot start an import.

## Hosted connections

When a hosted client has no connected machine, it first offers the upstream connection flow:
connect an existing server by pairing, or use the account-based connection option when available.
Account-based cloud features depend on the deployment's configuration; this alignment does not
enable them. Agent checks and import in that flow target the connected machine.

An unreachable hosted environment or unreadable saved settings offers recovery instead of
replacing saved settings with defaults.
