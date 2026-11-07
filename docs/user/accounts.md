# Accounts & secrets

**Settings → Accounts & secrets** holds what agents need to get past a login: website and
university sign-ins, API keys, databases, command-line logins and browser profiles. Choose the
computer whose accounts you are editing at the top.

## Keys and passwords

**Add account** saves a key or password in Scient's encrypted store, a system keychain or
1Password (connect it under Password stores first), or in several at once. Removing an account
leaves its keychain and 1Password copies in place. Passwords also come in from a password export or
a browser import.

When an agent needs a key you haven't saved, it asks in a private card and keeps your answer here.
A key a service refuses shows **Key refused**. **Keys used by Scient** shows the keys Scient itself
runs on. **Keys in plain files** lists secrets found in `.env` files and shell profiles; **Keep in
Accounts** copies one in and leaves the file alone.

## What agents may use

Everything you add starts **Allowed**. **Ask me** asks you each time, **Off** keeps agents out, and
scope limits it to some projects; the global switch turns all agent access off. An account's
controls cover its saved password, and a profile's controls cover the sign-ins in that profile.
Agents never see a hidden value: Scient types it, sends it or writes it to a private file for them.

| Agent tool                       | Use                                                             |
| -------------------------------- | --------------------------------------------------------------- |
| `scient_accounts_list`           | List accounts and profiles.                                     |
| `scient_account_fill`            | Fill one saved field on a page, unseen.                         |
| `scient_account_sign_in`         | Sign in through the browser, codes included.                    |
| `scient_account_credentials`     | Write private credential files for readable accounts.           |
| `scient_account_request`         | Make an HTTPS request with a hidden key.                        |
| `scient_account_find_profile`    | Find a profile that can open a page.                            |
| `scient_account_browser_session` | Give scripts a site's browser session.                          |
| `scient_account_add`             | Ask you for a key, or to sign in to a site or university.       |
| `scient_paper_get`               | Save one paper's PDF through open access or your university.    |
| `scient_papers_queue`            | Queue any number of papers.                                     |
| `scient_papers_status`           | See what arrived, what waits for you and what can't be reached. |

## Browser profiles and Main

A browser profile is one set of sign-ins, like a profile in Chrome. **Import from a browser** brings
in a browser's profiles with their sign-ins, passwords and pictures (quit that browser first); the
refresh button brings in new ones later. Their sites show as **Imported** under **Browser sign-ins**
until Scient sees them working.

**Main**, Scient's own profile, gets a copy of every sign-in from your other profiles, so it can open
everything. On first start Scient fills Main once and opens new tabs in it; Browser profiles says so
in a line you can dismiss, and **Use for new tabs** changes it. Copies show **Copied** until seen
working, and only fill a site Main has nothing for or was signed out of. **Sign out** in Main is
remembered. Your university signs in in Main. Signing in through Google, your university or another
sign-in service adds that site to the profile, with Undo.

Only a profile agents may use in every project gives Main its sign-ins. Turn a profile **Off** or
**Ask me**, or limit it to some projects, and Scient takes out of Main what that profile's copies
wrote there. A sign-in Main already had, or one that changed in Main since, stays. Allow the
profile again and its next sign-in is copied again.

**Profiles made in Scient merge into Main, once.** After Main is filled, each profile you made in
Scient that agents may use in every project is merged into Main and removed: its rows, its
project and conversation choices, the new-tab default and its shortcuts move to Main. Its
history does not. Imported profiles, Incognito and limited profiles stay. So does a profile Main
can't take whole: another person signed in on one of its sites, a copy that failed, or a site you
signed out of in Main. Browser profiles names what was merged, for a week. A site that keeps its
sign-in only in page storage asks you to sign in once in Main.

**Which profile a tab opens in.** A site you switched to another profile in this conversation stays
there. Otherwise the conversation's profile, then the project's (**Use … in this project** in the
tab's profile menu), as long as it has a sign-in for the site; if it has none, Main. With neither,
the profile for new tabs. The profile menu says why. If an agent's page then shows a sign-in,
Scient signs in with the saved sign-in, or tries up to eight other Allowed profiles and moves the
page to the first that gets in; if none does, the agent asks you.

## Staying signed in

You stay signed in across restarts and updates. Scient quietly visits each signed-in site about
once a day and ticks "Remember me" beside saved sign-ins, so codes come back less often.

Saved sign-ins fill login forms as they appear, without replacing what you type, and submit by
themselves only to sign you back in where they worked before. The toolbar chip picks another.
Incognito never fills, and an agent's tab gets only the sign-ins that agent may use. After you
submit a new or changed password, Scient offers to save it.

**When a sign-in doesn't go through**, Scient stops trying that site by itself, however long it
waits, so it never repeats a wrong password. The row says **Sign in needed**, **Needs you**,
**Password rejected** or **Code rejected**, with a **Sign in** button, and papers waiting on it show
"N papers wait for you to sign in to …" in Sources. Signing in, **Check my accounts** or a changed
saved password lets Scient try again.

**Sign in** opens the site's own sign-in beside your work. Scient types what it may and you finish
the rest: a code, a push, a CAPTCHA or a passkey. The password you type is kept once the site lets
you in. A site's code is asked for in a private card on any of your devices, phone included, and
the agent never sees it; under **Sign-in codes** Scient can read them from Messages on a Mac (this
needs Full Disk Access). A CAPTCHA or passkey needs the desktop.

**Check my accounts** opens your browser sign-ins one at a time and marks each signed in, signed
out, needs you or rejected. It counts as your own press, so it tries a saved password once more.
A Google sign-in copied from Chrome can stop working while you use Chrome. Google doesn't allow
signing in from inside Scient, so sign in to Google in Chrome, then choose **Refresh from Chrome**
on the profile's row. A profile that didn't come from a browser offers **Import from a browser…**
instead. When Google doesn't work in Main, its row under Browser sign-ins offers **Copy from** the
profile that has it.

**Other sign-ins** lists those managed elsewhere: Claude, Codex, Source Control and [Extensions](extensions.md). Each
GitHub login is one row, with its own chip for Source Control and for the GitHub connector.

## Other computers

Scient copies this computer's sign-ins to the computers it connects to, such as a lab server over
SSH, so agents there are signed in too. **Send sign-ins to other computers**, under Other computers
in Accounts, turns it off.

Each profile goes to its namesake there (Main to Main), for the sites you have in Accounts
only. Profiles that are Off, limited to projects or kept from scripts stay here, and their copies
leave. Passwords, two-factor keys and your university's sign-in never go. If a site refuses a copy,
press **Sign in there** once. Copies leave when you remove that computer here while it is connected,
press **Forget this computer** there, or this computer stays away 30 days. A sign-in that was
already there when a copy arrived is that computer's own: sign out there to remove it. Programs running as you
on that computer can read them.

## Papers behind a subscription

On a university network, **Get PDF** and agents reach closed papers with no setup. From anywhere
else, connect your university: **Connect your university** is the first row in Sources. Its own
sign-in opens beside your work, and its crest then stays beside the Sources title. If your
university isn't listed, paste a link from your library's website. The first article you open at a
journal reloads once through your university. Being on campus never counts as signed in, and
scripts can't take your university sign-in's session.

**Get PDF** attaches a source's paper; **Get missing PDFs** fetches a project's whole list, and
agents queue any number. One queue runs every paper, one at a time per publisher, and pauses a
publisher that refuses several in a row. A sign-in or a publisher's check asks you once, then every
paper waiting on it continues, even after a restart. Many university licences forbid systematic
downloading, so how many papers you fetch is your call. Scient saves only a PDF that is the paper,
in the project's `papers` folder, and never fetches one twice.

## What Accounts doesn't protect against

Hidden values stay out of agent conversations, but not away from a malicious program running as
you. On Windows and Linux, other programs running as you can read keychain items. Without a usable
keychain, Scient keeps its encryption key in a file only you can read.
