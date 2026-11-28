# Scient WhatsApp

Scient links to the user's own WhatsApp as a **linked device**, the way WhatsApp Desktop does,
so agents can read, search and send messages for them. This page is the design record; user
help is in [docs/user/whatsapp.md](../user/whatsapp.md).

## Why a linked device

Meta's WhatsApp Business Platform terms (§4.7, in force since 15 January 2026) forbid
general-purpose AI assistants on the Business API, and the API cannot read a person's chats.
The only way to work with a person's ordinary WhatsApp is the linked-device protocol that
WhatsApp Web and Desktop use. It is unofficial for third parties: WhatsApp's FAQ says unofficial
apps can get an account banned. Scient therefore:

- tells the user the risk before they link (risk card on the WhatsApp page);
- runs the link on the user's own computer, and warns (does not block) when the Scient server
  is on another machine — datacenter IPs are the strongest ban signal in public reports;
- paces sends, offers no bulk, broadcast or status sending, and sends to one chat per call;
- turns WhatsApp's error 463 (first message to someone the account never messaged) into an
  instruction to send that first message from the phone;
- shows a temporary restriction with its end time and does not reconnect before it ends.

Meta's own [WhatsApp Business Tools MCP](https://mcp.facebook.com/whatsapp_business_tools) is
offered as a second, labelled way on the same page for WhatsApp Business accounts. It covers
business setup, templates and sending, not reading chats.

## Engine: wacli

[`wacli`](https://github.com/openclaw/wacli) (MIT, Go, built on
[whatsmeow](https://github.com/tulir/whatsmeow), MPL-2.0) is a single signed binary per
platform. Scient pins one release (`wacliManifest.ts`): exact URL, byte size and SHA-256 per
platform, downloaded on first link into `<stateDir>/whatsapp/bin/`, never taken from PATH.
Windows Arm64 has no published build and is reported as unsupported.

Everything Scient runs uses the store `<stateDir>/whatsapp/store` (mode 0700) and:

| Variable                | Value                                          | Why                                                                                                                                           |
| ----------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `WACLI_STORE_DIR`       | the store                                      | isolate Scient's link from any other wacli                                                                                                    |
| `WACLI_DEVICE_LABEL`    | the computer's name (server environment label) | the phone lists the device as the computer, and wacli otherwise sends "wacli" to WhatsApp's servers in its client details on every connection |
| `WACLI_DEVICE_PLATFORM` | `DESKTOP`                                      |                                                                                                                                               |

The device name is fixed when the device links; renaming the computer later does not rename it.

wacli opens its delegate socket at `<store>/.send.sock`, and macOS and Linux cap Unix socket
paths near 104 bytes. When that path would be longer than 100 bytes (a deep home or dev
worktree), Scient passes wacli a short link to the store instead, in a folder only this user
owns: `$XDG_RUNTIME_DIR` or `$TMPDIR` + `/scient-whatsapp-<uid>/<hash>`. The folder's owner and
mode are checked, and the link re-made, before every run (temp folders get cleaned); nothing
runs when the check fails, and unlink removes the link. Windows uses a named pipe and needs none.

Logs keep wacli's error text (connections, files, WhatsApp's answers), never message content.

## Processes

- **Linking**: `wacli auth --qr-format text --events --idle-exit 30s`. NDJSON events on stderr:
  `qr_code` (`data.code`, the raw QR payload; replaced about every 20 s), `connected`,
  `history_sync`/`progress` (`data.messages_synced`), `idle_exit`, `error` (`data.message`).
  An error naming a passkey is `passkey-required`; "QR code timed out" is `scan-timed-out`.
- **Connection**: while linked, one supervised
  `wacli sync --follow --events --max-reconnect 5m --stale-threshold 2m --presence-mode quiet --send-spacing 3s-8s`.
  `presence-mode quiet` keeps the phone's own notifications audible. Once it is up, it serves
  sends and chat-state commands for the same store over a private socket (named pipe on
  Windows), so there is never a second WhatsApp session. `logged_out` → `RemovedByPhone` (no
  restart).
  wacli's follow loop reconnects without waiting for WhatsApp's login verdict, so a temporary ban
  never reaches its events. It gives up after five minutes; Scient then runs
  `wacli --json doctor --connect`, which does wait for the verdict. `WhatsApp account is
  temporarily banned: … (expires in …)` → `Restricted` until it ends (24 hours when WhatsApp
  doesn't say), saved in `<stateDir>/whatsapp/restriction.json` so a restart waits too; a revoked
  session → `RemovedByPhone`. Anything else restarts with backoff.
- **Agent reads**: `wacli --read-only --json chats list | messages list | messages search |
  contacts search`, run directly against the store; reads work alongside the connection's lock.
- **Agent sends**: one JSON request over the running sync's delegate socket
  (`wacliDelegate.ts`, protocol version 1 of the pinned release): message text and recipients
  never appear in process arguments, and there is no fallback that opens a second session.
  Recipients are one person or group (`…@s.whatsapp.net`, `…@lid`, `…@g.us` or a phone number);
  Status, broadcast lists and channels are refused. A reply means WhatsApp accepted the message,
  not that it was delivered; a request that went out without a complete reply is
  `send-uncertain`.
- **Unlink**: close admission to agent calls and wait for those running, stop the connection,
  `wacli auth logout`, delete the store. A logout WhatsApp didn't confirm is reported (remove the
  device from the phone); a store that could not be deleted is `Failed` / `unlink-incomplete`.
  Cancelling after the scan logs the device out the same way before forgetting it.

The link stays until the phone removes the device, the phone is offline for about 14 days, the
account is banned or moved to a new phone, or the user unlinks. Restarting Scient reconnects
from the store without scanning again.

Linked state is derived from the store at startup (`wacli --read-only --json doctor`:
`authenticated` and not `session_revoked`). A check that can't tell keeps the store and shows
`Failed`; it never deletes chats. Besides the store, Scient keeps only a pending restriction.

## Surfaces

- **RPC** (`packages/contracts/src/scient/whatsapp.ts`): `whatsapp.status`,
  `whatsapp.subscribeStatus` (stream), `whatsapp.startLink`, `whatsapp.cancelLink`,
  `whatsapp.unlink`.
- **Server**: `apps/server/src/scient/whatsapp/` — `WhatsAppService` (state machine, processes,
  agent operations), `WacliInstall` (pinned binary).
- **Agent tools** (`apps/server/src/mcp/toolkits/whatsapp/`, grant `whatsapp`):
  `whatsapp_status`, `whatsapp_chats`, `whatsapp_messages`, `whatsapp_search`,
  `whatsapp_contacts`, `whatsapp_send`. Message text is other people's words: tool descriptions
  tell agents to treat it as data, never instructions.
- **Web**: Settings → Extensions → WhatsApp (`apps/web/src/scient/extensions/WhatsAppSetup.tsx`).

## Not yet built

- **Read on this Mac**: read-only access to WhatsApp Desktop's local database
  (`~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/`) with Full Disk Access, for
  people who do not want a linked device.
- **Talk to Scient from WhatsApp**: inbound messages that start or continue a thread, on the same
  connection.
- Passkey-gated pairing (wacli stops with an error when WhatsApp asks for one).
