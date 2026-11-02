# Accounts & secrets

Open **Settings → Accounts & secrets** to connect website and university sign-ins, API keys, databases,
command-line logins and browser profiles. Choose the environment that will use them.

Use **Add account** to enter details and choose Scient’s encrypted store, a system keychain
item or a 1Password reference. Connect 1Password under Password stores first. You can also
import a password export or add browser profiles with their existing sign-ins and saved
passwords. Saved passwords, sign-ins recorded while browsing and sign-ins managed elsewhere (Claude,
Codex, Source Control, Extensions) are each one row that opens their list. Profiles imported from a
browser show its current picture and name; the refresh button next to **Browser profiles**
also brings in new sign-ins and passwords (quit that browser first for sign-ins). Connected
services remain managed in [Extensions](extensions.md).

Everything you add starts **Allowed**. Change access to **Ask me** for approval on each use
or **Off** to deny agents. Scope can limit access to selected projects. The global switch
turns agent access off without changing individual controls. Read-only applies where Scient
can enforce it; readable values are supplied to agents through private session files.

| Agent tool                       | Use                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `scient_accounts_list`           | List available accounts and profiles.                                           |
| `scient_account_fill`            | Fill one saved field on a page the agent is working through, without seeing it. |
| `scient_account_sign_in`         | Sign in through the browser, including supported 2FA.                           |
| `scient_account_credentials`     | Create private credential files for readable accounts.                          |
| `scient_account_request`         | Make an HTTPS request with a hidden key.                                        |
| `scient_account_find_profile`    | Find a browser profile that can open a page.                                    |
| `scient_account_browser_session` | Supply a site's browser session to scripts.                                     |
| `scient_account_add`             | Ask you for a key in a private card and keep it here.                           |
| `scient_paper_get`               | Save one paper's PDF through open access or your university.                    |
| `scient_papers_queue`            | Queue any number of papers to fetch in the background.                          |
| `scient_papers_status`           | Read what arrived, what waits for you and what can't be reached.                |

When an agent needs a key you don't have in Accounts, it asks in a private card and saves your
answer here, so later conversations reuse it. One-time secrets still use the plain card.

A tab you or an agent opens without naming a profile goes, in order, to the profile you switched
that site to in this conversation, the profile signed in to the site (your latest switch settles a
tie), the profile you last switched that site to in any conversation, this conversation's profile,
the project's profile (**Use … in this project** in the tab's profile menu), then the default.
Switching a tab's profile is remembered for the conversation and the site.

When an agent opens a new HTTPS page without choosing a profile, Scient checks for sign-in
or access-denied pages. It tries up to eight other Allowed profiles and opens the page in the
first that can access it, closing the failed tab. Checks use temporary background tabs; Ask me,
Off and incognito profiles are skipped. Project scope and the global agent-access switch apply.
If none works, the agent receives guidance to ask you to sign in or allow a profile in Accounts.

When no profile opens a sign-in page and a saved sign-in for that site is Allowed, Scient signs in
on that tab and returns to the page the agent wanted, so agents never chain these steps themselves.
Ask me accounts wait for your approval, and a sign-in the site rejected is not repeated until you
change it.

Choosing a profile explicitly or navigating an existing tab keeps that profile. If access fails and
no saved sign-in helps, Scient tells the agent to use `scient_account_find_profile` with the URL.

You stay signed in across restarts and updates, including on sites that mark a sign-in as ending
when the browser closes. To keep sign-ins alive, Scient quietly visits each signed-in site about
once a day, and checks Google's accounts at startup, on focus and after sign-ins. It also ticks
"Remember me" and "Trust this device" beside a saved sign-in, so codes come back less often. You can
untick them; shared-computer options stay off.

**Check my accounts** opens your browser sign-ins one at a time in their own profiles and shows what
it found on each row: signed in, signed out, needs you, or rejected. A signed-out account with a
saved password gets one sign-in attempt; a sign-in the site rejected gets none until you change it.
Imported passwords nobody has used are skipped; **Check sign-in** in a row's menu checks that one.

When a site sends a sign-in code, a private card asks for it on any of your devices, including the
phone, and the code goes straight into the page. The agent never sees it. Under **Sign-in codes** you
can let Scient find codes in Messages on a Mac (texts forwarded to it; this needs Full Disk Access,
which also lets Scient read your other files). It's off until you turn it on.

The phone also shows approvals to answer and sign-ins waiting for you, with a notification. A CAPTCHA
or passkey still needs the desktop.

**Keys used by Scient** lists the keys Scient itself runs on, by name, what uses each and where to
edit it. A provider variable can follow a saved key: replace the key in Accounts and the variable
follows. **Keys in plain files** lists secrets found in project `.env` files and shell profiles, by
name. **Keep in Accounts** copies one in and leaves the file as it is.

A key a service refuses shows **Key refused**, and the agent asks you for a new one in a private card.

**Get PDF** on a source with a DOI or link finds the paper the same way an agent does, saves it in
`papers/` and attaches it to the source. See [Papers behind a subscription](#papers-behind-a-subscription).

Saved sign-ins fill automatically as a login form appears, in every tab, yours or an agent's,
without replacing what you typed. They submit only to sign you back in: on your own tab, when it's
the site's one saved sign-in, belongs to that profile, has worked there before and the site isn't
limiting sign-ins, once every 10 minutes. Sign-ins from the same profile come first, then exact-site
matches, then your most recently used sign-in. Use the small toolbar chip to choose another, or the key button to fill
again. Incognito never autofills. A tab an agent controls gets only sign-ins that agent may use, and
an agent can't act on your tab filled with a sign-in it may not use until that page changes.
Turning an account Off stops agents using its password; a profile you allow still lets agents use
the sites that profile is signed in to.

After you submit a login form, Scient offers to save a new sign-in or update a changed password.
An unchanged password produces no prompt. Capture requires a `<form>` element.

In Add an account, **Sign in with the browser** opens the site in Scient's browser. Sign in however
the site allows, then press **Done** on the notification; the account is saved with that browser
profile. If you type a password, Scient offers to save it as usual. When you sign in to a site
through Google, your university or another sign-in service, Scient adds that site for the profile
and shows Undo. Coming back to the sign-in service's own sites, such as Google Docs after Google's
sign-in, adds nothing. A site signed in from several profiles is one row with their pictures.

Choose several stores when saving. Updates change every existing copy. If an external write
fails, Scient keeps the password and reports the failed store. A 1Password vault that rejects a
write is hidden from the choices until you reconnect 1Password; no setup step is needed.
Removing an account leaves its external keychain and 1Password copies in place.

CAPTCHAs, push approvals and passkeys need you. A Google sign-in copied from Chrome can stop
working while you keep using Chrome, so sign in to Google once inside Scient: press Sign in next to "Signed out of Google" on the
profile, or Gmail on an empty browser tab, which always opens the selected profile. Hidden values
stay out of agent conversations, but Accounts does not protect them from a malicious process
running as you. On Windows and Linux,
other programs running as you can read system keychain items. A host without a usable
keychain keeps Scient's encryption key in an owner-only file.

## Papers behind a subscription

On a university network, Get PDF and agents reach closed papers with no setup: Scient tries the
publisher first, and a publisher that recognises the network hands over the PDF.

To reach papers from anywhere, connect your university. It works on any network, any time, whether
or not a paper is waiting:

- **Connect your university** is the first row in Sources until you do. Pick your university there,
  in a conversation that asks for it, or under **University library** in Add an account.
- Its own sign-in opens beside your work. When you finish, the tab closes and the university shows
  **Signed in**. If it already knows you, nothing opens to type into. Pressing Sign in again
  reuses the same tab. Passwords are offered for saving as on any other site.
- If your university isn't listed, paste a link from your library's website.
- The university's crest then stays beside the Sources title. Press it to see the sign-in's status,
  sign in, or check it. An amber dot means it needs you.

Once you're signed in, journals know you in Scient's browser too. The first article you open at a
journal reloads once through your university, and you land back on it with your university's
access. Only article pages are sent this way, and only to your university's sign-in service.

Scient searches a public directory of institutions with only the text you type. A university that
uses OpenAthens signs in on your own OpenAthens page and reaches any journal it pays for through
it, so no journal opens during sign-in or checks. Other universities sign in through a publisher,
which Scient closes as soon as the university answers. A university account
is a website sign-in held in one browser profile, your default unless you choose another. Being on
campus never counts as being signed in. Scripts can't export the session at your university's
sign-in service, because it can also open your mail and records.

Every paper goes through one queue, so nothing is limited to a few at a time:

- **Get missing PDFs** beside the Sources title fetches a project's whole list.
- Agents use `scient_paper_get` for one paper and `scient_papers_queue` for any number.
  `scient_papers_status` says what arrived, what waits for you, and what can't be reached.
- Papers run one at a time per publisher with a pause between, with publishers side by side. If a
  publisher refuses several in a row, Scient pauses that publisher, doubling the pause up to four
  hours, and carries on with the others.
- A sign-in or a publisher's check asks you once, on the Sources band or in the conversation, and
  every paper waiting on it continues afterwards. The queue survives a restart.

The list is yours to decide, however long it is. Many university licences forbid systematic
downloading, and a publisher can suspend a university's access over it.

Scient checks each PDF before saving it. A short preview of a longer paper, or a file about
something else, is not kept. PDFs are saved in the project's `papers` folder, and a paper already
there isn't fetched again.
