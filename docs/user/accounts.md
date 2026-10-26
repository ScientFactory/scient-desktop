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
| `scient_account_browser_session` | Supply a site's browser session to scripts.            |

The browser's key button fills a saved sign-in without submitting. After you submit a
login form, the browser can offer to save it. Capture requires a `<form>` element.

CAPTCHAs, push approvals and passkeys need you. Google blocks embedded sign-in; import
its browser session instead. Hidden values stay out of agent conversations, but Accounts
does not protect them from a malicious process running as you. On Windows and Linux,
other programs running as you can read system keychain items. A host without a usable
keychain keeps Scient's encryption key in an owner-only file.
