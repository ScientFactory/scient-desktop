# Scient Accounts

Connect something once, and every agent can use it the way the user allows. Accounts covers website
sign-ins, university access, API keys, databases, command-line logins and browser profiles. It owns
Scient's encrypted store and the links to values kept in the system keychain, 1Password, Bitwarden (including Vaultwarden), Proton Pass or Custom
models. Settings → Accounts & secrets is its page ([user guide](../user/accounts.md)); agents use it through `scient_account*` tools.

Code: `apps/server/src/scient/accounts`, `apps/web/src/scient/accounts`,
`apps/desktop/src/scient/accounts`, contracts in `packages/contracts/src/scient/accounts.ts`,
`accountRpcs.ts`, `desktopAccountsBridge.ts` and `secrets.ts`. Every upstream integration point is
listed in `scient-accounts-seams.json`; `pnpm accounts:seams:check` verifies it.

## Invariants

The rules every change here keeps. The sections below explain each one.

- **Main has one writer.** Scient changes Main's cookies only in the desktop's `mainFill.ts`,
  under one lock per environment: copies, imports through a staging partition, and Accounts'
  Sign out on Main. A page writing during a copy always wins (`busy`). Scient's background work
  (Main fill, Google sessions, keep-signed-in, delivery) runs in one window, the one that owns
  Accounts (`accountsOwner`).
- **Lock order.** Outer locks come first, then the profile's browser context, then the Accounts
  write lock. The outer locks are the sign-in attempt lock (`SignInAttempts.exclusive`, per real
  site and identity) and the receiver's lock (`RemoteSessions`: bind, receive, withdraw, sweep).
  The profile's browser context is a `ServerBrowserContexts` lease, or the desktop's Main lock.
  The Accounts write lock (`writes`) is short and uninterruptible, and is never held across
  browser work. No code takes an outer lock while holding an inner one.
- **Withdraw only what we wrote.** A Main copy is taken back only while Main's unit still holds
  that exact copy (`withdrawCopies`, by digest). A receiver deletes a sender's unit only while the
  sender owns it, by having written it (a `same` keeps an earlier claim on exactly the same sites and
  digest, and never makes, widens or refreshes one; another sender's write ends it, and a
  take-back that finds nothing of its own answers `kept`, ending nobody's), and the unit still holds exactly the sender's copy. A unit missing from a jar is never deleted for its
  absence, and a cookie a site wrote since stays.
- **Copies follow user actions.** Copies into Main and to other computers come from these
  triggers only: a newer `signed-in` action (`by: "action"`), an import or Refresh, Send again,
  the one-time back-fill, or a profile becoming shareable. A look never copies. Revisions decide
  order, never clocks.
- **One attempt per real site.** Every sign-in goes through `guardedSignIn`, which runs one
  attempt per real site and username at a time. A stop lifts by itself (`signInHeld`): a failure
  after 30 minutes, then a day after each later one (`signIn.failures`); a limit after its hour;
  `needs-you` once a caller is attended. A refusal of what's saved waits for a new value. An
  automatic caller never retries past a stop; the user's own press always runs.
- **The secret boundary.** Passwords, 2FA keys and API keys are decrypted only in the server, and
  only when the account's controls allow it. They never go to another computer.
  - Cookie values cross the desktop bridge only for a copy or a delivery, and travel as
    `Redacted`.
  - No RPC result, snapshot, log or agent result carries a cookie value, a sender key or a
    sign-in code. Snapshots strip the send log's units and the copies' digests.

## Model

An account (`AccountSummary`) has a kind, kind details (`AccountDetails`), secret fields and four
controls:

- **Access**: `off`, `ask` or `allowed`. Allowed never prompts, including scheduled runs. Everything
  the user adds starts Allowed: agents should work with as few interruptions as possible, and the
  user narrows access only where they want to.
- **Permission**: `read-only` or `full`. Enforced only where Scient performs or configures the use:
  brokered requests allow only `GET`/`HEAD` when read-only, and database files set
  `default_transaction_read_only=on`. Website sign-ins cannot be limited, so the page hides it for
  them.
- **Visibility**: `hidden` or `readable`. A readable value may be written to a per-session file for
  the agent's own scripts. Websites and libraries start hidden; API keys, databases and
  command-line logins start readable because agents run them in scripts. Hidden means the value
  is never exported; a sign-in on a page an agent controls still puts the password into that page,
  where the agent's scripts can read it. That is why agent tabs autofill only sign-ins the agent
  may use.
- **Scope**: `GrantScope`, shared with Extensions. A session gets all-projects grants plus those
  listing its project, checked again on every use. Subagents, forks and scheduled runs in the
  project get the same grants.

Account controls govern stored credentials; profile controls govern the sessions in a browser
profile. A website account turned Off stops agents using its password, but an Allowed profile still
opens pages where that profile is already signed in, and its script sign-ins export those cookies.
The global agent-access switch turns every account and profile off for agents without changing
their settings. Grants and controls come only from the user's client, never from an agent or a
project file.

Secret fields per kind are fixed (`ACCOUNT_SECRET_FIELDS`); a command-line login's secret fields
are its secret variable names. Each field has a source:

| Source         | Where the value lives                                                                                   | Read                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `scient`       | Scient's encrypted store                                                                                | Decrypted in the server when used                                                               |
| `keychain`     | An existing macOS Keychain, Windows Credential Manager or Linux Secret Service item (service + account) | `@napi-rs/keyring`, when used                                                                   |
| `1password`    | An `op://` reference                                                                                    | `@1password/sdk`, cached per account for five minutes except OTP references and OTP/TOTP fields |
| `bitwarden`    | CLI identity, item ID and field                                                                         | User-installed `bw`; current TOTP through `get totp`, no cache                                  |
| `proton-pass`  | CLI identity, share/item IDs and field                                                                  | User-installed `pass-cli`; stable `pass://` reference, no cache                                 |
| `custom-model` | A Custom models connection's key                                                                        | Custom models' own resolver; stored once                                                        |

A field has one read source and optional copies in other stores. Links are read when needed. On macOS the user approves Scient once
per keychain item ("Always Allow"). On Windows and Linux any program running as the user can read
keychain items. Apple Passwords / iCloud Keychain items are not readable by other apps; their
export file is the way in. Password imports retain the full hostname and update only an exact
site-and-username match; sibling subdomains remain separate accounts. A new import takes the
controls of an account whose site covers it with the same username, so it is never more open.

### CLI password stores

Bitwarden and Proton Pass are read-only links through the user's installed `bw` and
`pass-cli` binaries. Scient discovers PATH, Homebrew, `/usr/local/bin`, `~/.local/bin`
and `~/.npm-global/bin`; it never bundles or imports either CLI. Install and log in on
**the server host**, which may differ from the desktop running the Accounts page.
Password stores → Manage shows CLI status; Connect authorizes that CLI identity for
this server lifetime. Refresh status checks again. Disconnect drops Scient's session
and connection; it does not log out the CLI or existing website sessions.

For Bitwarden, run `bw login` in a terminal first. Configure Vaultwarden with
`bw config server <URL>` before login. Unlock in Accounts with the private master
password input. A terminal unlock does not transfer its session into Scient; inherited
`BW_SESSION` is deliberately ignored. Scient sends the master password only in that unlock child's
environment (`bw unlock --passwordenv SCIENT_BW_PASSWORD --raw`), clears the input
after submission, and keeps the returned session only in `Redacted` memory. Quit,
disconnect and failed unlock drop it. No master password or session key is persisted.

For Proton Pass, run `pass-cli login` and, when configured, `pass-cli session unlock`
in the terminal, then Connect. `info --output json` verifies session availability;
CLI errors are reported as unavailable rather than guessing whether authentication,
locking, networking or a changed CLI interface caused the failure.

Use an existing value → Bitwarden item / Proton Pass item searches item names,
then links a field. Bitwarden supports username, password, fresh TOTP and custom
fields; Proton uses stable share/item IDs in `pass://` references, with an editable
field name for custom or section-qualified fields. Discovery returns metadata only.
Proton lists up to 50 accessible vaults; both pickers show up to 100 matches. Refine
the search for larger collections. Proton's field choices are common names; field
existence is checked at use time. No values are returned by discovery RPCs.

Every use rechecks the connected CLI identity and resolves the selected field again;
there is no secret or OTP cache and no fallback. Bitwarden identity includes its
server URL and user ID. Proton identity includes the user ID, email and token label
when supplied by the CLI. Reconnect after server restart. Existing links fail closed
if the CLI account/server changes. Neither store is offered as a copy destination;
linking drops prior copy intents, and entering a new raw value replaces the link.

Child processes use explicit argv without a shell, closed stdin, a 15-second timeout
per command, an 8 MiB output cap, cancellation, and a restricted environment. Raw
stdout/stderr and process errors never enter Accounts activity, logs or public errors.
The command protocol lives in `CliPasswordStores.ts`. Proton's interface is based on
its [official command documentation](https://protonpass.github.io/pass-cli/commands/item/)
and JSON structures in its official source; authenticated and cross-platform CLI
interoperability still requires qualification with the user's installed versions.

### Copies and password comparison

A raw-value save can select several stores through `saveTo`. Scient is the default source. If only
external stores are selected and all writes succeed, the first is the read source; otherwise the new
value stays in Scient. Updates write the source and every existing copy, plus newly selected stores.
The encrypted value and copy intents commit before external writes; failed copies leave the Scient
value readable, mark the account for attention, and retry on its next value update. Removing an
account or clearing a field leaves external items in place. Legacy `scient` inputs without store
selection still replace a sole linked source; accounts with copies keep propagation on every update.

Keychain copies are generic-password items with service `Scient: <site>` and account equal to the
sign-in username followed by the stable account id in parentheses, preventing collisions between
accounts. Existing copies retain their stored service and account identity. Other fields have a field suffix on the service. 1Password copies are Login items
created with the SDK in the selected vault. Connected vaults are offered without a write probe.
A permission rejection produces one short error naming the vault and remembers it as read-only in
this connection's encrypted metadata, including across restart; reconnect resets that observation.
A transport failure does not classify a vault as read-only. A stable account-and-field tag lets
1Password reuse an item after an interrupted local commit. External writes are not atomic together.

### One login, several copies

Rows are grouped, never merged (`@t3tools/shared/scientLoginIdentity`): website rows with a
password, no institution and not a session row are one login when they share a site key (the
`https://` origin; a bare host is its own origin, the default port dropped), the tenant (the
saved `loginUrl` path, exactly; no path is `/`) and the username (exact; emails and `DOMAIN\user` names without case). Saved passwords shows one row
per login; access chosen there is written to each copy. Saving a new password or 2FA key on an
existing row through `accounts.save` or `keepTyped` writes it to every other copy whose field is
Scient's own (`updateCopies`), through the same `save`, so each copy's keychain and 1Password copies
update as usual; a copy linked to another store is left and named in the warnings. Imports and new
rows never propagate. Each website row keeps the password it replaced (`StoredAccount.previous`,
`secrets.password.previousAt`) and every password it held (`passwordHistory`, kept in the same
write as each new one), without bound: nothing evicts a version on its own. One leaves only by
the person's Remove in the login's details (`accounts.passwordVersions.remove`, settings-write
like removing a login; Undo by `accounts.passwordVersions.restore` for the hour, kept in
`removedVersions` and listed per login as `secrets.password.removedVersions`, each with its own
Undo, only to the login as it was), or with the login's clear or removal. Saving a
value the login already keeps (its password, Previous or history) reuses that value's ref, on
every path (repeat saves, copies, Undo, linked stores): never a second copy. A sign-in's result
only orders the history (proven first, refused last), proof coming only from a fill's attempt
and its own request's answer; a sign-in with an earlier kept password matches it (`same`).
Editing the login's identity (sites, tenant, username) takes its Previous, proof and per-version
automatic sign-in off it; the versions stay under the identity they were saved for. Each row
counts every write of each field (`StoredAccount.revisions`; a save counts even the same value
again). A password Undo applies only while the row is still at the write it made and the login
it was before the save, and never to an earlier password the person removed since; undoing a
later receipt makes the one before it current again (`beforeRevision`). A removed version saved
again comes back under its own ref and its removal ends. Clearing the password clears it;
removing the row keeps it for the removal's Undo. The snapshot lists the versions saved for the
login as it is now (`secrets.password.history`) by opaque id for Show, Copy, Use this one and
Remove (`accounts.reveal` with `version`, `accounts.usePassword`, which saves the version as the
person's own Scient password, mirrors included, reusing its stored value). A copy to the
Keychain or 1Password settled later merges only its `source` and `copies` onto the row as it is
then, each field only while its own revision stands (`fresh`): never a ref nor a Previous. A new
password's site answer applies only over the same write of the login's (and each copy's)
password as at the fill (`baseRevision`, `CopyRefs.revision`). Clearing a login's password ends
its removed versions' Undo. One code deletes stored values and escrows: the sweep
(`sweepUnreferenced`, the only `persistence.remove` and `removeEscrow` call). Every other
path journals: each `commit` adds to `unreferenced` every value name the state named before and
no longer names, and takes off the journal every name it names again; a row past its removal's
hour is journaled before the removed list drops it. A new value is journaled on disk before it
is written (`stageValue`, pending, sealed cookies and tokens included; a bulk import reserves
STAGE_RESERVE names on disk at a time before its one write), so a failed write leaks only until
the next sweep. At start, every value a stored record (or an entry within one) that didn't read
names is kept for good in `unreadable` (`storedRecords`, by record, whatever else names it), and
so is every value a record that reads names in its stored form but not as read (a field this
build doesn't know, as after a downgrade), each list's records and the removed list's alike,
with the record's login; as is any value a raw list names that the same list, decoded, doesn't;
until the person removes that login. All before the state is rewritten. A hold is keyed by list,
login and value (or escrow): one kept for another login never
stands in, and a value stays while any login's hold remains. An older build's held targets, which
their fold discards, are held each on its own, with the target's own login. A Custom models escrow
record that didn't read holds its escrow by name (`escrow`), with or without a token; one naming
neither still leaves a nameless hold. Nothing is swept that run. Escrows go the same way as
values: one is journaled by name with its provenance (`escrowJournal`, `decoded-row`) only by a
write that read the record naming it and drops it, unless a row or a hold still names it, and
the sweep is their one deleter too. Names an earlier build journaled (`unreferencedEscrows`), and
any `escrowJournal` entry that doesn't read (no or an unknown provenance), are quarantined: named,
so never journaled nor swept, whatever a valid entry says. Every list of the state, the journals
included, is read record by record
(`READABLE_LISTS`; `readableLists.test` fails a list added without it), and so is the removed
list (`readRemovedAccounts`): one that doesn't read drops alone, its values held. There is no
orphan pass: an escrow file no record names stays on disk (a leak, never a loss). No escrow is
deleted while an escrow hold lacks its name. The sweep, at
start and each minute, never deletes a value a row, removal, receipt, pending or unreadable
record names, takes up to 50 of each kind a pass under one permit hold, and moves one still
named or whose deletion failed to the end. Every timer reads what it changes (the removed list,
receipts, the journal) under the permit. Each write journals what its final state lets go, after
pruning expired escrows. A settlement's status comes from the copies the row waits on, the copy
failures of fields still this save's, and any failure a later write recorded. Key refusals of a
value the login no longer holds are pruned in the write that rotates it. A pending site answer
pinned without a revision (an older build) goes to the person. The secret store reclaims each
write's temporary file older than ten minutes, never one of a write still running, at start and
again each minute.
An import or a save offer that names another page of the same site and
username updates a row only when it is the only candidate and one side names no tenant (the row
has no saved address, or the entry is the site's root); two saved paths are two tenants, whatever
their passwords. A tie between tenants goes to the person or agent to choose, a new capture with a
new choice; agent Add's row without a password must also have the address the agent gave.
`accounts.reveal` returns the current, previous or an earlier password for the person's Show and
Copy, recorded as a `credentials` activity line. Removing a login remembers it (`removedLogins`, see
Import below). A marker for a row with no saved address covers every page, except a tenant still
saved with that exact address. An import matches
by that identity, an exact address first, and writes a new row with its port; a refresh skips an
entry two logins could be, and within one import a second address for the same login makes
another row. "Don't ask for this site" is kept in Accounts
(`accounts.neverAsk`), each browser sending its old local list once.

A refused password tries one copy of the same login, under the same attempt lock, that the
caller may type without asking and whose password differs (`AccountsService.takeFallback`: one
fallback per login a day, kept in Accounts state, shared with university and staying). A refusal
is kept on the password itself (`secrets.password.refusedAt`), bound to the value typed
(`passwordVersion`): one for a value saved anew meanwhile is dropped, a hand sign-in leaves it,
and only a sign-in where Scient types the value clears it. It holds automatic sign-in. A person's hand-off on a sign-in that typed no saved password offers Use saved,
which types it through the same attempt (`accounts.handoffs.useSaved`). In the person's own tab,
`accounts.fillValues` grants a submit by itself (`autoSubmit`), counted once in the same write
(`autoSubmits`): never with a failed, limited or unsettled sign-in on the site's registrable
domain in the past hour, as observed (`signInFailures`); a late result counts on the site its
fill was typed on, even after the login was edited or removed. A refusal never brings another
submit by itself: the returning form (a new document, or the same one drawn again, which waits
for the result; a redraw with fresh boxes is reported again) is filled for the person to submit,
no submit even requested; in the same document, over a filled box only where Scient's own refused
typing is left untouched (`passwordExpected`), a fresh empty box as usual.

`accounts.matchSignIn` requires settings-write permission. It resolves candidate passwords and
compares fixed-length SHA-256 digests with `timingSafeEqual`, returning only `new`,
`password-changed` or `same` and the matching account id. Optional `profileId` separates accounts
with the same origin and username in different profiles.

### Browser profiles

Profiles are upstream T3 (`browserProfile.ts`, client settings `browserProfiles`). Scient keeps a
server-side `BrowserProfileRecord` per profile id: access, scope, `scriptSignIn`, and the picture,
colour, source browser, source profile name, folder and email from import. A profile without a record is
Allowed for all projects with script sign-ins on, which matches upstream behaviour where agents
reach every profile.

Each time Accounts opens, linked profiles take the source browser's current picture, colour, name
and email, found by folder (older links: by unique name and email). That needs neither quitting the
browser nor the Keychain. A Scient profile still named after its source follows a rename there; a
name chosen in Scient stays, and its row shows the source after it ("Lab · Chrome · Yaacov"). A picture that can't be read keeps the one shown. The manual refresh
(the button beside Browser profiles, or Refresh in a profile's menu) also re-copies sign-ins, once
the browser is closed, and imports saved passwords; it reports a running browser instead of
skipping silently. It leaves sites that are working in that profile alone (`sitesToKeep`), and
Google once the profile has a Google row, because a copy stops working and would replace the
session and remembered device. An import writes the profile's record before its passwords, so an
interrupted import still leaves a complete profile. A profile made in Scient carries
`madeInScient`; one imported or made elsewhere can't be told apart, so none is ever folded away.

#### Windows Chromium through the browser

Chrome 127+ app-bound encryption keeps Windows Chrome and Edge cookie files (`v20`) from every
other app. Since Chrome 144 (Edge too) a person can allow outside connections to their running
browser: `chrome://inspect/#remote-debugging`, "Allow remote debugging for this browser instance",
an app-wide `Local State` preference (`devtools.remote_debugging.user-enabled`, the policy
`RemoteDebuggingAllowed` turns it off). The browser then listens on 127.0.0.1, writes
`DevToolsActivePort` in its user data folder, answers plain HTTP with 404 and asks "Allow remote
debugging?" for every WebSocket connection, naming no app and never remembering an answer; while a
connection is open it shows the "controlled by automated test software" banner. The Chrome 136
restriction on the default profile covers only the command-line debugging switches.

`windowsImportBlock.connection` (`Sources.ts`) marks Chrome and Edge. Their sources list profiles
from `Local State` alone, with `connection.settingsUrl`, while `unavailable` stays
`appBoundEncryption` (their files are never read, passwords included). An import of such a profile
(`browserConnectionImport.ts`, `browserConnection.ts`) refuses with `connectionOff` before opening
anything when the browser neither listens nor saved the switch on; otherwise it starts the installed
browser with `--profile-directory` and a `data:` page carrying a nonce (a running browser takes the
tab and the process exits), connects, finds that tab by its nonce and reads
`Network.getAllCookies` on it: the connection reaches only the last used profile directly, and
Network commands act on the tab's own context (verified on Chrome 157 with two profiles, HttpOnly
values included). The tab is closed and the cookies go through the import's usual writer. One
connection per browser serves every profile of an import, reads queue, and it closes 10 s after
the last one. A closed socket before it opens is the person's refusal (`connectionDeclined`); no
answer in three minutes is `connectionUnanswered`. The renderer polls
`accounts.browserConnection` (never asks the person) for the switch in `BrowserConnectStep`. Not
tested on Windows hardware, with Windows security software or under organisation policies.

Main is filled from the other profiles by one desktop writer, `fillMain`
(`apps/desktop/src/scient/accounts/mainFill.ts`), under a lock per environment. Each unit (a
registrable site, or every site of one multi-site sign-in) is one transaction in the shared
`applyUnit` (`@t3tools/shared/scientSessionCookies`): snapshot Main's unit, decide, write through
CDP on a blank script-free page (`sessionCookies.ts`), read the whole unit back, and on a failed
check restore the snapshot; a failed restore refuses the unit until restart. A cookie a page or
response writes into one of the unit's slots during the copy is newer than the copy: the unit is
left as the site made it (the site's cookie put back if the copy overwrote it) and reported `busy`,
which trigger 2 retries. Sign-ins that share a registrable site are merged into one unit first. Fill copies only into an empty unit. Replace needs Main's row signed out and
the insert tracker (`mainInserts.ts`, from `keepSessionCookies`) to vouch that nothing else wrote
the unit since; never on Google. Otherwise the result is a conflict, and the other identity stays
reachable. Copies follow a newer action only: an import or Refresh (`fillMainFromProfile`; an
import whose target is Main goes through an in-memory staging partition), a row in another
unrestricted profile recording a newer `signed-in` with `by: "action"` (`watchMainFill`, from the
Accounts snapshot stream; a look never copies), and
the one-time back-fill per environment and profile (`backfilled` on Main's record), whose first run
in the primary environment makes Main the new-tab default. `accounts.mainFilled` gives Main its row
as `unknown`, "Copied from …"; `accounts.profiles.signedOut` keeps Accounts' Sign out on Main in
`signedOutSites`, which imports and the back-fill skip, cleared only by a sign-in action in Main.
`scripts/qualify-session-copy.mjs` qualifies the CDP executor on each platform in a dev app.

### The same profiles on every computer

The desktop copies each shareable profile's sign-ins (persistent, Allowed or Ask for all projects,
scripts on) into the same profile on every other computer it is connected to, one way. No password
or 2FA key goes. Decisions use revisions, never clocks:

- **Send log.** Each desktop profile record keeps `send`: one counter, and the newest revision per
  unit, written in the commit that records the action (`sendLog.ts`, from `commit`): a newer sign-in
  action (`isNewerAction`, the one seam for item 4's `by: "action"`), Main's copy (`mainFilled`),
  Accounts' Sign out (`accounts.profiles.signedOut`, a delete), Main giving back a restricted
  profile's copy (`accounts.main.withdrawn`, a `copyOnly` delete: a remote removes only its copy
  as sent, by digest, and Main keeps no sign-out), an import or Send again
  (`accounts.profiles.resend`, the whole jar), and a profile turning restricted (`withdrawn`) or
  shareable again (the jar). Past 5,000 copies the log falls back to a jar revision; a deletion
  is never dropped until every computer in `sharedWith` applied it. Unlinking removes the computer
  from `sharedWith` (`accounts.profiles.unshared`); one linked again is reconciled in full: the jar
  goes whole and copies the jar no longer has are deleted. Clients see only `send.head`.
- **Delivery** (`deliverOnce` in `@t3tools/shared/scientSessionDelivery`, run by
  `apps/web/src/scient/accounts/remoteSessions.ts`) runs on the desktop, serially per remote,
  from durable state: `accounts.profiles.sendLog`, the jar through the bridge's `readSessions`
  (under item 3's Main lock), and the remote's `accounts.sessions.applied`. The pure
  `planDelivery` fills a remote that never received, withdraws a restricted profile, and otherwise
  sends units whose revision is newer than the remote applied. A unit gone from the jar is never
  deleted for its absence. Batches hold at most 100 units and 1,000 cookies, values `Redacted`.
  Before each batch the route (`allowedRoute`: SSH tunnel end, TLS, a Tailscale name, loopback, or
  this desktop's WSL backend at its topology's address; never a relay), the catalog entry, the
  settings permission and the remote's `accountsProtocol` are checked again; a change stops the run.
  The profile's controls are read again before every read and send; a change drops the batch and
  plans the profile again, which withdraws it if it is now restricted.
- **Receiver** (`apps/server/src/scient/accounts/remoteSessions.ts`): on its first
  `accounts.sessions.bind` a desktop gets a random key from the remote, which keeps only its hash;
  the desktop keeps the key encrypted with its Accounts. Every later call proves it, so a renewed or
  new session of the same desktop is the same sender, and any other connection is refused. Bind,
  receive, withdrawal and sweeps run under one lock, and revoked senders are swept before a bind.
  Under that lock it applies the sent controls (a project limit is
  Off), checks them and the university (`travels`) against its own rows, refuses a revision not
  newer than applied (`stale`) and a unit with an open tab (`busy`), then runs item 3's `applyUnit`
  through `ServerBrowser.profileCookies` (a context lease in `ServerBrowserContexts`, which tabs
  wait for and go before the next one; a cookie operation past 30 s is aborted by closing its
  helper page, its unit restored and reported busy, and the lease released; CDP Network
  commands on a helper page of the profile's own context). Only applied units are recorded in
  `received`. Unlink calls `accounts.sessions.withdraw({ all: true })` first, with a 5 s limit; the
  desktop drops its key only once that is confirmed, so a computer unlinked while offline is
  proven and reconciled when linked again. The session that bound a sender gets a new key if it
  lost the bind answer. On the remote, Forget this computer (`accounts.sessions.forget`) deletes the
  copies a sender wrote and its registration, so a reinstalled desktop can bind again. A unit a
  copy found already there (`same`, unclaimed) is the remote's own: only signing out there
  removes it. A
  remote drops a sender, and its copies, when the session it last proved its key over is revoked
  (it watches session removals) or after `SENDER_KEEP_DAYS` (30) days without it, checked at start
  and daily. Only units still holding exactly the sender's copy are deleted.
- **Never mid-sign-in.** A profile's unit that shares a site with a row whose sign-in attempt is
  under way isn't read or sent; it waits until the attempt ends.
- **Needs you.** A page on a received unit that asks to sign in marks it `needsYou`, and the agent's
  note asks for `scient_account_add` (attended) or to stop (unattended). A sign-out control there
  clears it.

`accounts.sessions.qualify` (development servers only, those started with a dev URL) runs item 3's cases on
a remote's browser; `qualify-session-copy.mjs --environment <id>` calls it.

Access is enforced in the server's preview tools: `preview_status` lists only the profiles the
session may use, and `preview_open` refuses an Off profile (or asks for an Ask one), including the
default profile when the agent names none (the built-in default if a cold browser has no default
inventory yet). Existing-tab actions recheck global access, profile Off
and project scope without prompting; Ask approval is decided at open. Status also omits denied tabs
and clears current-page metadata when the current tab is denied.
`scient_preview_list` omits the same tabs, by the same rule.
`scient_preview_close` refuses a tab in a profile the session may not see.

The server cannot enumerate profiles kept in a client's settings. `forSession(scope, profileIds)`
accepts the preview inventory's ids so profiles without records receive the same defaults; its
one-argument form includes built-in profiles and stored records.

`preview_open` checks HTTPS pages after `accountWaitForLoad` using the same detection and
classification as `scient_account_find_profile`. A new tab without an explicit profile can
switch to the first other Allowed profile that opens the URL, checking at most eight profiles.
The final open preserves the caller's show flags, rechecks the grant without prompting, and
closes the failed tab. Explicit profiles and existing tabs, including `preview_navigate`, receive
an `accountsNote` directing the agent to profile discovery instead. No matching profile yields
sign-in/settings guidance. Detection and discovery errors leave the normal preview status intact;
page text is never included in the note. The discovery tool still checks every eligible profile
up to its limit and returns its existing access labels, first match and skipped names.

### Browser password import

Import from a browser offers **Also import saved passwords (n)**, on by default, when a selected
profile is from a Chromium browser (Chrome, Edge, Brave, Vivaldi, Opera, Arc, Helium) on the local
desktop. The count comes from Login Data without decrypting anything.

- On Import, Electron main snapshots Login Data, decrypts it with the cookie importer's Safe Storage
  key (the macOS Keychain prompt appears here, not before) and returns CSV to the renderer, which
  sends it to `accountsImportPasswords` like a picked CSV file. Dedupe, controls and store writes
  are the CSV importer's. Each password stays linked to the profile it came from, and still fills
  in every profile.
- An import commits once: per-entry commits each rebuilt and published the whole snapshot (about
  3 s per password), and the uninterruptible write lock kept the server from quitting meanwhile.
  300 passwords now take about 3 s.
- Website passwords are listed under one **Saved passwords** row that opens a searchable list, so
  hundreds of imports don't push Browser profiles off the page. Each row shows the username.
- Rows without a bundled logo show the site's icon. Electron main (`siteIcons.ts`) reads the
  site's page, takes a declared PNG/SVG icon (else any icon, else `/favicon.ico`, then the parent
  domain's) and returns it as a data URI. Lookups use no cookies, go to public HTTPS hosts only
  (every redirect is checked), run four at a time with an 8 s limit per site, and are cached in
  `scient/site-icons.json`: found icons for 30 days, misses for a day. No third-party icon service
  is used, so the list of sites stays private. Without the desktop, the row tries the site's
  `favicon.ico` directly.
- Blacklisted, empty, Android and undecryptable rows are skipped and counted; unknown encryption
  versions fail closed. The snapshot is deleted on success or failure and key buffers are zeroed.
- Linux uses the cookie keys (v10, Secret Service v11); Windows only legacy v10. App-bound (v20)
  encryption is not bypassed.
- Safari and Firefox can't be read directly: export their passwords and use Accounts ▸ + ▸ Import
  passwords….
- An import patches a matched login and never erases: details stay (sites, institution and
  proxy), a different password replaces the current one only when both dates are known and the
  line's is newer, and a code only fills a login that has none (a line's date is its password's).
  A password typed in Scient has no date, so a refresh doesn't replace it. One identity decides what
  is the same login (`scientLoginIdentity`): the site's origin with its port (a bare host is its
  HTTPS origin), the username (emails and `DOMAIN\user` names without case) and the sign-in path as the tenant. Matched rows
  are read before the write permit; a row removed or changed meanwhile is left as it is, and copies
  to the Keychain or 1Password are written after it.
- A removed login is remembered (`removedLogins` in `accounts-state`, by the same identity, its
  tenant when it had a saved address, and its profile): a browser import or Refresh
  (`origin: "browser"`, `refresh: true`), imported sessions and Google's own refresh leave it out (a
  marker with no profile covers every profile); a file import that writes it, a new save or Undo
  forgets it. A new imported row takes its
  controls from this user's logins for the origin in this profile or in none, the most closed
  first, and keeps the exact origin if any of them does.

### Website session status

When Accounts opens, regains focus, receives account changes or completes a profile-site sign-out,
its desktop client reads cookie domains and expiry metadata using the same environment/profile
partition mapping as the signed-in-sites view. No cookie names or values leave the native handler.
The client supplies this observation to `accounts.snapshot`; the server records a website account
as `signed-out` (`endedWebsiteSessions`, through `recordCheck`) only when its sign-in state is
`signed-in`, or unknown after a previously observed live cookie, and only when a successful read
finds no unexpired cookies for any of its sites. A recorded account no longer qualifies, so repeated
snapshots write nothing, and cookies coming back don't sign it in again: the next look does. Session cookies
count as live; a cookie on a parent or child domain conservatively suppresses the label. Cookie
presence does not prove authentication. Failed reads, older desktops and browser-only clients show
no session status. There is no polling. Manual-session observations are isolated by renderer identity
and last for the server RPC handler's lifetime; after reconnect/restart, an unobserved manual session remains unknown until observed again.
These observations never grant access or change account controls.

Signed out rows offer Sign in again first in their menu. It opens the account's sign-in address
(or its first site) in the same account profile through the existing preview path and autofill.
Linked values offer Open in 1Password or, on macOS desktops, Open Keychain Access through the
existing external-link bridge. The bridge accepts only fixed store targets. `op://` references lack
the 1Password account identity needed for a reliable private item link, so Scient opens the app
without selecting an item. Keychain launch tries the current CoreServices location, the legacy
Utilities location, then Passwords. Keychain links resolve on every use; 1Password values use the
existing five-minute cache except one-time codes, which resolve every time. No manual refresh is
needed, but ordinary 1Password edits can take up to five minutes to appear.

## Storage

The store lives in the server, on the machine where agents run.

- A 32-byte master key sits in that machine's keychain via `@napi-rs/keyring` (service
  `Scient Accounts`, account derived from the server state directory, so development and installed
  profiles never share an item). A host with no usable keychain (headless Linux, WSL) keeps the key
  in an owner-only file in the secrets directory and reports `protection: "file"`.
- Every stored blob is AES-256-GCM with a fresh 12-byte nonce, and its record name is bound as
  additional authenticated data, so a blob cannot be swapped into another record. One master key
  with per-blob nonces is enough for this threat model; there is no key-per-record wrapping.
- Blobs are written through `ServerSecretStore` (owner-only files, atomic and durable replace):
  `accounts-state` (records, profiles and settings), `accounts-value-<id>` (one value each),
  `accounts-activity` (the last 500 uses) and `accounts-removed` (rows waiting for Undo). Everything is encrypted, including usernames and
  sites.
- A store whose key is missing or wrong fails closed with `AccountsError("unavailable")`; it is
  never silently reset. A versioned `accounts-vault` sentinel remembers the key location and
  authenticates it before any data is read; fallback keys use `accounts-master-key` through
  `ServerSecretStore`. Changing keychain availability never silently moves an established key.
- A service-account token is a separate encrypted value blob; connection settings retain only its
  random reference. Pending approvals belong to the requesting process and are removed on
  cancellation, timeout or restart. A failed metadata write retains the old value blobs and any new
  unreferenced blobs, because the durable outcome of a failed filesystem sync can be uncertain.
- **Remove keeps the row an hour** (`removedAccounts.ts`) in its own record, so a build without
  Undo never sees it in `accounts-state`. Remove refuses a version edited since the person saw it
  (`updatedAt`) and returns a receipt; `accounts.restore` (Accounts protocol 2) takes that receipt
  and puts the row back with its id. Holders refer to rows by id and Remove rewrites none of them,
  so they work again and anything edited since stays; a restore isn't read as a new sign-in. A
  timer ends each hour; an entry stays listed, past Undo, until all its values are deleted. A kept
  row's Custom models escrow stays until then. The rows one press removes (a university's) share
  the client's `operationId`, so Accounts' Removed line offers them as one item with one Undo.
- **External reads never hold the write permit.** The Keychain and 1Password can wait on their own
  prompt (two minutes, then a failure); Bitwarden and Proton Pass have their CLI's 15 s. `readOutside`
  reads a row's values without the permit and accepts them only if the row's sources and value names
  are unchanged afterwards (with the 1Password connection's generation), reading once more if not.
  Callers decide on that version under their last permit. Every agent use passes `authorizeUse`
  right before it acts: each request fetch and redirect, each field group, submit and code (when it
  goes in and again before its submit, which a refusal clears unsent) of an agent's sign-in, its
  Add sign-in, a page's or a paper a conversation asked for, each file written, each key an
  agent's Voice job sends, each request a bound connector sends, each Zotero and research key an
  agent's lookup sends (read again at every lookup), an agent's key Check, and each local
  connector's sign-in and session files. Each passes the row as it read it before the value
  (`since`; a bound connector reads it with `rowVersion`), so a key replaced during the read
  never goes out. It re-reads the row and requires Allowed (or Ask this conversation approved; work with no
  conversation, such as a Voice job, has none), a site that is the account's, a key that serves the
  use (`keyServesUse`), and no edit since the agent read the row other than to access or scope,
  which it checks live, so an approval never invalidates the use it approved (`unchangedSince`). A
  `linked` use is one the person set up (a connector, the Library's key): that link approves Ask,
  and Off, the global switch and the project's scope still refuse; a use with no project serves
  every project, so only a row for all of them passes. The person's own Get PDF and
  Library lookups don't pass it: agent controls never stop the person. Text
  generators are the person's own use, so agent Off doesn't stop them; their key is checked
  against the endpoint when it is read. Saves write their Keychain and 1Password
  copies after releasing the permit, one at a time per Keychain item and for all of 1Password (the
  adapter also queues every SDK write, across reconnects, until it settles, past a caller's time
  limit), skip a copy a
  later save superseded, and merge only the copied fields into the row as it is then. Connect installs its
  client only if no Connect or Disconnect settled meanwhile.

### Connector bindings

Extensions can use an API-key account through `AccountsService.resolveBound` and
`listBindable`. A validated `account:<accountId>:token` vault ref names only that
account's token; no key is copied into the connector store. The saved connector
record is the user's binding approval. Every upstream request resolves the current
source again and checks the account kind, sites, global Agent access and account
access. Bare domains and exact HTTPS origins use the existing Accounts site matcher.

A typed connector key is saved as an ordinary API-key row (Allowed) and bound. A connector can
move to another key in place (`ConnectorUpdateInput.credentialRef`), checked against the
connector first; its summary names the bound account. A connector the person must repair raises
one Needs you (`connector:<id>`, "Needs sign-in" or "Key missing"), cleared once it connects.

Adding a binding approves Ask access for that connector without an agent approval
card; subsequent connector calls never prompt. The binding delegates use under the
connector's project availability, while Account tools retain their own account
project grants. Either Off switch still refuses every use. Removing the account,
clearing its token, changing its kind or sites, or disabling access makes the
connector `needs-credential`; it never falls back to an owned value or OAuth.
Disconnecting a bound connector leaves the account intact. Successful resolutions
and denied access appear in Accounts activity without values.

Local connectors' keys use `resolveBound` with a `local-connector` consumer
(connector, key name, optional project): no site, and like plugin keys the account's
project scope is checked against the thread's project. The connector keeps only the
`account:<id>:token` ref; see
[local connectors](scient-extensions.md#local-connectors).

A local connector can also link a **website sign-in** for the site its manifest names
(`signIn`). Scient hands it that site's current cookies, never the password, re-checks the
sign-in's Off switches and scope on every exchange, and signs in again unattended (the
`connector` caller of `guardedSignIn`, at most once per 2 minutes) when the connector reports an
ended session; see [signed-in connectors](scient-extensions.md#signed-in-connectors).

Plugin keys use the same two calls with a `plugin-key` consumer (agent, plugin,
variable name, optional site and project). Without a site, `listBindable` offers
every API-key account and `resolveBound` skips the site match; it still checks
both Off switches and, unlike connectors, the account's project scope against the
consumer's project. Activity names the plugin, variable and agent.

### Existing secrets

- **Extensions connectors** (`connector-<uuid>`): Accounts provides the `ConnectorCredentialStore`
  implementation (`AccountsConnectorCredentials.ts`). It keeps the agreed port and names, encrypts envelopes, and reads a legacy
  plaintext envelope once, rewriting it encrypted. Extensions still owns connectors.
- **Custom models keys** (`custom-model-<id>`) are sealed by the Accounts encrypted store under
  their existing names. `AccountsSecretStore` preserves the `ServerSecretStore` interface and seals
  legacy plaintext on its first read. Only Custom models uses this port; its rotation, removal and
  process lifetime rules stay with Custom models. An API key account links to a connection
  (`custom-model` source), so the key is stored once.
- **`request_secret` values** (upstream, one use, 24 hours) stay one-time secrets, sealed at rest
  through `secretRequestStoreLayer`. Their salt stays plain, because it is read at startup and
  startup must not wait for the keychain.
  `scient_account_add` (kind `api-key`, the default) reuses upstream's card for keys worth keeping;
  kinds `website` and `university` run the person sign-in in the conversation's card instead. For a
  key it calls
  `OrchestratorMcpService.requestSecret` with a server-written label and a `scient-account:`
  `clientRequestId`, consumes the answer through `SecretRequests.consume`, and saves an API-key
  account (or replaces one key, keeping name, details and controls). An add is always a new row,
  whatever is saved for the service; only `accountId` replaces a key. A `value` the agent already
  has (given in the chat, or made by the agent) is saved with no card, Allowed by default. The
  result's `open` is a `scient-account://<environment>/<account>` Markdown link the chat opens in
  Accounts (`@t3tools/shared/scientAccountLinks`). Only the row named to replace can return
  `turned_off` (Off, and not turned on) or `linked`. Two marked
  upstream seams: the card's note and saved label (`client-runtime/src/secretRequest.ts`, via
  `@t3tools/shared/scientAccountSecretRequest`), and `request_secret` rejecting the reserved
  prefix. The orchestration sentence on secrets points to Accounts first (`ScientAgentCopy`).
- **Text generators** (upstream settings) name an Accounts key with the reference
  `{ provider: "scient-accounts", reference: <accountId> }` in their `apiKey` field; no value is
  copied. Upstream's `SecretResolver` isn't used for it: it sees only the reference, and the key
  must be checked against the generator's endpoint. `TextGenerators.connect` (one seam) asks
  `TextGeneratorKeys`, a port Accounts fills when it starts (`serveLayer`), because text generation
  is built below Accounts; both sides get one instance through the shared layer build. Each call
  reads the current value and checks the row is an API key that serves the generator's origin in
  its auth style (Bearer, or `x-api-key` for Anthropic), and is a key for all projects (a
  generator writes for every project). The check and the read are one locked step. Agent Off
  doesn't apply: the person chose this use. A row that no longer fits fails the call; it never
  falls back to another key. The model list isn't cached for Accounts references, and a kept
  typed key's list is keyed on its row's value. Driver errors never repeat the key the request
  sent, and carry the HTTP status so a 401 is recorded on the use. Accounts references are
  recognised only with an account-id reference, so a secret provider the person named
  `scient-accounts` keeps its `op://` references. The picker waits for
  Accounts protocol 2 (`ACCOUNTS_PROTOCOL_2`).
- **Keys kept for one use** (`privateTo` on an API-key row: a connector or a text generator).
  Typed connector and generator keys move into such rows once at start (`keepTypedConnectorKeys`,
  `keepTypedGeneratorKeys`), keeping the reach a typed key had: never listed, authorized,
  linked or bound elsewhere, and their own use gets them whatever the agent switches say. Older
  builds drop the field, so the rows are also saved Off and hidden. Which typed value each row
  was kept from is a digest in sealed state (`keptKeys`, `keptKeyState`), never in a snapshot.
  A record is rebound only while it still holds the same typed key. A kept row that is removed
  or unreadable fails its use: the typed copy older builds keep is never sent again, a restart
  never keeps it again, and a generator's typed value is cleared on each start until that lands.
  `isSharedKey` is the one test for keys other uses may bind; legacy `speechOnly` rows fail it
  too, though agents now list them by their controls.
- **Refusals** (`keyRefusals`, per use and per stored value): a provider's 401 marks the use; the
  key's own Key refused needs two uses refusing the same value; a success clears it; a new value
  starts clean. Connectors, Voice's test, text generators and agents' brokered
  requests report through `reportKeyUse`.
- **Same-value groups** (`sameKeys`): digests of sealed key values stay in the server process;
  the snapshot names only which rows hold the same key, and pickers show them as one entry
  after filtering for the use.
- **The Library's keys** live in Library settings (`scientSources.keys`), by lookup. The first
  use stores today's pick among keys not Off, only if nothing was chosen meanwhile (checked inside
  the settings write, `updateSettingsIf`); later keys never switch it. The person's own use
  ignores agent Off; agents use the chosen key only where its controls allow.
- **One origin rule** (`keyServesOrigin`): a key serves an origin listed exactly, or listed by its
  bare host when the origin is that host over `https://` on the default port. Custom models,
  Voice and text generators use it; brokered requests keep the site matcher.
- **Sensitive provider environment variables** (upstream settings) stay in upstream's store. Sealing
  them would make the server wait on the keychain at startup, and a denied or slow keychain must not
  stop every provider from starting. `keyLinks.ts` lets one follow an API-key account: providers read
  variables at start, so the value is copied in and copied again when the account changes.
  A provider serves every project, so the variable holds the key only while it reaches every project
  with agent access on, and never a key kept for another use; Off, Remove or a narrower scope empties it. The link keeps digests of what
  it wrote (`copies`, recorded before writing), and every write is one compare-and-set on that
  variable (`updateProviderVariable`): only the link's copy, an empty variable or (when the person
  links it) the value it held then is replaced, so a value typed there since stays, and a restart
  finishes a clear. Linking takes the replaced link's copy back and records the new link, owning
  nothing, before its key is read; ownership is recorded only while the variable still follows
  that account. Building the follower takes back unreached and retired links' copies before the
  server takes sessions (only when an agent's settings hold a key; no store is read). Off, Remove and agent access off
  take the copies back (`onAccessTaken`) before they commit, under a per-variable lock that also
  keeps a key read begun earlier from being written. Retired links (`detachedKeyLinks`) are cleared;
  a link made to a key that doesn't reach owns nothing. A running agent keeps what it started with.
  `accounts.keys.link` without an account keeps the variable's own key first: an API-key account
  already holding the same key under that variable name, else a new one, then links to it.
  Removing an agent deletes its settings, so `keptAgentKeys.ts` first keeps each key typed into
  them (sensitive variables and secret fields) as an API-key account with `keptFrom` (agent kind,
  setting), unless it is linked to an account (even one since deleted, which stays deleted) or the
  same key is already kept. It runs inside the settings write that removes the agent, before its
  secrets are deleted (`setRemovedAgentKeeper`); if keeping fails, the removal fails. Links of
  agents that no longer exist are dropped after each settings change commits, so a failed removal
  keeps them. Adding an agent of the same kind offers them back
  (`accounts.keys.restoreKept`); a restored variable then follows its account. Both run once per
  server, so a key changed in Accounts reaches linked variables whenever it changes. Cursor and
  Antigravity keep their sign-in per instance id, which re-adding under the same name reuses; a
  different name is a separate sign-in by design, so several accounts of one agent stay apart.
- **One-time cards** (`request_secret` without the Accounts prefix) say on answer that the value went
  to that agent only and isn't kept in Accounts. Agent copy sends API keys and tokens the user
  creates to `scient_account_add`, and `request_secret` only to codes used once (2FA, pairing) or
  tools that ask for a `secretRef`.
- **Plain files** (`plainKeys.ts`): the page lists secrets in project `.env` files and shell profiles
  by name. Keeping one copies it into an API-key account and leaves the file alone. The projects are
  the server's own (`ProjectStoreV2`); the RPC's `roots` are ignored and kept for older clients.
- **The API keys card** (`apiKeyRows` in the client) shows every key once, by name only: each API-key
  account with the variables linked to it and the Custom models connection it uses, then Custom
  models keys no account uses (kept: their store is Accounts'), agent variables not linked to an
  existing account, and plain-file keys by name that no account's `envName` matches.
- Server sign-in and session-signing material is never moved.

## Agent tools

Family `accounts`, capability `accounts`, granted to every provider session by
`prepareMcpSession`. Values never appear in tool output, thread items, logs, errors or exports.

| Tool                             | What it does                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scient_accounts_list`           | Accounts and profiles this session may use, Off model keys included: id, name, kind, sites, username (unless Off), access, readable, usage, status, sign-in state and reason, last worked, profile, held, whether a 2FA key is stored, backup codes left, password health (`leaked`, `reused`, `weak`) |
| `scient_account_sign_in`         | Signs in on the agent's tab (or a new tab in the account's profile): fills username, password and 2FA code across SSO steps                                                                                                                                                                            |
| `scient_account_fill`            | Types one saved field into the agent's own tab on a page of the account's sites; the agent handles the page, in any language. One password fill per account every 15 minutes                                                                                                                           |
| `scient_account_credentials`     | Readable accounts only: writes owner-only files for this session and returns their paths and how to use them                                                                                                                                                                                           |
| `scient_account_request`         | Brokered HTTP with a hidden API key, only to the account's sites; read-only allows `GET`/`HEAD`                                                                                                                                                                                                        |
| `scient_account_find_profile`    | Checks up to eight Allowed, in-scope non-incognito profiles in temporary background tabs; returns access labels and the first that opens, plus skipped names; never prompts                                                                                                                            |
| `scient_account_browser_session` | A profile's cookies for one site as a cookie-jar file, for scripts; needs `scriptSignIn`                                                                                                                                                                                                               |
| `scient_account_add`             | The private Accounts card: `api-key` saves a key; `website`/`university` with `secret` save a password or 2FA key on that login (replace by `accountId`); without `secret`, the person signs in in the conversation's card. Returns the id and usage                                                   |
| `scient_account_check`           | Read-only, as the agent, only what it may use now without asking (its profile included): a website in a hidden tab, never signing in, or a key against its service (`checkKey`: one read-only request where one is known, else the saved value); returns state, reason, last worked, profile, hold     |
| `scient_connector_setup`         | A local connector's missing setup: saves plain answers the agent asked in chat, asks for each missing key in `scient_account_add`'s card (or links a matching saved key) and restarts the connector; `replaceKeys` asks again for a rejected key                                                       |
| `scient_account_manage`          | One account by id: `get`, `activity`, `edit` (typed fields only, never a key's sites or destinations), `controls` (tighten only), `remove` and `undo`, `check_all` (looks only), `save_offer`; versioned writes, recorded as the agent's                                                               |
| `scient_browser_profiles`        | Profiles: `list`, `sites` (pages of 20, up to 50), `controls` (tighten only). Profile Remove, Clear, import and copy are not built (AMENDMENTS 56, stages B–D)                                                                                                                                         |
| `scient_paper_get`               | A paper's PDF by DOI or link into `papers/`: OpenAlex's published free copy, the publisher and each connected university in the browser, then a preprint                                                                                                                                               |

Every call runs `AccountsService.authorize`. Allowed proceeds; Ask shows the user a card ("Allow
in this conversation", "Always in this project", "Always"); an Off account an attended agent
needs in its project shows "Turn on for agents", "This conversation" (Ask, allowed there) and
"Not now". Every card, sign-in hand-offs included, closes within what is left of the calling
agent's time (`cardAllowance.ts`, one allowance per tool call), at most ten minutes; an
unanswered one, or an agent's sign-in left needing the person, becomes one Needs you entry
(`allow:<id>`, or the sign-in's own `sign-in:<id>`), which an allowed use clears. An Accounts
card's request id names its kind; how it ended (saved once Accounts committed, failed, declined,
cancelled or timed out) is kept in Accounts' state (`cards`, the last 500, so a restart keeps it) and shown from
the snapshot; `cardsSettling` lists the cards this process is still keeping, so an answered card in
neither list reads Ended, never Saving…, since the card's own
status is only answered or closed. The server refuses a reference answer to one. A connector's
sign-in card waits on its own flow's callback, by the flow's OAuth `state`
(`ConnectorRuntime.signInEnded`), so two flows of one connector never answer each other.
Unattended runs cannot request approval; Off, out-of-scope targets and the global switch deny with a message the agent can
relay. "Always in this project" adds the project to the target's `allowedProjects`, where Ask
counts as Allowed; "Always" sets access Allowed. Conversation approval covers the same target in
the same thread until the server restarts; it is kept only in memory. Global access, Off, project scope and sites still apply on every use.
Every decision and outcome is recorded in the account's activity.

Per-session files live in `<secrets>/accounts-sessions/<thread key>/<issuance>/`, mode 0700/0600,
removed after 24 hours. Each issuance is written in a staging folder with a `.grants` record of
every grant it was given under (account with its sites, and profile) and renamed into place as one
set, under one lock per conversation folder; the grants are checked again after, and
`revokeIssuedFiles` deletes whole every issuance whose grants no longer stand or whose profile was
removed, staging folders left over, and loose files of the earlier layout, on each change and on
start. Readable values go through files rather than process
environment because providers do not share one process per session (OpenCode 2.x serves every
directory from one server). Database files are `pg_service.conf`, `.pgpass` and certificate files;
API keys and command-line logins are an `env` file to source.

### Signing in

Sign-in runs in the server through `PreviewAutomationBroker`, with the agent's own invocation scope,
so it works for desktop tabs and the server browser alike. The agent's tool call is still running,
so it cannot act on the tab meanwhile; typed text is not recorded in the action timeline.

Each step evaluates a detection script that reports the visible login form: username, password and
one-time-code fields, a submit control, CAPTCHA or passkey prompts. A page with no visible text and
no control is `blank` and never a CAPTCHA: its hand-off is `notLoaded` ("Page didn't load", with
Open in browser) until the page paints. Scient fills only when the
page's origin matches one of the account's sites (a bare domain matches its subdomains), so a
look-alike page never receives the password. It types with `clear`, submits, waits for the
navigation, and repeats for multi-step SSO up to ten steps. A password field returning on
the same origin after password submission returns `password-rejected` without resubmitting; a
CAPTCHA, passkey or push prompt is a hand-off, not a rejection. A returning code field returns
`code-rejected`; generated TOTP may retry once only after a new period starts. Static codes never
retry. Rejected, failed and interrupted sign-ins clear the fields of the last submission, using
origin-bound browser operations; a hand-off leaves them for the user to finish. The result tells
the agent when cleanup could not finish. Sign-in returns `signed-in`, `needs-user`, `limited`, `password-rejected`, `code-rejected` or `failed`
and records that outcome in activity. The 2FA code comes from the stored
`totp` field (`otpauth://` URI or base32 key) via `otpauth`, or from 1Password
(`?attribute=otp`). When an attended sign-in needs a CAPTCHA, phone approval, passkey or missing information,
Scient shows a centered card at the end of the conversation (it scrolls with the messages and
scrolls itself into view once): one line (account, what to do, a close button) with the
sign-in's own browser tab live underneath, fitted to the box. `HandoffBrowser` borrows the
tab's surface and hands it back afterwards; the side panel does not open. The live page is a
native layer, so it shows only while the card is wholly in view above the composer. The user finishes
right there; Scient checks every two seconds for up to three minutes and continues
automatically, including filling a stored authenticator code after phone approval. The line can
show a confidently detected phone match number. A client with no view of the tab gets an
"Open browser" button instead.
Codes are never requested in chat. Unattended sign-ins return `needs-user` immediately.
Hand-offs live only in memory and disappear on completion, cancellation, timeout or interruption;
only the account name, host, challenge kind and optional match number reach the card.
Account approvals and hand-offs use the thread notification settings, with desktop notifications
when the app is unfocused; clicking opens the requesting thread.

`preview_open` and `preview_navigate` run this without an agent call. `previewProfileFallback` first
looks for another Allowed profile that opens the page (new tabs only), then `signInOnPage` signs in
with the Allowed website account matching the page or the requested address, on the same
tab, and navigates back to the requested address. `accountsNote` carries the result. Ask accounts
get a note pointing at `scient_account_sign_in`, which asks; a sign-in state of
`password-rejected` or `code-rejected` stops automatic attempts until the secret changes, since
retries can lock an account. Login walls include a redirect to `/login`, `/sso` or a sign-in
subdomain on the same site, before any password field shows.

The pure parts (`signIn/` detection result → next action, origin matching, TOTP) are Node-tested;
the detection script itself is exercised against fixture pages.

The internal preview operations are `accountCookies`, `accountType` and `accountWaitForLoad`;
they use the authenticated browser rail and are not exposed as agent tools.

### Sign-ins for scripts

`scient_account_browser_session` reads the profile's cookies for the requested site through the
browser host (`Network.getCookies` on the tab's CDP session, which includes HttpOnly cookies) and
writes a Netscape cookie jar. It needs the profile's `scriptSignIn`, on by default.

## The user's side

- **Settings → Accounts & secrets**: the global switch and the sign-ins added on purpose, then one
  row each for lists that grow on their own (Saved passwords, API keys, Apps and connectors you
  sign in to in Claude, Codex, Droid, Source Control or Extensions), each opening a dialog; then browser profiles, each opening
  its sites (its sign-in rows with access and status, then other cookie sites), and password stores. The route stays `/settings/accounts`.
  Built from the existing settings components; labels say what a thing is and status appears only
  when something is wrong. It sits in the Agents group after Extensions. Profiles moved here from
  the Browser page, which links to Accounts; the rest of the browser settings stay there.
- **Logos** for known services live in `accountIcons.json` as square, opaque tiles: a brand tile
  as is, a transparent mark trimmed and centred at 70% on white. `AccountLogo` draws them with no
  padding, so each takes its frame's shape. Bundled artwork sources and rendering metadata
  are recorded in `apps/web/src/scient/accounts/accountIconSources.json`.
- **Profile cards** show the picture and name from the source browser (Chrome's Google picture or
  avatar colour, else a coloured initial), the source and email, the signed-in sites and the access
  chip. "Add profile" lists every profile found on the machine with picture, name and email; picking
  several imports each into a Scient profile of the same name. Profile pictures are round; logos
  of apps and sites are rounded squares.
- **Save on sign-in**: when the user submits a login form in a desktop tab, the guest preload
  reports the origin, username and password once. Server comparison chooses "Save sign-in?",
  "Update password?", or no prompt for an unchanged password, including Scient’s own fills. The
  prompt offers available stores; nothing is kept unless the user saves.
- **Autofill**: the persistent desktop guest reports a visible login form after load. One watcher
  per environment (`accountAutofill.ts`, started by `accountWatchers.ts`) fills every
  desktop tab, shown or hidden, the user's or an agent's, once per document, only when fields remain
  empty and nobody typed. In the user's tabs agent access does not gate it
  (owner, 2026-10-30); in a tab an agent controls (`automationOwner`) only sign-ins that agent may
  use fill, since its scripts can read the page. Exact-origin accounts rank before bare-domain matches, then most recently used.
  Each saved username goes only into a box it fits (`fillChoice`, `loginValueFits`): an email box,
  by its type, autocomplete, name or a label that names only an email, takes only an email, so an
  ID login never fills a university's email tab. When no saved username fits the username box,
  nothing fills: a password never goes in without its own username. The address bar's key still
  offers every login, and the person's choice there goes in whole.
  Before any value is read the server checks, through the browser host, that the tab still shows
  the origin (`tabShows`); the client reads values for one document and types them only while the
  tab still shows that document (`stillShows`). The local desktop (`desktop-bootstrap`) fills
  unrecorded; any other paired client fills as before, each release recorded in Activity with the
  client and origin. Proving a paired desktop is one needs pairing to record the device kind, and
  is later. A tab the server runs is signed in on the server (`accounts.signInAsPerson` with its
  `tabId`, used where it is), so web and phone get the key button without any value; it offers the sign-ins of the tab's profile
  by the same rule as `signInsForPage` (`signInsForTab`), labelled apart where they share a username.
  `fillValues` records the filled page per thread and tab in memory; `authorizePreviewTab`
  refuses agent actions on that page while it is unchanged and the session may not use the
  account, so a filled password is never readable by such an agent. Incognito never
  autofills. The toolbar chip identifies the filled sign-in and offers other matches; the key button
  remains available for manual filling. The desktop advertises `originBoundFill`; `expectedOrigin`
  and the isolated guest's document nonce reject navigation races, including same-origin reloads.
- **Password eye**: desktop tabs and their popups run with Blink's `PasswordReveal`
  (`passwordReveal.ts`, set over whatever the `<webview>` asked for); server-run tabs don't.
  Chromium shows the eye only for what was typed into an empty box while it keeps focus; a value
  set by script, as every Scient fill is, hides it and masks a revealed box again. Author CSS can't
  hide it per tab (`::-ms-reveal` doesn't parse), and agent tabs need no hiding: a filled secret
  never gets an eye, and typed text is already readable by the agent's scripts.
  `scripts/password-reveal-smoke.mjs` proves the eye and the fill rule in a real `<webview>` in CI.
- Website rows offer **Open <site>**, opening the first site in a new in-app browser tab in the
  account's profile (or the default profile). Rejected passwords and codes show a short row status;
  a later successful sign-in or editing the password or two-factor key clears it.
- **Approval cards** appear above the composer of the thread that asked, and on the Accounts page.

### Sign-in status and checks

`AccountSummary.signIn` is the one sign-in state: `signed-in`, `signed-out`, `needs-you`,
`password-rejected`, `code-rejected`, `limited`, `failed` or `unknown`, with when and an optional
detail and `by`. Every sign-in outcome (`outcomeSignInState`) and every look at the site writes it
through `withSignIn` in `AccountDecisions.ts`, whose doc comments hold the holds and what may
replace what: an action (an attempt, a recording, Google showing a new account) always writes with a
new date; a look that finds the same state within the hour writes nothing, and only a working
session seen replaces an attempt state. Only `signed-in` is evidence of a session
(`profileSignIns`); an imported or copied row (`unknown`, "Imported from …" or "Copied from …") is
not. `accounts.sessionsSeen` is the one writer of session rows in a profile: an import makes one
where there is none, a sign-in seen there is an action on it; saved passwords, universities and
Google never take a session. A page tagged with who is signed in (`meta[name=user-login]`,
`meta[name=ol-usersEmail]`) names a session row on a look. A refused API
key is `failed` with the service's answer. `accounts.signInSeen` records the user's own sign-in, when
a submitted saved password leaves no login form six seconds later. A saved password, 2FA secret or
key resets it. Rows show it through `accountStatusLabel`. Stored accounts from before carried
`lastSignInOutcome` and `lastCheck`, folded into `signIn` when read (`foldStoredAccounts`).

`accounts.check` (`checkAccounts.ts`) opens each account's site or university sign-in link in its own profile,
one at a time and 1.5 seconds apart, under a reserved thread that is no agent's
(`userRunInvocation`), so agent access doesn't apply. A tab without a profile is a throwaway session,
so the profile is always named. A session shows by a sign-out link, a login wall or sign-in link, then
a protected cookie, which only counts for a sign-in known to have worked because anonymous visitors
get those too; an OpenAthens university by OpenAthens' own `/check` answer on
`my.openathens.net`; another university by its sign-in link coming all the way back. Check is the
user's own press: a signed-out account with a saved password gets one sign-in, held or not,
whatever its access. A whole run skips imported passwords with no history and stops at 40 accounts,
least recently seen first, and reports how many it skipped.

`agent/guardedSignIn.ts` is the one way into the sign-in engine, for every caller: an agent, a
page an agent opened, Check, a paper fetch, and the user's own press (`person`: Sign in, the paper
chip, Add an account, `scient_account_add`). It locks per real site and identity (`attemptKeys`):
a university's rows, and any login copied beside them, share their membership's
(`membershipKeys`: the Library menu's university group and membership, so its domain and its
username without case, a row naming no one joining the only one named there); a login's copies
share their login group's key; any other row its sign-in origin and username, compared as logins
compare them (emails and `DOMAIN\user` names without case, others exactly). Sign out keys its rows among every row, so it
takes the same locks. The same key
holds the day's one fallback. It reads Accounts afresh inside the lock. The newest status among that key's rows holds
it while `signInHeld` says so; a user action resets it at once (a hand sign-in, a password or 2FA
edit, written as `unknown` "Password changed" by an action, or a press). Looks never replace an
attempt state (`signInStopped`), so the failure count survives them. Account controls decide
every resolve of a stored password or 2FA key: an agent through `authorize`, a page and an agent's
paper request only when Allowed; Check, a person and the user's own paper request always (Off
governs agents only); renewal unless Off.
`find` picks the saved sign-in for a page with `signInsForPage` (this profile, else no profile,
else another profile's only when it is the only one). An attempt stopped at a second factor keeps
its tab as the key's pending attempt, in memory, with its submissions; the next person press or
attended agent call in that tab's thread resumes it (`SignInOptions.resume`) instead of typing
again. Person mode opens a visible tab and hands whatever Scient can't do to the person for 15
minutes at 400 ms. A university counts as signed in only once `checkAccountNow` reaches a journal,
before anything is recorded; then the return tab and leftovers close and waiting papers continue.
`snapshot.attempts` lists the tabs of running and pending attempts; `authorizePreviewTab` refuses
every guarded preview operation on them, and on a university's own sign-in pages, and
`scient_account_browser_session` refuses a site with an attempt under way, and any site of a
profile an attempt runs or waits in (the attempt's `profileId`), checked right before the cookie
read: cookies belong to the profile, and a sign-in may have reached any site. While an attempt runs,
the desktop's capture of its tab goes to `accounts.keepTyped` (`signInKeeps.ts`); after the
sign-in is proven, a typed password is kept only when it is the one password the person submitted
in the attempt, captured before the sign-in finished, with no password field back on its page and
nothing asked elsewhere since. It is kept unverified (no `verifiedAt`), so autofill never submits it;
only a later sign-in where Scient types it verifies it, and a wrong one is rejected once and held
(`AccountsService.keepTyped`: never on a removed or Off row, never over a linked password).

Autofill submits only on the user's own tab, when the site has one saved sign-in whose password
has worked (`verifiedAt` on the password, set when a sign-in where Scient typed it ends signed in,
cleared by a new password) and no hold applies (`automaticSignInOnHold`, shared from
`@t3tools/shared/scientAccountSignIn`), at most once per site every 10 minutes, and only a complete
form.

Google answers for itself. `googleSessions` (desktop) posts to the account list Chrome reads, with
the profile's own session and no page, and `watchGoogleSessions`, started by `accountWatchers.ts`, sends the
result to `accounts.googleSessions.seen` at startup, after a sign-in, and on focus at most every five
minutes. A profile with no Google cookies isn't asked. The server keeps one password-free website
row per address and profile, site `google.com`, with `signIn` set from what Google said. Those
rows tell `pickBrowserProfile` where each account lives, and a saved password stays a separate row
so autofill doesn't widen to every Google subdomain. Check my accounts leaves those rows to Google.

### Sign-in codes

Every caller gets the same code handler (`agent/signInCodes.ts`). Sources, in order: the saved
2FA key (the engine types it like a password); Messages' `chat.db` and Mail's `Envelope Index`
(subject and Mail's preview) on the server's Mac, under one switch, `codeSources.messages`, on
unless turned off and readable only with Full Disk Access; a `code` the agent passes to
`scient_account_sign_in` or `scient_account_fill` from its own mail; and the private card
(`askCode`), which reaches every device and never completes when no one can answer. Gmail's Atom
feed is not a source: it answers 401 even with the inbox open in the same profile.

A reader returns every message that names the service (`codeInText`) since the wait began (−10 s
for a phone's clock, for offering only); mail only from the site's registrable domain. `chooseCode`
inserts one with no click only when it is certain: the one distinct unused code, in a message that
arrived after the last submit that sent something (`requestedAt`; a new challenge in the same
attempt moves it to when that challenge appeared), from a sender whose code this site accepted
before (`SignInAttempts.codeSenders`, learned when a sign-in works after a found code; in memory, so
the first code after a restart is a click), addressed to this login (mail to an email username; a
text names no recipient, so texts are always a click; mail to another known address is never
offered, nor any copy of its digits), and no other attempt on the registrable site
running or kept at a code (`codeWaits`, registered for the whole attempt, and `pending`). Every
code goes only into the challenge it was found or chosen for (origin and code field), and Scient
types at most one found code per challenge (attempt ID, origin and field); the spend rides in the
attempt's submissions, so a resume and a cleared field keep it. The switch is read at every look
and at Insert's claim; a found code carries the switch's version from its pick
(`codeSourcesVersion`) and goes in only while it's on and unchanged, checked before typing and again
right before the submit, where a change clears the typed code unsent. A claimed offer stays bound
to its code across looks. Scient's own code and the person's Insert claim the
hand-off atomically (`claimHandoffCode`); the loser is refused. Otherwise the candidates go on the
hand-off as `codes` (ids, source and time); `accounts.handoffs.insertCode` records the person's
choice until the wait's `expiresAt`, and the engine takes it before it looks again. Digits never
leave the engine; a used message and its digits stay used for an hour (`usedCodes`). A found code
the site refuses is a `found` submission, so the step waits for the next candidate instead of ending
as `code-rejected`; one the person chose ends the attempt as before. Inside one sign-in the engine
sends a password and a code once each; a second of either that Scient sends by itself (a found or
an agent's code) is the sign-in's one fallback and asks `SignInOptions.fallback`, the login's
attempt budget (`AccountsService.takeFallback` with the login's attempt key); Scient's own fills in the person's sign-in count too. Every password and code is
typed as `secret`: the tab's recorded traffic (`NetworkStudy`) masks it, every code Scient typed is
cleared before the tab goes back to anyone unless the sign-in worked (one that won't clear goes to `keepPrivateUntil`: its own attempt keeps the tab private, a hand-off
asks the person, Scient retries every 2 s and tries to close the tab when their wait ends; a refused
close changes nothing), nothing secret is typed while
Playwright's protocol or API debug logging is on, and no code goes into an unmasked field of a tab
being recorded. A limit is decided before any refusal. A 429 (to the page or its own requests), limit or "account locked" wording stops a
sign-in even with its form showing, and right before every submit the engine looks once more
(`signInStopScript`) and stops at a limit or CAPTCHA; during a limit the person's own Sign in opens
the page with nothing typed and no code going in by itself. Only a refused saved 2FA code becomes
`code-rejected`; a refused typed or found code is an ordinary failure. A hand-off says Password
refused (`refused`) when the form says so, when Scient's submission was refused, or when the
person's submitted password is answered by a new page load (`performance.timeOrigin`) showing the
form again with no CAPTCHA (`notePage`): the same page may still be waiting, and a CAPTCHA holds
the form whatever the password. Callers with nobody to answer (unattended, page, paper, connector, renewal)
still look for a code and publish the hand-off, for 3 minutes (20 s for a page or connector, which
run inside an agent's call), then stop with the tab kept as the pending attempt. A result stopped at
a code carries `codeSince`; the agent tool turns it into `code: { from, sentAfter }`. The agent's
result never contains a code Scient found.

The snapshot carries `codeSourcesHost` (the Mac's name and whether Messages or Mail is readable)
only when the server is a Mac, so the codes row follows the server, not the viewer. The server's own
desktop opens Full Disk Access (`accounts.openFullDiskAccess`: one read of Messages so macOS lists
the app, the Privacy_AllFiles pane, the app bundle shown in Finder); any other device names that
Mac and the step.

Messages and Mail are read only by a short-lived process (`sign-in-codes-worker.mjs`, beside the
server bundle; `signIn/codeSourcesHelper.ts`), one per check and per code look: macOS may keep a
long-running process's earlier denial, and a new one is asked afresh, so a grant works with no
restart. It prints whether each source reads, or the matched codes with their message key, sender,
time and recipient match, never a message's text. Snapshots reuse an answer for 2 s after a denial
and a minute after access; the row's return re-check saves the switch as it is, which always asks
a new process. If that still says no, the row offers only **Restart Scient**. A single-executable
server has no worker beside it and reads nothing.

**Needs you** is one store (`AccountsService.setNeedsYou` / `clearNeedsYou`, persisted in Accounts
state as `needsYou`): one entry per item, keyed by `needId`, so the person is asked once. A
sign-in nobody could finish (renewal, paper, connector, an unattended agent) writes
`sign-in:<accountId>`, and so does the person's own sign-in left waiting for them or out of time
(`recordSignInEnd`); any sign-in that works, or the person's Cancel, clears it, and the person can dismiss it
(`accounts.needsYou.dismiss`). Other features add and clear their own entries through the same two
methods. The Accounts band lists approvals, hand-offs and entries; notices and the phone read the
same snapshot. A row whose state is still `needs-you` with no attempt, hand-off or entry for it (a
hand-off lives in memory, so a restart ends it) says Interrupted with Sign in
(`signInInterrupted`), so the row never says Needs you while the band and dot are empty. The
entry names the step its attempt stopped at (`accountHandoffInstruction` of the pending
attempt's `factor`), and the snapshot leaves a `sign-in:` entry out while a live hand-off for the
same row says the same, so the person sees one item per step.

`ThreadAccountRequests` shows approvals, hand-offs and Needs-you entries on the phone, in each chat
and, for those with no chat it lists, on Home and the Accounts & secrets screen; `AgentAwarenessRelay`
marks those threads as waiting for approval so a push goes out (`accountRequestsByThread`).

One function, `accountHandoffInstruction` (shared), words every second factor for the card, band,
notices, push text, phone and Needs-you entries: the push number (`Approve on your phone · 42`),
a security key or a texted code (`AccountHandoff.via`, from detection). An attempt with nobody to
answer still watches a phone approval for the hand-off's time (`watchPush`), then keeps the tab
at its step as before; passkeys, keys and CAPTCHAs return at once, since they need the computer.

### Authenticator, new passwords, health and backup codes

The desktop's login-form report carries what a page offers beyond a sign-in: `offer`
(`two-factor-setup`: a code box beside a square image, canvas or SVG, or an `otpauth:` link;
`recovery-codes`: a settings or security page listing codes of one shape) and `newPassword` (a
sign-up or change form's limits, `passwordrules` and text). The web watcher sends an offer to
`accounts.page.keep` (`AccountAgentService.keepFromPage`), which reads the page through the
browser broker as the user (`userRunInvocation`), so it works the same for desktop and server
tabs; only the desktop reports, so server tabs are not watched.

- **Setup QR** (`twoFactorSetup.ts`). The page script draws each QR candidate on a canvas
  (an SVG from its own shapes, so no image load or page policy is involved) and returns grey
  pixels; the server decodes them with `jsqr`. A cross-origin image the page can't read is left
  out. Nothing reads the screen. Only TOTP keys are kept. The key goes on the tab's login
  (`setupLogin`: the label's username, else the only one, the signed-in one, the first; with none
  a new login for the origin). Scient types the current code into an empty box, retypes a fresh
  one each period only while the box still holds Scient's (`expected`), and keeps the key once
  the setup page is gone on the same site. It doesn't wait for wording that the site accepted:
  a lost key the site took locks the person out, while an unneeded one only fails later.
- **Google Authenticator** (`authenticatorImport.ts`). The import dialog decodes photos of its
  export QR on the device; `importPasswords` parses `otpauth-migration://` by hand and matches
  each key by issuer (row name or site label) and account name, or makes a login when the
  issuer is a domain; the rest are named in the result.
- **Kept values** go through `AccountsService.keepFound`, which saves through `save` and records
  one Undo for all of them in the password-update store (`passwordUpdates` with `field`): Undo
  gives each row what it held (a value, a link or nothing) and removes a login it made. A second
  factor stays on its row; copies don't take it.
- **Strong passwords** (`newPasswords.ts`, web). `strongPassword` (shared) follows the form's
  stated rules and `pattern`; the desktop fills every new-password box and the current one. The
  value is held per tab and saved only after the form's submit is captured (`newPassword` in the
  capture) and the site moved on (`newPasswordTaken`: the form is gone, or a new page shows it
  without newly saying it refused). Fix sets a per-login wish for ten minutes; the first
  new-password form on its sites fills itself.
- **Health** (`passwordHealth.ts`). Only values Scient stores are read (a linked one would
  prompt the Keychain). Each value's SHA-1 and strength are cached by value ref in memory; a
  fiber sends 5-hex prefixes to `api.pwnedpasswords.com/range` with `Add-Padding`, at most once a
  day per value, and matches suffixes locally. The snapshot's `passwordHealth` carries one word
  per row, never a value or hash.
- **Backup codes** are the website field `recovery` (space-separated unused codes; `left`
  counts them). A code step's hand-off sets `backupCodes`; the person's Insert with
  `BACKUP_CODE_ID` makes the engine take the next code (`takeBackupCode`, off the list before it
  is typed) and type it. Nothing uses one otherwise, and `scient_account_credentials` leaves
  them out.

## Keeping sessions

Sites mark many sign-ins as session cookies, and Electron does not store those: they are gone on
quit. `keepSessionCookies`, attached where a persistent browser session is created, gives each one
an expiry (90 days) as it appears, so restarts, updates and crashes keep it, as in a Chrome that
reopens where you left off. Signing out and server-side expiry work as before, incognito is
untouched, and imported cookies pass through the same listener. HttpOnly changes also flush the
cookie store within 3 seconds instead of Chromium's roughly 30.

The server's own browser does the same for its persistent profiles (`keepServerSessionCookies`,
a few seconds after a page's answers), so a sign-in made on a remote computer survives a restart.

Renewal runs on the server (`renewal.ts`), not in a window, so it works with no desktop open. Every
ten minutes it takes the one row most overdue (`dueRenewals`): a row whose stop has lifted at once,
unless renewal tried it since; a held row never; any other a day after its last look or renewal, or,
never seen, once used; used rows first. Each finished turn is recorded (`renewedAt`, persisted), and
an unreachable browser is retried next turn, three times at most. It skips every Google site and
rows signed out on purpose. It runs Check's look in the row's profile, else Main (`renewAccount`,
OpenAthens asked for its own answer) and, if signed out, one sign-in as caller `renewal`: automatic,
so every stop and the moments-ago guard apply, and an unattended sign-in that reaches Google's
sign-in pages stops there.

**No surprise codes.** Any site may start texting a code. `signInFactors` (persisted) records the
second step each row's last sign-in seen from its first page met: `none`, `totp` (only the saved
authenticator key's code went in, `onSavedCode`), or `code` (a push, or a code field the key
doesn't answer, reported by `onCodeStep` even when the code was then read from Messages or Mail).
The key goes in by itself only on this rule, whose contract is the table in
`signIn/detection.contract.test.ts` (every case a review raised, with its verdict):

- **One challenge.** The key goes in by itself only where the page has exactly one visible
  code-like field, inside its only visible form or dialog. Two code boxes (a box counts as one by its own label
  or `aria-labelledby` too), or a second form (a search box in the header, say), hand off.
- **Field attribution.** A text is the field's own only when it is tied to it in the markup: a
  `label` for it or wrapping it, `aria-labelledby`, `aria-label` or its placeholder. Nearby text,
  headings, and another field's or form's labels are never positive evidence. The description
  (`aria-describedby`), title, name and id can only veto.
- **Positive evidence** (`otpApp`) is a tied text that says this field's code comes from an
  authenticator app: a label of the form "Authenticator code" or "Code from your authenticator
  app", or an imperative ("Enter the code from your authenticator app", "Open your authenticator
  app and enter the code"). A sentence with a hedge ("if…", "can't", "set up", "instead") or a
  question counts for nothing. Every visible label of the field, as rendered (`aria-hidden` or not), must say it itself: an accessible name or
  placeholder can't speak over a visible label that says otherwise, as a stale one would.
- **Another way.** Wording that offers an alternative anywhere in the challenge (the field's
  words, its container, the instructions around it) hands off: "or", "either", "backup code",
  "recovery code", "another way", and the same in the languages it reads ("entweder…oder", "ou",
  "o", "oppure", "או").
- **A sent-code notice** is the page saying a code was sent or is being sent: "We texted you a
  code", "A new code has been sent", "A code is on its way", "Check your inbox". It counts from
  anywhere on the page outside its frame, links, buttons and unchosen options. A channel named in
  the notice (a text, a mail) is `otpSent`. A bare mention of a channel ("SMS support is
  available") is no notice.
- **The veto** (`otpDelivery`) is any sent-code notice, or a phone, a text, a mail or a recovery
  address (SMS, email, phone, "sent to", "recovery", "backup address", "delivered to" and the like,
  in the languages it reads) in the field's words (every label, shown or not, its description and
  title), its container or the instructions around it, whatever their class.
- **Never either way:** the page's frame outside the container (navigation, footers, asides) and
  other ways to get a code (links, buttons, menus, options not chosen).
- **All text is normalized before it is matched:** compatibility forms folded (NFKC), every kind
  of space (a no-break space, say) a plain one, matched case-insensitively.
- **A saved key is evidence** (AMENDMENTS 63a, on by default): on a login with a saved key, the
  page's one plain code box (`otpOnly`: one challenge, no veto, no other way offered, the field
  itself saying it takes a code, not a field for other data, a real `<form>` that owns it, and
  exactly one control that can submit it, owned as the DOM owns it (a native control's `.form`,
  which honours `form="…"`, image submits included, plus `role=button` elements inside the form),
  which doesn't itself ask for a code ("Get code", "Send code") by any of its names, Chromium's
  computed one included (an image submit's alt, say), and is the one Scient presses; a form-less
  dialog hands off) takes the key too, when it is a
  code challenge and nothing in the sign-in run spoke of a delivered code.
  - **The field says it takes a code:** `autocomplete="one-time-code"`, or its name, id, labels,
    accessible name or placeholder name a code, an OTP, 2FA, MFA or a passcode. A heading
    ("Verify your identity") or the password before it is never enough by itself.
  - **A field for other data** never qualifies: an `autocomplete` other than `one-time-code`,
    `on` or `off` (`postal-code`, `bday`, `tel`, `cc-*`), or field words, read case-insensitively
    and inside compounds ("customerPin", "zipCode", "Birthdate"), naming a PIN, a birth date, a
    DOB, an SSN, an account, member, customer, card or phone number ("#" and "no." are "number"),
    a card, a CVV, a phone, a postal code, a ZIP or a date.
  - **A code challenge:** the field's words, its challenge or the instructions around it speak of
    a code (`otpContext`), or the run already sent the password.
  - **The cue** (`codeCue`), read on every page of the run and kept, outside the page's frame,
    with links, buttons and options included, and controls' values and accessible names read too
    (`aria-label`, `aria-labelledby`, `role=link` and `role=button`, so an icon-only link counts): a sent-code notice; the veto's words (a phone, a text, a mail) on a page that speaks
    of a code, so an earlier choice of a text or a mail ("Text me a code", a checked "Text
    message") is one; a question whether the code arrived or an offer to resend it ("Didn't
    receive your code?", "Resend code") or any request for one, a code word with "send", "resend"
    or "request", or "get" with "new", "another" or "again" ("Send a new verification code", "Get
    another code"), or any control other than the code's own submit (that one control)
    whose names (its text, value, title, `aria-label`, `aria-labelledby`) name a code (code, OTP,
    PIN, passcode, verification, 2FA): it asks for one or offers another way ("Click here to get a
    code", "Need help with your code?"). "Verify code" on the code's own submit is allowed. A page
    with no code field has no such submit, so all its controls count; a
    conditional fallback ("If you can't get it…"); or
    another method ("Use a backup code", "Try another way"). A bare hedge ("if") is no cue.
  - **A resumed run** can't see its earlier pages, so it counts as having seen a cue.
  - **The opt-out** is the login's "Sign in only when I ask" (`oneSession`): there the saved key
    is no evidence.
  - **Controls as Chromium names them:** on the server browser, every read in the accounts world
    also reads Chromium's accessibility tree, and a control role (button, link, menu item, tab,
    switch) whose computed name or value names a code is resolved into the accounts world, where
    the page's own test (`counts`: visible, outside the frame, not the code's own submit) decides
    whether it is a cue. That covers ARIA menu items, an image's alt, `aria-labelledby`, a title
    and whatever else Chromium uses. A tree that can't be read counts as a cue. The send asks
    again first; the fill focuses the field, then reads Chromium's names again and re-runs the
    classifier before the value goes in, so a control focus reveals stops it. Accepted residual for the
    first release (re-check 30): the fill proper focuses the field again, so a field that blurs on
    the first focus and reveals a code control only on the second can take its input events
    before the send's own read stops the code going out. After focus the fill also requires the field's
    form to be the same one it had before (`field.form`), on every key path, or nothing is typed.
    **Residual rule (integrator, round 34):** beyond this, a finding that depends on arbitrary
    page script behaviour on click or focus is an accepted residual for the first release; the
    login's "Sign in only when I ask" covers it.
  - **In the page:** the fill and the send check it again (`mode: "generic"`): still the one plain
    box that says it takes a code, for no other data, still a code challenge (its words, or the
    run's `passwordSent`, which the engine passes in), and no cue on the page. `passwordSent`
    counts only a password an earlier step sent, never one typed with the code in the same form,
    so a combined form's box that loses its words of a code after the fill isn't sent.
- **One submit rule on every key path** (the authenticator's, the plain box's and "Use saved"):
  a key goes only into a field with a form of its own (`field.form`; `otpNoForm` hands off before
  anything is typed), and is sent only as the person would send it: by pressing the one usable
  native submitter that form owns, never the first of several, and only when its name says to
  verify: its name as the platform computes it must start with a verify word (Verify, Submit,
  Continue, Next, Confirm, Sign in, Log in, OK, Done, Authenticate, or the same in French, Spanish,
  German, Italian or Hebrew; `VERIFY_NAME` in `detection.ts`, shared by the page and the server).
  An unnamed or icon-only button, or any other name, leaves no way. As a second guard, one for
  delivery, a text, a mail, a call or a resend, or one that asks for a new code, is never pressed:
  read word by word from its text, value, title, alt, `aria-label`, the text its `aria-labelledby`
  names, and where it sends (its own `formaction`, or the form's `action` when it has none),
  URL-decoded and split at camelCase, `-`, `_`, `/` and `.`, so `/mfa/sendSmsCode` and `/mfa/%73ms`
  count. The names and the action go through the same rule: a delivery word, or a code word with a
  request (send, request, get, new, another, again), so `/mfa/request-new-code` is refused and
  `/mfa/verify-code` isn't. Words count whole, so `callback` and `context` are no call or text;
  adjacent words also count joined, so a split brand (`WhatsApp`) or a run-together request
  (`requestnewcode`, `resendCode`) is caught. The delivery words include the channel brands (WhatsApp, Telegram, Signal, Viber) and push. One list, `DELIVERY_CHANNELS` in
  `detection.ts`, names the channels for the code field's delivery veto, this submitter veto and
  Chromium's name check, so the three can't drift. On the server browser Chromium's own name for it decides too, at detection, before the
  fill and at the press; an ignored node, an empty name or one that can't be read hands off (usable as the platform says: not `:disabled`, a disabled
  fieldset included, seen by `checkVisibility` with opacity and CSS visibility, not inside
  `[inert]`, nor made non-interactive by CSS (`pointer-events: none` or `interactivity: inert`,
  which inherit), with a box of some size; the code field must be usable the same way, or
  `otpUnusable` hands off; the fill checks both again after focus, and the send at the press) (`button[type=submit]`, `input[type=submit|image]`, its
  `.form` the field's). The method is then the site's own. A disabled one, a custom control
  (`role=button`, a `type=button`) or none leaves no way (`otpNoSubmit`) and hands off before
  anything is typed; the form is never submitted without its button. Another form's control is
  never chosen or pressed, and the send checks the button again in the page.
- **The verdict:** the key goes in only with `otpApp` and no veto, into the one plain box as above,
  or into the very code box the person pressed "Use saved" at (`chosenBox`), and the veto holds
  for that choice too. Missing or mixed evidence hands off. The card carries a revision bound to the box it shows
  (`useSavedRevision`, new whenever the box changes); the click sends it, Accounts refuses a stale
  one, and the sign-in takes it once, while the card offers it and its box is still the one shown.
  One made at the password is no choice for a later code box: the key it loaded qualifies
  there only as any saved key does, under the rule above.

Missing or mixed evidence (`ambiguous`) gets the notice and no generated code: Scient looks for a
texted or mailed code and hands off, as Needs you while someone is there and, with nobody there,
as a deferred renewal that goes first once they are back. What the run saw sets the factor
(`factorSeen`): an outside code marks the row `code` whatever else went in, and so does a key the
site refused.

The engine reports every code box it reads, before deciding anything, by origin, page load and
element instance (`codeBoxId`, `onCodeBox`), as `fits` (the key may answer it) or `seen`; and once
typing worked, `key`, `chosen` (the key, by the person's "Use saved") or `other` (a code from
outside). On the server browser, detection and every `accountType` fill run in one named CDP
isolated world per document (`scient-accounts`, `evaluateInAccountsWorld`). Its table numbers the
field and its container the first time they are read (`otpBox`, `otpField`), and the page can't
see or reset it. Changed words or a moved selector are the same box; an identical replacement is a
new one. A code goes into the very element inspected, in the same page load, found by its
instance; a replacement since is refused. A key fill also carries its container's instance and its
mode (`automatic`, on an authenticator's instructions, or `explicit`, by Use saved). After focus,
and a frame for the page to redraw, the write asks the live field again (the same element, in the
same container, and the classifier's verdict: no veto, and for `automatic` still `otpApp`) and
types nothing if any of it changed. Before a key fill the engine pins the admitted prompt's origin and page load and reads it until
two reads in a row, half a second apart, find the same field and container still eligible
(`steadyPrompt`, four reads at most); a read of another page load or origin hands off at once, so
a replacement document never inherits the action. The action is then decided again from that
read, and its origin authorized, before anything is typed; a field that action gained (a
password on a resumed attempt) answers to the same resubmit budget and its gate. Right before the send it reads it
once more; if the field, its container, the verdict or the submit button (by its instance too)
changed, or a limit or a CAPTCHA now shows, it clears what it typed, by identity, and hands off. The send
itself runs in the accounts world (`accountsWorldDispatch`, on `click` or `press` with `world:
"accounts"`): in the same task as the click it reads the page again and checks the page load, the
field, its container, the button by instance, the verdict and the stop conditions, then clicks
that very button (a script click), with nothing focused: an enabled native submitter of the
field's own form, never the form submitted without it. With no such button there is no checked
way to send it, and the person sends it. The answer is read from the tab's request events first (Playwright's,
which follow the page's workers and its frames in other processes, unlike the tab's own CDP
session): any request the page starts within 3 s, from any origin (a site may post the code to
its API on another), means the site may have the code; only static files (images, media, fonts, scripts,
styles, text tracks, manifests, prefetches) don't count. Erring toward waiting, a stray request
only lengthens the wait: every request counted is waited for, up to 30 s, and the page is read
after them. With no request, the page must show an answer within the same 3 s (navigating, removing or
disabling the form or field, changing the value, or marking itself busy). A refusal before the
send (the page changed, a stop condition, no way to send it) clears what was typed and hands off:
nothing was sent. Silence after it (no request seen and no answer) may be a press the site ignored
or a request no listener sees, so it is treated like a request still unanswered at 30 s: the tab is
left exactly as it is, nothing cleared or closed, the attempt is kept as pending (its tab stays the
person's, and their Sign in resumes in it), its submission is marked `unanswered`, and no code is
sent after it, nor taken as refused, in this attempt or a resumed one; a resume that finds it so
stays pending. Nothing but the person starts over or resumes there: a renewal, check, connector or
agent attempt on that login, an agent in the attempt's own thread included, answers "Finish
signing in on the site's page." without touching the kept attempt, so its tab stays covered and
closed to agents until the person or the tab's own closing ends it; making room among kept
attempts passes over it. A closed tab settles its kept attempts at once (the preview manager's
`closed` event, read by `AccountAgentService`, however the tab went), and the guard checks the tab
is still open before it answers, so a record never outlives its tab to hold the login or the
profile. A keep is checked after it is written: a close told meanwhile settled it, and one before
shows in the tab's status (`tabId: null` for a tab the browser no longer has), so an attempt whose
tab already closed is never kept. Every kept attempt also ends by age, 15 minutes after it was kept: the longer of the 30 s
a sent code's answer is waited for and the person's own hand-off. Its tab is closed first, and the
attempt ends only once the browser shows the tab gone; a close refused (the person controls the
tab, say) keeps the cover, and the tab stays theirs until it closes. The key's send has a 50 s broker deadline for this
wait. The write's own guards (the field still takes input, isn't read-only or
disabled, isn't unmasked while recording, and for a clear still holds what Scient typed) run
before focus and again at the setter. Cleanup records keep each code field's instance and page
load: a clear finds the field by its instance, moved or not, and empties it only while it holds
what Scient typed. Another page load took the code with it; in the same one, a field gone or
detached can't be shown clear, so cleanup reports failure and the tab stays the person's.
`codeBoxes` keeps all of it, apart from the one-shot
notice. The row is marked `code`, even when the run signs in, for any box with a code from
outside, any `seen` box the person didn't choose the key for (a later `key` doesn't clear it), and
any `fits` box a signed-in run got past without the key (a code typed in the browser). A
continued sign-in records nothing. An older build's `signInCodes` is read as `code` for yes, and as
`none` for no only on a row with no saved key, since a key could have answered a texted box then.

Before a sign-in Scient starts by itself types anything, it publishes the row's `sign-in:` entry,
"Signing in · a code is coming". It does so when `mayAskCode` holds (the site asked before, or
nothing shows otherwise and there's no authenticator key), or, for any caller but renewal's own
upkeep, when nobody is at a window (`personActive`: a foreground lease from any client, read at that
moment). If the notice can't be published, nothing is typed. A sign-in Scient started by itself
without that notice that meets a code step anyway publishes "That code is Scient signing in to
_site_" at once, when the engine first sees the step and before it looks for the code
(`onCodeStep`, told once). Both notices are also kept for the phone (`addCodeNotice`, persisted
`codeNotices`, a week and 50 at most) before the sign-in goes on; if one can't be kept, the
sign-in stops there and sends nothing more. The Needs you entry clears when the sign-in settles
any way other than needing the person, and needing them turns it into the ordinary item ("Waiting
for a code"); the phone notice is never taken back. The agent-awareness relay publishes each notice
as two rows on a queue of their own (other threads' backlog never delays them). The notice row
(`scient-accounts-notice-<id>`), titled with the notice, which names the site, is in the
`waiting_for_approval` phase the relay pushes like an approval, and never changes while it stands,
since the relay drops a queued push whose row's phase or time changed. "Signed in" or "Not signed
in" is a second row (`…-done`) once the sign-in settles (`settleCodeNotice`, `settledAt`). Both go
30 minutes after the notice (`NOTICE_ROW_MS`). Accounts keeps the notice, with no count limit,
and records the tombstone of every row the relay acknowledges (`codeNoticeCleared`, per row); it
keeps both a day, and prunes them on the next write after that. The outcome row is shown without a push: it carries `silent`, part of
the signed state the relay stores, which every APNs and FCM alert decision skips, and keeps its
true settlement time. A relay older than the flag drops it and may alert once, so the relay goes
out first. The relay reads what stands
when it starts, so a restart retires rows it published before. Other Needs you entries on
Scient's background threads (`isScientBackgroundThread`) get a row the same way. A tap opens
Accounts, on iOS through the notification handler and on Android through the native tap intent.
A notice row's retries and confirmations stay on that queue, and a link
or relink republishes every notice row standing on it, apart from the chats' catch-up. Each reset
of the relay connection bumps a generation (`connection`), and a new link's commit resets it at
once (`requestCatchUp`, when the stored link differs from the one last published to). A publish
that finishes on an older generation caches no client, records nothing as published and
acknowledges no notice, and goes again; so does one whose connection was reset while Accounts
acknowledged it, and its dedup entry is written only while its generation is current. Accounts
asks the relay, inside its own write and right before it commits, whether that generation is
still current (`codeNoticeDelivered` and `codeNoticeCleared` take `current`): an acknowledgement
from a link since replaced, a clear included, writes nothing. A clear never deletes a notice: its tombstones are kept through
their expiry, a day, and it is pruned on the next write after that, so no link change, mid-write
or not, and no restart can lose a notice before its rows are off every link. The relay holds one turn
(`linkTurn`) from that check through Accounts' durable write, and CloudLink changes the link,
storing a new one or unlinking, in the same turn (`replacingLink`), which then ends the old
connection: no acknowledgement lands for a link replaced while it was being written. A publish reads the link and takes its generation together in that turn, and the
catch-up's own reset runs in it too, so a read that spans a relink never pairs the old link with
the new generation. CloudLink's drop of a revoked link before a new one also runs in the turn. Link
reads and acknowledgements each take one share of the turn and run side by side; a link change
takes all of it, and a waiting change goes before the reads that come after it (`linkGate`). It
waits for the acknowledgements under way 15 s at most (`LINK_CHANGE_WAIT_MS`), so one stuck in an
uninterruptible Accounts write can't hold the link; that one may still land for the old link.
Acknowledgements run off the publish queues, each try bounded (10 s), and Accounts reports a failed
write. A busy or failed one is retried, the last wait repeating, until it lands or its link is
replaced, whatever the publish dedup holds. The
CLI changes a live link through the running server (`unlink`, and `dropRevokedLink` before it
links again), so the change takes the same turn; it writes the stored link itself only when no
server runs: a running server's unlink clears it in its own turn, and one whose unlink failed keeps
it. Its deadline for a live unlink or revoked-link drop (40 s) covers the server's 15 s wait for
the relay's turn and the change itself. After each submit the engine reads the page again
every half second or so for up to eight looks (`POST_SUBMIT_LOOKS`, each a load wait and a settle),
re-reading its fields each time and looking past the submitted page while it is still on screen,
so a code step is told soon after it shows. A site may send its code before that step shows: the
notice is prompt, durable and never dropped, not promised to arrive first (AMENDMENTS 60(b)).

Renewal (`renewalTurn`) signs in with nobody at a window only where Scient saw that no code
comes: a row whose last sign-in was `none` or `totp` (`!mayAskCode`). A saved key alone proves
nothing. It only looks at the rest while nobody is there, and asks again right before
signing in. A surprise code step marks the row, so it only gets a look while nobody is there until a
code-free sign-in clears the mark. A row only looked at and found signed out is kept
(`deferredRenewals`, persisted) and goes first in a turn once someone is back. It is cleared only by
such a turn's conclusive look; a look the browser couldn't make, or one that couldn't tell
(`unknown`, the site unreachable), keeps it, and the row still goes first. Both looks use the row's
profile, else Main, never the browser's default. A pinned task's look (`lookBeforeRun`, kind
`task`, caller `renewal` with `task`) keeps the earlier rule: it may sign in with nobody there,
after the notice.

"Renew sign-ins automatically" (`renewAutomatically`, persisted, absent is on; RPC
`accounts.setRenewAutomatically`) turned off makes every turn only look, whoever is there, and
keeps nothing deferred. `guardedSignIn` applies it to every sign-in but the person's: refused at
admission, and asked again before each value typed and right before each submit (`stillAllowed`,
the engine's one place a send starts). The one exception is the person's own action: a
click or tap carried with the request (`personAction`: their Check or Sign in); an agent's add,
or an agent in a chat they have open, is not one, and an add with the switch off opens for the
person and types and submits nothing, the username included, until they press "Use saved" there
(`handsOff`). No scheduled task is exempt: its run, a pinned task's look included, is refused like renewal and
waits for the person in Needs you. `scient_account_fill` follows the same switch. The same check stops upkeep of a row
that may send a code once nobody is at a window. Agents read the switch in `scient_accounts_list`; no agent tool
changes it.
A password the site refused holds renewal until it changes (`signInHeld`: `refusedAt`,
`password-rejected`).

Accounts' Sign out is recorded per profile and site (`signedOut`, persisted, `signOuts.ts`): on the
desktop for any profile, on a remote computer for its own, and on a remote computer for a delete the
desktop delivers; apart from the delivery log, which drops a delete once others applied it. Only the
person's own sign-in clears it (their press, `byPerson`, or one seen in their browser), never one
Scient made by itself. Every sign-in Scient makes by itself, unattended agents included, checks it on
admission, and notes `signOutSequence`; before every submit and when it settles it asks
`signOutsSince` too, in the row's profile and the tab's (`SignInOptions.stillAllowed`), so a
sign-out undone meanwhile still counts. One that finishes after a sign-out records nothing, deletes
the row's sites' cookies in the tab's jar (`accountClearCookies`; a university's are its
membership's Sign out targets in the row's profile, `signOutTargets`), again after a settle, and closes
the tab, through `keepPrivateUntil` when a step fails; a connector publishes the session its sign-in
made only while the row is still on and in scope for it, then inside `unlessSignedOutSince`, under
the accounts lock, only if no sign-out stands or landed since its sign-in began. Local Sign out records
itself before it clears the jar. The person's sign-in clears the sign-out in the tab's profile.
`recordUse` carries the row's `updatedAt` from the attempt's start and drops the outcome inside its
own write when the row changed since. The desktop window's quiet visits
(`keepSignedIn.ts`) still keep the desktop's own jar in use, which the server's browser can't reach. If a sign-in is needed again within 15 minutes,
`automaticSignInOnHold` stops it, because something keeps ending it.

**Pinned scheduled tasks** (`taskPins.ts`, rules in `taskPinRules.ts`).
`scient_account_manage pin_task` keeps a pin (`taskPins`, persisted) until an explicit unpin. A
pin records:

- the task;
- the row, its profile and its username (a row with none can't be pinned);
- this server's environment;
- the project that made it.

A pin binds only that project's tasks, and only that project can replace or remove it. Stored pins
are read one by one (`readTaskPins`). One that can't be read, such as an earlier shape, never
stops Accounts loading: its task stays blocked until it is pinned again, and Activity names it
once.

**Before each run** (scheduled, manual or webhook), `ScheduledTaskService` asks the optional
`ScheduledRunGate` (one `SCIENT-FORK` region). `pinVerdict` returns `not-allowed` when:

- the sign-in is on another computer, or was removed;
- it moved to another profile;
- it is now someone else (`loginUserKey`);
- it is Off, or out of the task's project.

It reads `signed-out` without a visit from an open `sign-in:` entry or a sign-out on purpose. It
trusts a signed-in look from the last 30 minutes. Otherwise it runs the renewal look in the row's
profile (`lookBeforeRun`), which signs in once by itself when nothing stops it. The look maps to
the run's class: confirmed expiry is `signed-out`; a site limiting access is `not-allowed`; a
failed navigation (the browser's `navigation_network` failure of the open itself), an error page,
a page that never loads or a sign-in that failed otherwise is `unreachable`. The class comes from
this visit, not the row: a university that keeps its last signed-in through a failed visit is still
`unreachable` for the run.

**A blocked run** goes through `rescheduleMissedRun` with its reason, or skips its webhook
delivery. Nothing retries it in a loop. A signed-out run marks the pin `waiting` and sets the one
`sign-in:<accountId>` entry.

**During the run**, the scope carries the task (`deriveAccountSessionScope`). `authorize` and
`authorizeUse` refuse any other website row or browser profile, and the pinned row once its
profile or username changed (reason `pinned`). `forSession` lists only the pinned profile, so the
run's tabs, existing ones included, are in it. Papers the run asks for carry the task
(`PaperRequester.scheduledTaskId`, kept with queued papers). Connectors the run calls get it from
the proxy route, so their linked grant is checked against the pin before Scient reads the jar or
signs in. A run whose records the route can't read is `UNKNOWN_RUN`, which no website row or
profile serves. API keys aren't bound.

Pinning checks the task where it lives: it must be this project's and not webhook-run, since a
skipped delivery can't be replayed. The scheduler refuses an edit that makes a pinned task
webhook-run (`ScheduledRunGate.pinned`); pinning and a trigger edit of one task run one at a time
(`withTaskEdit`), so neither reads the other's state mid-write, and its gate reads the task's pin once Accounts has
loaded (`taskPinOf`). Another project's pin is refused inside the same locked
write. A waiting pin records when the wait began. A sign-in seen after that, whoever made it, makes
`taskResumeLayer` run the task once (`runNow`). It clears only the wait that replay answered; a run
the scheduler can't start yet keeps it, and is tried again when the scheduler's list changes, such
as when the running occurrence ends. The gate writes its verdict only onto the pin it decided on. A run that goes through settles the wait itself, and the
renewal look returns the settled state, so a sign-in it made counts. A pin whose task is gone is
dropped. The phone's Needs you card has
**Sign in** for a sign-in entry: `signInAsPerson` beside the entry's chat, else on the phone's own
thread id, so its hand-off (push number, codes, the computer's tab) shows on the phone's list.

**One session per account** (`oneSession` on a website row). On such a site a new sign-in ends the
other session, the person's own browser included. While any copy of the login carries the mark,
`guardedSignIn` refuses every sign-in Scient would make by itself (`byItself`: renewal, papers,
connectors, unattended agents) with `needs-user`, and sets the one `sign-in:` entry when nobody is
there to ask. The person's own Sign in and an attended agent's hand-off still sign in. Agents set
it with `scient_account_manage edit {oneSession}`, the person with the row's **Sign in only when
I ask** switch. Renewal only looks at such a login, with or without someone there, and never keeps it waiting,
so upkeep asks nothing; a task that needs it asks once. Write-back (connectors'
`signIn.writeBack`) keeps such a session alive without a new sign-in.

**Microsoft accounts.** A row whose sites are Microsoft's sign-in hosts is checked on its own
account page (`checkAddress`): `myaccount.microsoft.com` for work or school, `account.microsoft.com`
for personal accounts. Microsoft's sign-in page lists a remembered account whether or not its
session still works. The account page opens signed in, or sends the visitor to sign in. Renewal's
daily look therefore uses a real signed-in page, and that use extends Microsoft's sliding
persistent session. Sign-in answers "Stay signed in?" with Yes after ticking "Don't show this
again" (`stay`, `remember` in `detection.ts`). After desktop autofill fills a password, the
next pages that tab loads on the same origin, for two minutes, get the same answer
(`answerStaySignedIn`). A Conditional Access page asking for a managed,
compliant or registered device (`AADSTS53000`, `53001`, `53003`, `50097`, `530003`, `530033`, or
"You can't get there from here") is `managedDevice`. The sign-in stops once with
`MANAGED_DEVICE_MESSAGE` and holds like any needs-you; a Needs you entry with no Sign in action
names the step, "Sign in in Microsoft Edge". Sign-in frequency and never-persistent policies just
ask for the person's step at the next sign-in, which the usual holds keep from looping.

Connector OAuth grants are refreshed ahead once a day (`ConnectorRuntime` `refreshAhead`): each own
grant whose token expires before the next sweep goes through `refreshSession`, which marks a lost
one `needs-auth`. A local connector signing in again carries the project its session started in.

Sign-in and autofill tick the page's "Remember me" or "Trust this device" box
(`shared/scientSignInPage` holds the wording) and sign-in answers "Stay signed in?" with Yes.
Shared-computer options are left alone. A failed tick never fails a sign-in.

## Cookie encryption

Packaged builds enable Electron's `EnableCookieEncryption` fuse, so other programs cannot copy
sign-ins out of the profile cookie files. Chromium keeps reading existing plain cookies and writes
new ones encrypted with the same Safe Storage key `safeStorage` uses. The fuse is one-way: turning
it off later loses every encrypted cookie. Agents are unaffected: they use profiles through the
browser, and scripts get cookies through the browser host.

## Google sign-in in Scient's browser

Google decides each sign-in inside Scient's browser itself. Some go through, a password typed in
the tab included (seen 2026-11-09); others end on its refusal ("This browser or app may not be
secure", `/v3/signin/rejected`), even with the page reporting Chrome's identity (Electron 44,
2026-11-04). A profile holding a Google session made elsewhere passes Google's account chooser
and other sites' "Continue with Google" without asking for anything. So Scient stops none of
Google's pages: they load as in any browser, and only Google's refusal is explained. From
2026-11-13 to 2026-11-15 Scient cancelled every recognized sign-in page before it loaded; that
broke sign-ins Google accepted, and in `<webview>` tabs a cancelled load fires no
`did-fail-load`, so the explanation never showed.

`followTabSignIn` (desktop `scient/browser/googleSignInRecovery.ts`, pages classified by
`@t3tools/shared/scientGoogleSignIn`) reports the refusal when it commits in the tab
(`did-navigate`), arrives without a page load (`did-navigate-in-page`) or commits in a frame
(`did-frame-navigate`). A popup a page opened (`watchSignInPopup`) closes on the refusal and
reports to its opener's tab. `PreviewManager` emits each report as
`DesktopPreviewSignInBlockedEvent`, and the tab shows a notice over Google's refusal, or over the
page whose popup or frame was refused (`GoogleSignInRecovery.tsx`): **Sign in in a Chrome window**
into the tab's profile, or **Open in my browser**. Once the window brought the sign-in into the
profile, the tab opens the site, or Google, again. Each event names the page it is about
(`pageUrl`: for a popup, the opener's page when the popup opened); once the tab shows another page
the notice no longer applies. Google's own sign-in starts again at accounts.google.com; another
site's "Continue with Google" starts again at that site's https origin, never at a Google URL
carrying OAuth state, because state, PKCE and the opener belong to the refused attempt.
`followTabSignIn` keeps that origin from the moment the tab enters an OAuth page, across Google's
redirects. Nothing opens by itself. Server-hosted tabs report nothing.

**Google's state per profile** comes from one writer: Google's own list (`ListAccounts`, asked
the way Chrome's `GaiaAuthFetcher` asks it, as a form POST from `https://www.google.com`) through
`googleSessionsSeen`. `recordCheck` ignores Google rows, so cookie presence
(`endedWebsiteSessions`), a bounced quiet visit (`accountsSessionEnded`), an agent's Check and a
pinned run's look never write one. Those two take Google's last answer instead of looking. A row
not already signed out, a new one included, that is answered absent or not valid keeps its state
until a second answer, at least a minute later, says the same. `readGoogleSessions` answers `null`, unknown,
in four cases:

- the probe fails or doesn't answer within 15 s;
- the answer can't be parsed, or any entry lacks its address or a 0/1 validity field;
- Google lists no account while the jar still holds `SID` or `__Secure-1PSID`/`3PSID`;
- the jar has no `accounts.google.com` cookie but still holds one of those.

The watcher bounds each profile's read to 20 s, so one hung profile holds no other. It asks
again in these cases:

- at startup;
- after a sign-in, a row's Check or Check my accounts;
- on focus, at most every 5 minutes;
- at most every minute when a signed-in Google page refreshes a session's `SIDCC` or `PSIDTS`
  cookies (`GOOGLE_ACTIVITY`). The probe's own cookie writes don't count.

Each change of a row's state is logged with ids and counts only.

On Windows Chromium hands WebAuthn to Windows, so a person whose Google passkey lives on a phone
or in Google Password Manager meets the Windows Security dialog; cancelling it leaves Google's
**Try another way**.

## Passkeys

On macOS, upstream passkeys need Apple's restricted
`com.apple.developer.web-browser.public-key-credential` entitlement in the release signing
profile; Scient has requested it. Passkeys in Apple Passwords always need Touch ID or the Mac
password. On Windows Chromium hands WebAuthn to Windows Hello and its phone or security-key
choices, which can't reach passkeys in Google Password Manager. Nothing else in Accounts depends
on any of these.

## Honest limits

- Hidden values stay out of the model's context, not out of reach of a same-user process.
- An agent signed in to a site can do what that account can do there.
- CAPTCHAs, push approvals, new-device checks and passkeys need the user.
- Google can't be signed into inside Scient's browser; its sign-in pages are stopped and explained
  (above). A Google sign-in copied in from a browser (import, Refresh, or the sign-in window) is a
  copy of cookies, not a session Scient can renew. Google may tie a session to the browser and
  computer that made it (Device Bound Session Credentials, Chrome on Windows since 2026, macOS
  following); a copy then works until its short-lived cookie needs renewing. On 2026-10-30, four of
  five Google profiles imported on macOS were signed out within four days; the fifth came from a
  Chrome profile idle for 12 days. Whether binding is the cause is unproven: the
  `accounts.google_copy.*` observations measure how long copies last, by source and platform.
- Known values are not masked in chat or logs, and commits are not checked. These can get in the way
  of real work, so they follow one at a time.
- With the system keychain denied, a private card can't be sealed, so it reports that and saves
  nothing.
- Webhook signing secrets stay in the scheduler's database.
- A CAPTCHA can't be solved from the phone.

## Alignment

- Upstream `browserProfile.ts`, `BrowserImport/`, the Browser page's `BrowserProfilesSetting`
  and the preview tools remain upstream-owned. Scient changes them only at the seams in the
  manifest. `BrowserProfilesSetting` is no longer rendered; when upstream changes its behaviour
  (import, clear, remove), port the change to `apps/web/src/scient/accounts/BrowserProfiles*`.
- Upstream's in-flight GitHub accounts work adds per-session environment to
  `ProviderAdapterV2RuntimePolicy`. If it lands, readable values may use it instead of files where a
  provider has one process per session.
- General improvements (naming imported profiles after their source profile, carrying its picture)
  are offered upstream; see `UPSTREAM.md`.

The analytics gateway must accept the `accounts` settings section before release; regenerate
its wire contract using the [analytics deployment procedure](./scient-product-analytics.md).

### Provider-managed sign-ins

Accounts also shows read-only “Managed in Claude” rows for connected `claudeai`
MCP servers, “Managed in Codex” rows for accessible Codex apps, and “Managed in Droid” rows
for Droid servers that hold Droid's own sign-in (`requiresAuth` with `hasAuthTokens`, as
`signedIn`). Other agents don't report which of their connectors are signed in, so they have none. These come from
Extensions' page-owned native inventory refresh and revision subscription; an
installed plugin or an available app alone is not a sign-in. Apps shared by
several plugins appear once per agent instance. Each row links to that agent's
Extensions page. No credentials are imported, exposed, or stored by these rows.

Plugin-key bindings use the same narrow Accounts port. Extensions persists only
account token refs, and resolves each required key with its agent instance,
plugin, variable name and selected project when computing eligibility. Revocation
and token removal never fall back to a previous value. Status projections discard
resolved `Redacted` values. Accounts usage-only events do not invalidate those
projections; authorization and token-metadata changes do.

HTTP plugin-key consumers also include the original declared remote origin.
Eligibility checks every supported destination a key serves. HTTP plugin-key
delivery caches Redacted values per MCP credential/plugin/variable, also binding
origin, project and account reference. A lock-free Accounts revision is checked
on every request and advances before configuration writes; the changes feed
also drops stale entries. Account edits, token changes, scope/sites/Off/global
access changes and binding changes invalidate cached keys. Concurrent misses
share one resolution and entries refresh after three minutes. MCP revocation,
observed expiry and shutdown clear the cache. Allowed plugin use is audited at
most once per three-minute window per credential/plugin/variable; denials are
recorded every time. Status checks do not record allowed use. Usage activity and
lastUsedAt alone do not advance the authorization revision. Persistence writes
retain their existing semaphore and ordering. The Accounts add form can be opened
from a Keys row with its declared environment name and allowed origins, then
Extensions binds the saved account id. There is no copy into plugin config or a
provider environment. The existing proxy redacts reflected values in responses.

### Assisted adding

- **Search** covers the bundled catalogue, sites the user's Scient browser profiles are signed in to
  (domain metadata only) and matching Keychain items (debounced). "Search the web" is an explicit
  last row that opens a search in Scient's browser; typing sends nothing.
- **Sign in with the browser** saves a passwordless row and runs the person sign-in for it
  (`accounts.signInAsPerson`, `accounts.universities.signIn` for older servers), which drops the
  row again if nothing comes of it.
- **Signing in while browsing**: returning from a known identity provider (Google, Microsoft, Apple,
  GitHub, ORCID, Okta, Shibboleth) with a new HttpOnly cookie records a website account for that
  profile without asking, with an Undo toast. The site is the new session cookie's domain; a
  cookie that also covers the sign-in page is the provider's own session (Google's sign-in, then
  Docs), so nothing is recorded. Never in incognito or in a tab Scient is signing in on. It goes
  through `accounts.sessionsSeen`, so it also confirms an imported row. Only
  cookie domain, expiry and HttpOnly flags are read. Remote server browsers and browser-only
  clients can't read cookie metadata. The Accounts list shows one row per site for sign-ins from
  several profiles (`accountListRows`).
- **Which profile a tab opens in**: `pickBrowserProfile` (`@t3tools/shared/scientBrowserProfileChoice`)
  serves both the app (three marked hooks where upstream read the default profile) and
  `authorizePreviewProfile` for agents (allowed profiles only). Order: this conversation's choice
  for the page's host, or a host the same sign-in covers ("site"); else the conversation's profile,
  else the project's, unless some profile has evidence of a session on the page
  (`profileSignIns`, refused and limited rows excluded) and it has none; then the default if it has
  evidence, else the oldest identity (`siteIdentities`, by `createdAt`). A switch in another
  conversation never decides. The pick carries its reason for the profile switcher. A site-only
  choice (`siteOnly`, from the agent's fallback) leaves the conversation's profile alone. Choices live in Accounts state
  (`profileChoices`: projects, and threads with per-host switches, 500 threads and 50 hosts kept),
  written by `accounts.profiles.choose` from the profile menu, cleared with a removed profile. The
  menu names the profiles with a sign-in on the page. The toolbar makes no claim about the tab's
  own profile: Scient has no record of most sites a profile is signed in to, so a missing record
  doesn't mean signed out. Google refuses signing in from Scient's browser (see Google sign-in in
  Scient's browser), so Scient never offers a Google sign-in here as a way back
  (`googleRecovery`). A signed-out profile imported from a browser says to sign in there and
  offers Refresh from that browser; one with no source says to sign in in a browser and offers
  Import from a browser…. When Main's Google doesn't work, its browser sign-in row offers Copy
  from the profile that holds a working one (`copySignInIntoMain`, a fill through `fillMain`,
  so never over a Google sign-in Main still holds), or, with none, the same import. Gmail is
  only a home shortcut; `/mail/u/<address>/` gives "Temporary Error".
- **University access**: a website account with `institution` (from the public directory) or
  `proxyUrl` (a library link with `{url}`) reaches a university's subscriptions; older `library`
  accounts fold into this shape when read (`foldStoredAccounts`). `accounts.universities.signIn`
  runs the person sign-in (`guardedSignIn`) visibly beside a conversation, in the account's
  profile. An OpenAthens university (`usesOpenAthens`: its directory entity is an OpenAthens one)
  signs in at `my.openathens.net/auth` with the entity preselected, which goes straight to the
  university's page and back to the person's MyAthens page; no journal is involved. Other
  universities have no sign-in page of their own, so a publisher's institutional link asks for
  them. Scient looks at the tab every 0.4 s and closes it once the link comes back and the check
  agrees, so the publisher's page never stays. A tab still on the university's sign-in from an
  earlier try (an attempt's tab, or after a restart one in the account's profile showing a sign-in
  page at a learned address or OpenAthens' sign-in) closes when a sign-in succeeds; other pages are
  never touched. A full `sites` list keeps the sign-in addresses and the university's domain and drops
  other domains first. It adds each exact origin that asked the person for something to `sites`, even under a
  domain `sites` already covers, so a saved password can only ever go where the person already
  signed in and the export guard knows the address; directory data never authorizes that. The sign-in counts once the hidden check agrees; it
  then continues waiting papers. A check that can't tell keeps the last known state and its date.
  While any university is connected, `scient_account_browser_session` refuses every sign-in or
  identity page (`isLoginPlace`, `isIdentityPage`), `*.openathens.net`, and the learned sign-in
  origins: that session also opens the university's other services, and the guard doesn't depend
  on what the bounded `sites` list still holds. Attempt tabs carry the account they sign in, so
  one university never takes over another's.
  Quiet keep-alive visits use `my.openathens.net/check` for OpenAthens universities.
  A library link is read for what it is (`libraryLink`): `go.openathens.net/redirector/<domain>`
  is OpenAthens (`openAthensUniversity`), checked on OpenAthens' own page and signed in through the
  redirector even when the row also has a directory entry; anything else is a rewriting proxy.
  Every university sign-in counts only once a fresh `checkAccountNow` of that route and profile
  agrees; a library link's typing on the way also counts. A person's university attempt that
  doesn't sign in closes its tab unless it waits on the university's own page.
- **University groups** (`@t3tools/shared/scientUniversityGroups`): a view, never stored. Rows join
  by directory entity, domain (an institution's, a redirector's, or a library host under one) or
  library host; Google, Microsoft, `*.openathens.net` and OCLC hosts never join. A group's
  memberships split by username, rows naming no one joining the only named one. The Library menu
  and Settings show one entry per group; paper routes go through groups; Remove removes the
  group's rows. The quiet check's cache is per membership, route and profile (`glanceKey`).
- **Attempt ends and sign-out**: the server keeps each row's last person sign-in end in memory
  (`snapshot.signInEnds`: signed in, needs you, cancelled, failed, timed out), so the Library's
  "Signing in…" always ends, on every window. A server sending `signInEnds` also takes
  `accounts.universities.signOut` and `unreached` on `accounts.papers.continue`; clients gate on
  that field, because raising `ACCOUNTS_PROTOCOL` would turn every `>= ACCOUNTS_PROTOCOL` gate off
  for protocol-1 servers; against an older server the screens keep one line per row. Sign out
  cancels the membership's hand-offs, ends its sign-ins paused at a code, and runs under every one
  of its `attemptKey` locks, read again inside them, so no sign-in in flight lands after it. It is
  one versioned operation (`UniversitySignOut`, kept in Accounts state and the snapshot): in one
  write, `signed-out` by an action on every row (`signedOutOnPurpose`) and the targets per profile
  (`signOutHosts`, shared providers excluded after normalising; `openathens.net` only while no
  other OpenAthens membership in that profile shares its session). A host on one of the university's
  own sites becomes that whole site; any other host, such as a library vendor's, stays host-scoped
  (`inSignOutTarget`) on the desktop, a remote jar and a delivered delete. A shared parent-domain
  cookie the university doesn't own is never deleted; while one still reaches the host
  (`reachesFromParent`), that target isn't cleared. It then stops papers' page loads through the
  university (`withdrawUniversityFetches`), closes Scient's own paper and quiet-look tabs on the
  targets in their profiles, ends sign-ins paused at a code, and records every target for delivery
  (a host delete keyed and planned as its exact hosts, `isHostUnit`) and Main's keep-out. The client clears each target only while the operation is still open and reports
  cleared ones by `opId`; what's left reads "Sign-out unfinished" or "Couldn't fully sign out ·
  host", with Sign out finishing it with its original targets. The person's own sign-in on a row
  ends its open operation, at its start and when recorded (`withSignIn` source `press`), and an
  older operation never acts after that. No look, keep-alive, renewal or other attempt lifts the sign-out:
  `guardedSignIn` refuses every other caller, Check and the glance never open its sign-in link,
  papers re-read it in their turn, the keep-alive doesn't visit it, and renewal never signs it in. The evidence check after
  a sign-in only looks (`checkAccountNow`), so it never starts a second sign-in inside the first's
  lock, and its own answer decides.
- **Browsing access**: `accounts.universities.browse` (`universityBrowsing.ts`) runs 2.5 s after a
  tab settles on an `https` address, only for a university signed in and living in that tab's
  profile, never for private or local hosts. If the loaded page names a DOI or a journal for
  indexers, it is reloaded once per profile, account and journal host (six hours, kept only after
  the reroute happened; a definite "no way in" is kept an hour) through the university: for
  OpenAthens, the server asks `go.openathens.net/redirector/<domain>` with the article's address
  minus query and fragment, without following redirects, and uses the journal route it answers
  with; otherwise the library link or a known platform's institutional link. The tab is reread just
  before navigating and left alone if the person moved on. Pages that aren't articles never leave
  the machine.
- **Papers**: `scient_paper_get` and `scient_papers_queue` go through one queue. Universities are
  tried in `routeUniversities` order, among those the request may use: the group that last
  delivered at this publisher, else the most recently signed in, then at most one other; each
  group's signed-in rows first, and one address once per profile. Article browsing walks the same
  route steps among rows signed in in the tab's profile, the publisher's last working row and route
  first; a reroute counts as access for the journal only once the rerouted tab itself comes back
  with the article, and one that doesn't lets the next university try. Routes reaching one login page in one profile
  (`routeLogin`: OpenAthens for a domain, a proxy's origin with its port and path, a sign-in
  service) are one try; a route about to run through another, after the first, goes through
  `takeFallback`, which spends the first route's login's one fallback (the attempt budget), inside
  the publisher lane after the final checks. Button routes stay with their university. One route set per university: the OpenAthens redirector (which knows every journal the university subscribes to
  and resolves DOI links), the library link, then the journal platform's institutional link
  (`institutionLink`: Atypon, Shibboleth, Elsevier, Springer, IEEE and JSTOR hosts, each checked
  against OpenAthens' own routes). When the publisher's page shows an institutional sign-in button,
  `institutionLinkFromButton` builds the university's link from it (Atypon `ssostart`, a
  Shibboleth SP's `Login`, or a discovery service's `return` with `entityID`) as a further route. The route that worked last at a publisher is kept in memory by the paper service, not
  on the account, and a paper's result refreshes the university's last seen state. Reaching a page
  follows the browser profile; signing in follows the account. Publishers go one at a time with a
  10-20 s pause, and back off only when they refuse. A paper asked for the Library is filed on its
  Sources record after it is saved (see [Scient Sources](scient-sources.md)); the queue item then
  carries its `sourceId` and the PDF's `version`.
  NEJM SAML legal-consent forms produce a `terms` request, distinct from a bot check.
  Its live tab stays open because `authenticateSharedSP` can require a POST; the explicit
  user Open action reveals that tab, never submits consent, and starts bounded retries in
  the same profile. New attempts still reauthorize access and fetch the article separately.
- Browser-sign-in rows name the profile agents use; the usual Signed out / Sign in again applies.
- **API keys**: Get a key opens the service's key page in the default browser. A pasted key with a
  known prefix picks its catalogue entry and goes straight into the key input, never into search
  or React state.
- **Command-line logins** show the tool's own login command to copy; Scient doesn't import CLI
  sessions.

### Custom models downgrade window

The release that migrates Custom models keys keeps a sealed escrow for the previous build. Live Custom models and Accounts readers use the Accounts binding. Accounts persistence writes exact origins separately from the site list the previous build understands. An origin the previous build cannot describe is omitted from its site list. It is never widened to a domain.

Before downgrading, quit Scient and stop the server for the affected profile. Run the migrating release's server binary with `restore-model-keys --base-dir <profile-base-dir>`. Use the same profile flags as the server normally uses. Then start the previous release. The command restores an unchanged key to its original legacy slot and writes the legacy slot ID to the connection. It skips removed keys, replaced keys, and changed endpoints. Reconnect skipped connections in the previous release. If an older release edits Accounts, it may discard the new origin metadata. Check the connection after upgrading again.

During the downgrade window, a version-one escrow is journaled when a write drops the record naming it, and the sweep deletes it, retrying failures. An escrow file no record names is left on disk.

**Next release:** sweep every version-one escrow, clear its registry, and remove the restore command after the downgrade window closes. Keep the compatibility reader for state already written during the window.

### Shared keys with native model agents

Pi and OMP currently require a connection-owned key for Anthropic Messages. The Settings form can save a dedicated key in its sealed Custom models slot. Accounts does not offer that slot for sharing. The follow-up is a key-adding broker for native Pi and OMP requests. It will pin the destination and keep the key out of the child process.

The owner's cross-port checks on Node 24.19 and Bun 1.4.4 observed that platform fetch stripped the bearer header on 307 and 308 redirects and forwarded the Anthropic key header. A dedicated Anthropic key can therefore still reach a redirect destination. The Settings form warns about this until the broker lands.

For the standard OpenAI Completions and Responses clients, Pi passes the connection key as the OpenAI client's `apiKey`. That client uses the key for bearer authorization. OMP passes both protocols through its shared OpenAI request setup, which uses the connection key for bearer authorization. Scient supplies no custom key header for these two protocols. [Pi Completions](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts), [Pi Responses](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-responses.ts), [OpenAI client](https://github.com/openai/openai-node/blob/main/src/client.ts), [OMP Completions](https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/providers/openai-completions.ts), [OMP Responses](https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/providers/openai-responses.ts), [OMP OpenAI request setup](https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/providers/openai-shared.ts).

The source review covers the standard clients in the upstream source trees and the Scient connection configuration. Live qualification of the installed agents and HTTPS-to-HTTP transitions remains open.
