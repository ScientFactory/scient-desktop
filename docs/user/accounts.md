# Accounts

Open **Settings → Accounts** to connect website and library sign-ins, API keys, databases,
command-line logins and browser profiles. Choose the environment that will use them.

Use **Add account** to enter details and choose Scient’s encrypted store, a system keychain
item or a 1Password reference. Connect 1Password under Password stores first. You can also
import a password export or add browser profiles with their existing sign-ins. Connected
services remain managed in [Extensions](extensions.md).

Everything you add starts **Allowed**. Change access to **Ask me** for approval on each use
or **Off** to deny agents. Scope can limit access to selected projects. The global switch
turns agent access off without changing individual controls. Read-only applies where Scient
can enforce it; readable values are supplied to agents through private session files.

| Agent tool                       | Use                                                    |
| -------------------------------- | ------------------------------------------------------ |
| `scient_accounts_list`           | List available accounts and profiles.                  |
| `scient_account_sign_in`         | Sign in through the browser, including supported 2FA.  |
| `scient_account_credentials`     | Create private credential files for readable accounts. |
| `scient_account_request`         | Make an HTTPS request with a hidden key.               |
| `scient_account_find_profile`    | Find a browser profile that can open a page.           |
| `scient_account_browser_session` | Supply a site's browser session to scripts.            |

When an agent opens a new HTTPS page without choosing a profile, Scient checks for sign-in
or access-denied pages. It tries up to eight other Allowed profiles and opens the page in the
first that can access it, closing the failed tab. Checks use temporary background tabs; Ask me,
Off and incognito profiles are skipped. Project scope and the global agent-access switch apply.
If none works, the agent receives guidance to ask you to sign in or allow a profile in Accounts.

Choosing a profile explicitly or navigating an existing tab keeps that profile. If access fails,
Scient tells the agent to use `scient_account_find_profile` with the URL.

Saved sign-ins fill automatically as a login form appears, without submitting or replacing
what you typed. Exact-site matches come first, then your most recently used sign-in. Use the
small toolbar chip to choose another, or the key button to fill again. Incognito never autofills.

After you submit a login form, Scient offers to save a new sign-in or update a changed password.
An unchanged password produces no prompt. Capture requires a `<form>` element.

In Add an account, **Sign in with the browser** opens the site in Scient's browser. Sign in however
the site allows, then press **Done** on the notification; the account is saved with that browser
profile. If you type a password, Scient offers to save it as usual. When you come back to a site from
Google, your university or another sign-in service, Scient offers to save that site too.

Choose several stores when saving. Updates change every existing copy. If an external write
fails, Scient keeps the password and reports the failed store. A 1Password vault that rejects a
write is hidden from the choices until you reconnect 1Password; no setup step is needed.
Removing an account leaves its external keychain and 1Password copies in place.

CAPTCHAs, push approvals and passkeys need you. Google blocks embedded sign-in; import
its browser session instead. Hidden values stay out of agent conversations, but Accounts
does not protect them from a malicious process running as you. On Windows and Linux,
other programs running as you can read system keychain items. A host without a usable
keychain keeps Scient's encryption key in an owner-only file.
