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
  attempt per real site and username at a time. A failed attempt holds the key until the user
  acts: a hand sign-in, a password or 2FA edit, or a press. An agent never retries past that hold.
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
  `accounts-state` (records, profiles and settings), `accounts-value-<id>` (one value each)
  and `accounts-activity` (the last 500 uses). Everything is encrypted, including usernames and
  sites.
- A store whose key is missing or wrong fails closed with `AccountsError("unavailable")`; it is
  never silently reset. A versioned `accounts-vault` sentinel remembers the key location and
  authenticates it before any data is read; fallback keys use `accounts-master-key` through
  `ServerSecretStore`. Changing keychain availability never silently moves an established key.
- A service-account token is a separate encrypted value blob; connection settings retain only its
  random reference. Pending approvals belong to the requesting process and are removed on
  cancellation, timeout or restart. A failed metadata write retains the old value blobs and any new
  unreferenced blobs, because the durable outcome of a failed filesystem sync can be uncertain.

### Connector bindings

Extensions can use an API-key account through `AccountsService.resolveBound` and
`listBindable`. A validated `account:<accountId>:token` vault ref names only that
account's token; no key is copied into the connector store. The saved connector
record is the user's binding approval. Every upstream request resolves the current
source again and checks the account kind, sites, global Agent access and account
access. Bare domains and exact HTTPS origins use the existing Accounts site matcher.

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
  account (or replaces one key, keeping name, details and controls). A matching account in the
  session returns `exists` or `turned_off` with no card; a linked key returns `linked`. Two marked
  upstream seams: the card's note and saved label (`client-runtime/src/secretRequest.ts`, via
  `@t3tools/shared/scientAccountSecretRequest`), and `request_secret` rejecting the reserved
  prefix. The orchestration sentence on secrets points to Accounts first (`ScientAgentCopy`).
- **Sensitive provider environment variables** (upstream settings) stay in upstream's store. Sealing
  them would make the server wait on the keychain at startup, and a denied or slow keychain must not
  stop every provider from starting. `keyLinks.ts` lets one follow an API-key account: providers read
  variables at start, so the value is copied in and copied again when the account changes.
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
  by name. Keeping one copies it into an API-key account and leaves the file alone.
- **The API keys card** (`apiKeyRows` in the client) shows every key once, by name only: each API-key
  account with the variables linked to it and the Custom models connection it uses, then Custom
  models keys no account uses (kept: their store is Accounts'), agent variables not linked to an
  existing account, and plain-file keys by name that no account's `envName` matches.
- Server sign-in and session-signing material is never moved.

## Agent tools

Family `accounts`, capability `accounts`, granted to every provider session by
`prepareMcpSession`. Values never appear in tool output, thread items, logs, errors or exports.

| Tool                             | What it does                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scient_accounts_list`           | Accounts and profiles this session may use: id, name, kind, sites, username (unless Off), access, whether readable, how to use it, status, last check                                                                                            |
| `scient_account_sign_in`         | Signs in on the agent's tab (or a new tab in the account's profile): fills username, password and 2FA code across SSO steps                                                                                                                      |
| `scient_account_fill`            | Types one saved field into the agent's own tab on a page of the account's sites; the agent handles the page, in any language. One password fill per account every 15 minutes                                                                     |
| `scient_account_credentials`     | Readable accounts only: writes owner-only files for this session and returns their paths and how to use them                                                                                                                                     |
| `scient_account_request`         | Brokered HTTP with a hidden API key, only to the account's sites; read-only allows `GET`/`HEAD`                                                                                                                                                  |
| `scient_account_find_profile`    | Checks up to eight Allowed, in-scope non-incognito profiles in temporary background tabs; returns access labels and the first that opens, plus skipped names; never prompts                                                                      |
| `scient_account_browser_session` | A profile's cookies for one site as a cookie-jar file, for scripts; needs `scriptSignIn`                                                                                                                                                         |
| `scient_account_add`             | `api-key`: upstream's private secret card, saved as an API-key account. `website`, `university`: the person sign-in in the conversation's card. Returns the id and usage, or the matching account                                                |
| `scient_connector_setup`         | A local connector's missing setup: saves plain answers the agent asked in chat, asks for each missing key in `scient_account_add`'s card (or links a matching saved key) and restarts the connector; `replaceKeys` asks again for a rejected key |
| `scient_paper_get`               | A paper's PDF by DOI or link into `papers/`: OpenAlex's published free copy, the publisher and each connected university in the browser, then a preprint                                                                                         |

Every call runs `AccountsService.authorize`. Allowed proceeds; Ask shows the user a card ("Allow
in this conversation", "Always in this project", "Always") and waits up to ten minutes.
Unattended runs cannot request approval; Off, out-of-scope targets and the global switch deny with a message the agent can
relay. "Always in this project" adds the project to the target's `allowedProjects`, where Ask
counts as Allowed; "Always" sets access Allowed. Conversation approval covers the same target in
the same thread until the server restarts; it is kept only in memory. Global access, Off, project scope and sites still apply on every use.
Every decision and outcome is recorded in the account's activity.

Per-session files live in `<secrets>/accounts-sessions/<thread key>/`, mode 0700/0600, rewritten
on each call and removed after 24 hours. Readable values go through files rather than process
environment because providers do not share one process per session (OpenCode 2.x serves every
directory from one server). Database files are `pg_service.conf`, `.pgpass` and certificate files;
API keys and command-line logins are an `env` file to source.

### Signing in

Sign-in runs in the server through `PreviewAutomationBroker`, with the agent's own invocation scope,
so it works for desktop tabs and the server browser alike. The agent's tool call is still running,
so it cannot act on the tab meanwhile; typed text is not recorded in the action timeline.

Each step evaluates a detection script that reports the visible login form: username, password and
one-time-code fields, a submit control, CAPTCHA or passkey prompts. Scient fills only when the
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
  `fillValues` records the filled page per thread and tab in memory; `authorizePreviewTab`
  refuses agent actions on that page while it is unchanged and the session may not use the
  account, so a filled password is never readable by such an agent. Incognito never
  autofills. The toolbar chip identifies the filled sign-in and offers other matches; the key button
  remains available for manual filling. The desktop advertises `originBoundFill`; `expectedOrigin`
  and the isolated guest's document nonce reject navigation races, including same-origin reloads.
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
user's own press: a signed-out account with a saved password gets one sign-in, held or not, unless
its access is Off. A whole run skips imported passwords with no history and stops at 40 accounts,
least recently seen first.

`agent/guardedSignIn.ts` is the one way into the sign-in engine, for every caller: an agent, a
page an agent opened, Check, a paper fetch, and the user's own press (`person`: Sign in, the paper
chip, Add an account, `scient_account_add`). It locks per real site and identity (`attemptKey`:
the sign-in origin, a university's learned or identity-provider origin, plus the lowercased
username) and reads Accounts afresh inside the lock. The newest status among that key's rows holds
it while it is an attempt state; only a user action resets it (a hand sign-in, a password or 2FA
edit, written as `unknown` "Password changed" by an action, or a press). Account controls decide
every resolve of a stored password or 2FA key: an agent through `authorize`, a page and an agent's
paper request only when Allowed, Check, a person and the user's own paper request unless Off.
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

When a page wants a code the account can't supply, the hand-off card appears and the engine also
races two other sources (`agent/signInCodes.ts`). `askCode` opens upstream's private card, which
reaches every device and is pending thread state, so it notifies the phone. It never completes when
no one can answer. `findCode` runs on each two-second poll, using the sources in
`AccountsSnapshot.codeSources`, off by default: `readMessageCode` reads Messages' `chat.db` (macOS,
Full Disk Access; recent messages keep their text in `attributedBody`). Gmail's Atom feed is not a
source: it answers 401 even with the inbox open in the same profile. Only messages newer than the
hand-off count, and text must mention a code in English or Hebrew. A refused code is reported, never
retried. The agent's result never contains the code.

`ThreadAccountRequests` shows approvals and hand-offs on the phone; `AgentAwarenessRelay`
marks those threads as waiting for approval so a push goes out (`accountRequestsByThread`).

## Keeping sessions

Sites mark many sign-ins as session cookies, and Electron does not store those: they are gone on
quit. `keepSessionCookies`, attached where a persistent browser session is created, gives each one
an expiry (90 days) as it appears, so restarts, updates and crashes keep it, as in a Chrome that
reopens where you left off. Signing out and server-side expiry work as before, incognito is
untouched, and imported cookies pass through the same listener. HttpOnly changes also flush the
cookie store within 3 seconds instead of Chromium's roughly 30.

`watchKeepSignedIn` stops sessions idling out while the app is open. Every ten minutes it asks at
most one public HTTPS site for a page (`quietVisit`), with the session the profile already has, no
page opened and at most four redirects followed, so nothing new is created and other devices aren't
affected. Each sign-in is visited
once a day; a session that ended sooner halves that gap, down to six hours. Shorter sessions are left
alone, and Google is skipped because its sessions hold without visits. It never signs in. A session
that ended is marked signed out and no longer visited, and the next real use signs in again. If that
sign-in is needed again within 15 minutes, `automaticSignInOnHold` stops and tells the user, because
something keeps ending it. No list of one-session sites is needed: the rule is the same whatever the
reason.

Sign-in and autofill tick the page's "Remember me" or "Trust this device" box
(`shared/scientSignInPage` holds the wording) and sign-in answers "Stay signed in?" with Yes.
Shared-computer options are left alone. A failed tick never fails a sign-in.

## Cookie encryption

Packaged builds enable Electron's `EnableCookieEncryption` fuse, so other programs cannot copy
sign-ins out of the profile cookie files. Chromium keeps reading existing plain cookies and writes
new ones encrypted with the same Safe Storage key `safeStorage` uses. The fuse is one-way: turning
it off later loses every encrypted cookie. Agents are unaffected: they use profiles through the
browser, and scripts get cookies through the browser host.

## Passkeys

Upstream passkeys need Apple's restricted `com.apple.developer.web-browser.public-key-credential`
entitlement in the release signing profile; Scient has requested it. Passkeys in Apple Passwords
always need Touch ID or the Mac password. Nothing else in Accounts depends on the entitlement.

## Honest limits

- Hidden values stay out of the model's context, not out of reach of a same-user process.
- An agent signed in to a site can do what that account can do there.
- CAPTCHAs, push approvals, new-device checks and passkeys need the user.
- Google's sign-in reaches its password step in this browser, with the default user agent; the rest
  of the sign-in is unproven. Google sessions imported from Chrome don't reliably last: on 2026-10-30,
  four of five imported profiles were signed out within four days, and the fifth came from a Chrome
  profile idle for 12 days. Chrome's continued use is the likely cause, not yet proven.
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
its wire contract using the [analytics deployment procedure](product-analytics.md).

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
  doesn't mean signed out. Google refuses signing in from Scient's browser ("This browser or app
  may not be secure", `/v3/signin/rejected`), even with the page reporting Chrome's identity
  (Electron 44, 2026-11-04). Scient never offers a Google sign-in here as a way back
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
- **Papers**: `scient_paper_get` and `scient_papers_queue` go through one queue, one route set per
  university: the OpenAthens redirector (which knows every journal the university subscribes to
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
- Browser-sign-in rows name the profile agents use; the usual Signed out / Sign in again applies.
- **API keys**: Get a key opens the service's key page in the default browser. A pasted key with a
  known prefix picks its catalogue entry and goes straight into the key input, never into search
  or React state.
- **Command-line logins** show the tool's own login command to copy; Scient doesn't import CLI
  sessions.
