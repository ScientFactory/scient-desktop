# Scient Accounts

Connect something once, and every agent can use it the way the user allows. Accounts covers website
sign-ins, library access, API keys, databases, command-line logins and browser profiles. It owns
Scient's encrypted store and the links to values kept in the system keychain, 1Password or Custom
models. Settings → Accounts is its page; agents use it through `scient_account*` tools.

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

| Source         | Where the value lives                                                                                   | Read                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `scient`       | Scient's encrypted store                                                                                | Decrypted in the server when used                    |
| `keychain`     | An existing macOS Keychain, Windows Credential Manager or Linux Secret Service item (service + account) | `@napi-rs/keyring`, when used                        |
| `1password`    | An `op://` reference                                                                                    | `@1password/sdk`, cached per session for rate limits |
| `custom-model` | A Custom models connection's key                                                                        | Custom models' own resolver; stored once             |

Links are read when needed, so a value stays in one place. On macOS the user approves Scient once
per keychain item ("Always Allow"). On Windows and Linux any program running as the user can read
keychain items. Apple Passwords / iCloud Keychain items are not readable by other apps; their
export file is the way in.

### Browser profiles

Profiles are upstream T3 (`browserProfile.ts`, client settings `browserProfiles`). Scient keeps a
server-side `BrowserProfileRecord` per profile id: access, scope, `scriptSignIn`, and the picture,
colour, source browser, source profile name and email from import. A profile without a record is
Allowed for all projects with script sign-ins on, which matches upstream behaviour where agents
reach every profile.

Access is enforced in the server's preview tools: `preview_status` lists only the profiles the
session may use, and `preview_open` refuses an Off profile (or asks for an Ask one), including the
default profile when the agent names none. Tabs the user opened in an Off profile stay theirs; the
check covers the agent's own open.

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
  `accounts-state` (records, profiles, settings, approvals), `accounts-value-<id>` (one value each)
  and `accounts-activity` (the last 500 uses). Everything is encrypted, including usernames and
  sites.
- A store whose key is missing or wrong fails closed with `AccountsError("unavailable")`; it is
  never silently reset.

### Existing secrets

- **Extensions connectors** (`connector-<uuid>`): Accounts provides the `ConnectorCredentialStore`
  implementation. It keeps the agreed port and names, encrypts envelopes, and reads a legacy
  plaintext envelope once, rewriting it encrypted. Extensions still owns connectors.
- **Custom models keys** stay where Custom models keeps them, because its rotation and process
  lifetime rules depend on that store. An API key account links to a connection (`custom-model`
  source), so the key is stored once.
- **`request_secret` values** (upstream, one use, 24 hours) and **sensitive provider environment
  variables** (upstream settings) stay as they are.
- Server sign-in and session-signing material is never moved.

## Agent tools

Family `accounts`, capability `accounts`, granted to every provider session by
`prepareMcpSession`. Values never appear in tool output, thread items, logs, errors or exports.

| Tool                             | What it does                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `scient_accounts_list`           | Accounts and profiles this session may use: id, name, kind, sites, access, whether readable, how to use it, status          |
| `scient_account_sign_in`         | Signs in on the agent's tab (or a new tab in the account's profile): fills username, password and 2FA code across SSO steps |
| `scient_account_credentials`     | Readable accounts only: writes owner-only files for this session and returns their paths and how to use them                |
| `scient_account_request`         | Brokered HTTP with a hidden API key, only to the account's sites; read-only allows `GET`/`HEAD`                             |
| `scient_account_browser_session` | A profile's cookies for one site as a cookie-jar file, for scripts; needs `scriptSignIn`                                    |

Every call runs `AccountsService.authorize`. Allowed proceeds; Ask shows the user a card ("Allow
once", "Always in this project", "Always") and waits up to ten minutes, and is denied at once for
unattended runs; Off, out-of-scope targets and the global switch deny with a message the agent can
relay. "Always in this project" adds the project to the target's `allowedProjects`, where Ask
counts as Allowed; "Always" sets access Allowed. Every decision and outcome is recorded in the account's activity.

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
navigation, and repeats for multi-step SSO up to six steps. The 2FA code comes from the stored
`totp` field (`otpauth://` URI or base32 key) via `otpauth`, or from 1Password
(`?attribute=otp`). CAPTCHAs, push approvals, passkeys and unknown forms return `needs-user`; the
agent asks the user to finish in the browser.

The pure parts (`signIn/` detection result → next action, origin matching, TOTP) are Node-tested;
the detection script itself is exercised against fixture pages.

### Sign-ins for scripts

`scient_account_browser_session` reads the profile's cookies for the requested site through the
browser host (`Network.getCookies` on the tab's CDP session, which includes HttpOnly cookies) and
writes a Netscape cookie jar. It needs the profile's `scriptSignIn`, on by default.

## The user's side

- **Settings → Accounts**: the global switch, browser profile cards, accounts, password stores.
  Built from the existing settings components; labels say what a thing is and status appears only
  when something is wrong. Profiles moved here from Integrations; the rest of the browser settings
  stay in Integrations.
- **Profile cards** show the picture and name from the source browser (Chrome's Google picture or
  avatar colour, else a coloured initial), the source and email, the signed-in sites and the access
  chip. "Add profile" lists every profile found on the machine with picture, name and email; picking
  several imports each into a Scient profile of the same name. Refresh re-copies sign-ins.
- **Save on sign-in**: when the user submits a login form in a desktop tab, the guest preload
  reports the origin, username and password once; the browser shows "Save sign-in?" with the store
  and access. Nothing is kept unless the user saves.
- **Autofill**: a key button appears in the browser toolbar when an account matches the page; it
  asks the server for that account's values (`accounts.fillValues`, refused unless the page origin
  matches) and fills the form in the guest.
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

- Upstream `browserProfile.ts`, `BrowserImport/`, the Integrations page's `BrowserProfilesSetting`
  and the preview tools remain upstream-owned. Scient changes them only at the seams in the
  manifest. `BrowserProfilesSetting` is no longer rendered; when upstream changes its behaviour
  (import, clear, remove), port the change to `apps/web/src/scient/accounts/BrowserProfiles*`.
- Upstream's in-flight GitHub accounts work adds per-session environment to
  `ProviderAdapterV2RuntimePolicy`. If it lands, readable values may use it instead of files where a
  provider has one process per session.
- General improvements (naming imported profiles after their source profile, carrying its picture)
  are offered upstream; see `UPSTREAM.md`.
