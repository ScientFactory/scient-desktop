# Scient Accounts

Connect something once, and every agent can use it the way the user allows. Accounts covers website
sign-ins, library access, API keys, databases, command-line logins and browser profiles. It owns
Scient's encrypted store and the links to values kept in the system keychain, 1Password, Bitwarden (including Vaultwarden), Proton Pass or Custom
models. Settings → Accounts is its page ([user guide](../user/accounts.md)); agents use it through `scient_account*` tools.

Code: `apps/server/src/scient/accounts`, `apps/web/src/scient/accounts`,
`apps/desktop/src/scient/accounts`, contracts in `packages/contracts/src/scient/accounts.ts`,
`accountRpcs.ts`, `desktopAccountsBridge.ts` and `secrets.ts`. Every upstream integration point is
listed in `scient-accounts-seams.json`; `pnpm accounts:seams:check` verifies it.

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
  command-line logins start readable because agents run them in scripts.
- **Scope**: `GrantScope`, shared with Extensions. A session gets all-projects grants plus those
  listing its project, checked again on every use. Subagents, forks and scheduled runs in the
  project get the same grants.

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
colour, source browser, source profile name and email from import. A profile without a record is
Allowed for all projects with script sign-ins on, which matches upstream behaviour where agents
reach every profile.

Access is enforced in the server's preview tools: `preview_status` lists only the profiles the
session may use, and `preview_open` refuses an Off profile (or asks for an Ask one), including the
default profile when the agent names none (the built-in default if a cold browser has no default
inventory yet). Existing-tab actions recheck global access, profile Off
and project scope without prompting; Ask approval is decided at open. Status also omits denied tabs
and clears current-page metadata when the current tab is denied.

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

### Website session status

When Accounts opens, regains focus, receives account changes or completes a profile-site sign-out,
its desktop client reads cookie domains and expiry metadata using the same environment/profile
partition mapping as the signed-in-sites view. No cookie names or values leave the native handler.
The client supplies this display-only observation to `accounts.snapshot`; the server marks a website
account Signed out only after an earlier `signed-in` outcome or a previously observed live cookie,
and only when a successful read finds no unexpired cookies for any of its sites. Session cookies
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
- **`request_secret` values** (upstream, one use, 24 hours) and **sensitive provider environment
  variables** (upstream settings) stay as they are.
- Server sign-in and session-signing material is never moved.

## Agent tools

Family `accounts`, capability `accounts`, granted to every provider session by
`prepareMcpSession`. Values never appear in tool output, thread items, logs, errors or exports.

| Tool                             | What it does                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scient_accounts_list`           | Accounts and profiles this session may use: id, name, kind, sites, access, whether readable, how to use it, status                                                          |
| `scient_account_sign_in`         | Signs in on the agent's tab (or a new tab in the account's profile): fills username, password and 2FA code across SSO steps                                                 |
| `scient_account_credentials`     | Readable accounts only: writes owner-only files for this session and returns their paths and how to use them                                                                |
| `scient_account_request`         | Brokered HTTP with a hidden API key, only to the account's sites; read-only allows `GET`/`HEAD`                                                                             |
| `scient_account_find_profile`    | Checks up to eight Allowed, in-scope non-incognito profiles in temporary background tabs; returns access labels and the first that opens, plus skipped names; never prompts |
| `scient_account_browser_session` | A profile's cookies for one site as a cookie-jar file, for scripts; needs `scriptSignIn`                                                                                    |

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
navigation, and repeats for multi-step SSO up to six submissions. A password field returning on
the same origin after password submission returns `password-rejected` without resubmitting; a
CAPTCHA, passkey or push prompt is a hand-off, not a rejection. A returning code field returns
`code-rejected`; generated TOTP may retry once only after a new period starts. Static codes never
retry. Rejected, failed and interrupted sign-ins clear the fields of the last submission, using
origin-bound browser operations; a hand-off leaves them for the user to finish. The result tells
the agent when cleanup could not finish. Sign-in returns `signed-in`, `needs-user`, `password-rejected`, `code-rejected` or `failed`
and records that outcome in activity. The 2FA code comes from the stored
`totp` field (`otpauth://` URI or base32 key) via `otpauth`, or from 1Password
(`?attribute=otp`). CAPTCHAs, push approvals, passkeys and unknown forms return `needs-user`; the
agent asks the user to finish in the browser.

The pure parts (`signIn/` detection result → next action, origin matching, TOTP) are Node-tested;
the detection script itself is exercised against fixture pages.

The internal preview operations are `accountCookies`, `accountType` and `accountWaitForLoad`;
they use the authenticated browser rail and are not exposed as agent tools.

### Sign-ins for scripts

`scient_account_browser_session` reads the profile's cookies for the requested site through the
browser host (`Network.getCookies` on the tab's CDP session, which includes HttpOnly cookies) and
writes a Netscape cookie jar. It needs the profile's `scriptSignIn`, on by default.

## The user's side

- **Settings → Accounts**: the global switch, browser profile cards, accounts, password stores.
  Built from the existing settings components; labels say what a thing is and status appears only
  when something is wrong. It sits in the Agents group after Extensions. Profiles moved here from
  the Browser page, which links to Accounts; the rest of the browser settings stay there.
- **Logos** for known services live in `accountIcons.json` as square, opaque tiles: a brand tile
  as is, a transparent mark trimmed and centred at 70% on white. `AccountLogo` draws them with no
  padding, so each takes its frame's shape.
- **Profile cards** show the picture and name from the source browser (Chrome's Google picture or
  avatar colour, else a coloured initial), the source and email, the signed-in sites and the access
  chip. "Add profile" lists every profile found on the machine with picture, name and email; picking
  several imports each into a Scient profile of the same name. Refresh re-copies sign-ins.
- **Save on sign-in**: when the user submits a login form in a desktop tab, the guest preload
  reports the origin, username and password once. Server comparison chooses "Save sign-in?",
  "Update password?", or no prompt for an unchanged password, including Scient’s own fills. The
  prompt offers available stores; nothing is kept unless the user saves.
- **Autofill**: the persistent desktop guest reports a visible login form after load. Exact-origin
  accounts rank before bare-domain matches, then most recently used. Scient fills once per document
  without submitting, only when fields remain empty, the user has not typed, and the thread agent
  may use the account: global access on, in scope, and Allowed or Ask approved for its project.
  Incognito never
  autofills. The toolbar chip identifies the filled sign-in and offers other matches; the key button
  remains available for manual filling. The desktop advertises `originBoundFill`; `expectedOrigin`
  and the isolated guest's document nonce reject navigation races, including same-origin reloads.
- Website rows offer **Open <site>**, opening the first site in a new in-app browser tab in the
  account's profile (or the default profile). Rejected passwords and codes show a short row status;
  a later successful sign-in or editing the password or two-factor key clears it.
- **Approval cards** appear above the composer of the thread that asked, and on the Accounts page.

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
- Google refuses sign-in in embedded browsers; import a Chrome profile for Google.

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
MCP servers and “Managed in Codex” rows for accessible Codex apps. These come from
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
