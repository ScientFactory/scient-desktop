# Accounts & secrets

**Settings → Accounts & secrets** holds what agents need to get past a login: website and
university sign-ins, API keys, databases, command-line logins and browser profiles. Choose the
computer whose accounts you are editing at the top.

## Keys and passwords

**Add account** saves a key or password in Scient's encrypted store, a system keychain or
1Password (connect it under Password stores first), or in several at once. Password stores also
opens the [Secrets](secrets.md) page, where settings read references from a secret provider.
**Remove** acts at once; the note it shows has **Undo** and names what used the key, and
**Removed** at the top of Accounts keeps **Undo** for an hour. A university's rows come back together.
Removing an account leaves its keychain and 1Password copies in place. Passwords also come in from
a password export or a browser import. An import adds to a saved login and never takes anything
away: its two-factor code, other sites and university stay, and a different password replaces
yours only when both carry a date and the imported one is newer.

**Saved passwords** lists one row per login: one username on one site, with the profiles it is
saved in and when it last worked. Click a login to open it in place: its username, password with
**Show** and **Copy**, sites, profiles and whether it worked or was refused, with **Edit** and
**Remove**. **N copies** shows each profile's copy. Usernames like `CC\corcosy` and `cc\corcosy`
are one login. A login saved with and without its domain (`yaacovc`, `cc\yaacovc`) is marked
**Possible duplicate** beside the other, with **Remove**; Scient never merges them.

In a browser tab, the key in the address bar lists the site's logins, the one that last worked
first, each with **Fill** and a menu: **Show password**, **Copy password**, **Edit** and
**Remove**. **Edit in Accounts** opens Saved passwords at that site. When you sign in with a new
password for a saved login and it works, Scient updates the login and its copies by itself and
says **Password updated**, with **Undo**. Another username that works where a saved one was
refused is saved as its own login. A new password saved in
Edit, from the save offer or by an agent reaches every copy; a copy linked to a keychain or
1Password keeps its link. Each copy keeps the password it replaced: Edit shows it as **Previous
password**, and **Show** and **Copy** work for both, on any device. Each use is in the row's
Activity. A login you remove stays removed when a browser profile is refreshed; importing it again
brings it back.

When an agent needs a key you haven't saved, it asks in a private card and keeps your answer here.
A key you give an agent in the chat is kept as it is, with no card. Each one is a new key, even for
a service you already have one for; an agent replaces a key only when it names the one to replace.
The agent gives you a link to the key it kept.
A key a service refuses shows **Key refused**. A code you give an agent once, such as a 2FA or
pairing code, goes to that agent only and isn't kept.

**API keys** is one row on the page and lists every key, one row each: the keys saved here, the
secret variables in agents' settings, Custom models keys, and secrets found in `.env` files and
shell profiles. Each row says what uses it, such as Codex or Custom models. A key that is only in
an agent's settings or a file says **Only in …**; **Keep in Accounts** saves it here, and an agent's
variable then follows it, so changing the key here changes it everywhere it is used. A file stays
as it is. Custom models already keep their keys in Accounts' encrypted store. Removing an agent
keeps the keys you typed into its settings here, and adding that kind of agent again offers them
back.

A key's row names each place that uses it: Custom models, Voice, [text generators](text-generation.md),
connectors, agent variables and the Library, and a file such as `.env` that has its own copy. A
use whose service refused the key says so; the key shows **Key refused** once two uses refuse
it, and the next use that works clears it. In the key's editor each use is a link to that
connector, agent, connection or engine. A link to Accounts from those places opens that key.
Every place that picks a key uses the same picker, which shows the keys that fit it, with their
last four characters, projects and state, and one entry for keys saved twice with the same value.
A key saved for a host, such as `api.openai.com`, serves that host's `https://` address in
Custom models, Voice and text generators. A key marked **Only for** a service belongs to that
one connector or text generator: it was typed there before Accounts held keys, and agents
can't see or use it. Keys added from Voice before are listed like any key, **Off** for agents.

Research keys also serve the [Library](sources.md) and paper downloads. With an **OpenAlex**,
**Google Books**, **NCBI / PubMed** or **Semantic Scholar** key saved, Scient's own lookups use it, and
**Unpaywall email** lets Scient ask Unpaywall for a free copy that OpenAlex doesn't list; without
one, Scient uses the Library's contact email (Settings ▸ Documents ▸ Library) if you set it. A key you
turn Off for agents is not used by agents. The Library keeps the key each lookup uses (Settings ▸
Documents ▸ Library): the first time, the one Scient picks, after that the one you choose, so a
newer key never switches your Library. Your own Library uses its chosen key even when it is Off
for agents. The values stay in Accounts and never appear in what agents see.

## What agents may use

Everything you add starts **Allowed**. **Ask me** asks you each time, **Off** keeps agents out, and
scope limits it to some projects; the global switch turns all agent access off. These govern agents
only: your own Sign in, Check, fill and Show always work. Turning something Off, removing it, or
narrowing its scope also takes back what agents already hold: files Scient wrote for them are
deleted, and an agent's variable that follows a key is emptied until the key reaches every project
again, unless you typed another value into it. An agent already running keeps the key it started
with until it restarts: such a key says **Restart to update**. An agent variable that kept its saved
value after its key went says **No longer linked**. When an agent needs something that is Off, its card offers **Turn on for
agents**; no card waits longer than the agent's own call. A login whose copies differ says
**Mixed**, and choosing applies to every copy. An account's
controls cover its saved password, and a profile's controls cover the sign-ins in that profile.
Agents never see a hidden value: Scient types it, sends it or writes it to a private file for them.

| Agent tool                       | Use                                                             |
| -------------------------------- | --------------------------------------------------------------- |
| `scient_accounts_list`           | List accounts and profiles, with why each sign-in stands.       |
| `scient_account_fill`            | Fill one saved field on a page, unseen.                         |
| `scient_account_sign_in`         | Sign in through the browser, codes included.                    |
| `scient_account_credentials`     | Write private credential files for readable accounts.           |
| `scient_account_request`         | Make an HTTPS request with a hidden key.                        |
| `scient_account_find_profile`    | Find a profile that can open a page.                            |
| `scient_account_browser_session` | Give scripts a site's browser session.                          |
| `scient_account_add`             | Ask you for a key, password or 2FA key, or to sign in.          |
| `scient_account_check`           | Check an account without changing it.                           |
| `scient_paper_get`               | Save one paper's PDF through open access or your university.    |
| `scient_papers_queue`            | Queue any number of papers.                                     |
| `scient_papers_status`           | See what arrived, what waits for you and what can't be reached. |

## Browser profiles and Main

A browser profile is one set of sign-ins, like a profile in Chrome. **Import from a browser** brings
in a browser's profiles with their sign-ins, passwords and pictures (quit that browser first); the
refresh button brings in new ones later. Each profile's row says how many sites it is signed in to;
open it to see them, each with its agent access and status, **Imported** until Scient sees it
working.

On Windows, Chrome and Edge keep their sign-ins from other apps, so Scient asks the browser itself
to hand them over. The first import walks you through turning on **Allow remote debugging for this
browser instance** at `chrome://inspect/#remote-debugging` (`edge://inspect/#remote-debugging` in
Edge), once. The browser then asks **Allow remote debugging?**: click **Allow**. Scient opens a tab
in that profile, copies its sign-ins, closes the tab and disconnects; one Allow covers every profile
of one import, and Refresh asks again. The browser can stay open. Saved passwords stay in the
browser there. You can turn the setting off again on the same page; Scient then can't refresh from
that browser until it's back on. A computer managed by your organisation may block the setting.

**Main**, Scient's own profile, gets a copy of every sign-in from your other profiles, so it can open
everything. On first start Scient fills Main once and opens new tabs in it; **Use for new tabs**
changes it. Copies show **Copied** until seen
working, and only fill a site Main has nothing for or was signed out of. **Sign out** in Main is
remembered. Your university signs in in Main. Signing in through Google, your university or another
sign-in service adds that site to the profile, with Undo.

Only a profile agents may use in every project gives Main its sign-ins. Turn a profile **Off** or
**Ask me**, or limit it to some projects, and Scient takes out of Main what that profile's copies
wrote there. A sign-in Main already had, or one that changed in Main since, stays. Allow the
profile again and its next sign-in is copied again.

**Profiles made in Scient merge into Main, once.** After Main is filled, each profile you made in
Scient that agents may use in every project is merged into Main and hidden, not deleted: its rows,
its project and conversation choices, the new-tab default and its shortcuts move to Main, and its
own sign-ins stay where they were. Imported profiles, Incognito and limited profiles stay. So does
a profile Main can't take whole: another person signed in on one of its sites, a copy that failed,
or a site you signed out of in Main. For a week, Browser profiles names what was merged, with
**Undo** to bring those profiles back. Merged profiles still count toward the 24-profile limit. A
site that keeps its sign-in only in page storage asks you to sign in once in Main.

**Which profile a tab opens in.** A site you switched to another profile in this conversation stays
there. Otherwise the conversation's profile, then the project's (**Use … in this project** in the
tab's profile menu), as long as it has a sign-in for the site; if it has none, Main. With neither,
the profile for new tabs. The profile menu says why. If an agent's page then shows a sign-in,
Scient signs in with the saved sign-in, or tries up to eight other Allowed profiles and moves the
page to the first that gets in; if none does, the agent asks you.

## Staying signed in

You stay signed in across restarts and updates, on this computer and on remote ones. The server
looks at one sign-in every ten minutes, each about once a day, in its own profile, and signs back in
with the saved password and 2FA key when it finds you signed out. It runs with no window open,
never makes a burst of visits, never signs back in where you used **Sign out**, and stops at the
first lockout, rate-limit or CAPTCHA page. It ticks "Remember me" beside saved sign-ins, so codes
come back less often. While you're away from every Scient window, it signs back in by itself
where nothing reaches you: sites that asked for no code last time, or whose only code comes from
the saved 2FA key. Sites that text, mail or push a code only get a look while you're away, and
sign back in once you're back. Before signing in by itself where a code might come, **Needs you**
says "Signing in · a code is coming". If a site sends a code anyway, **Needs you** says "That code
is Scient signing in to _site_" at once, and Scient tries the code it can read itself. To keep
Scient from signing in by itself at all, turn off **Renew sign-ins automatically** in Settings →
Accounts; it then only looks. Only your own **Sign in** and **Check** sign in then; a scheduled task, or
an agent's request, that needs a sign-in waits for you in **Needs you**. Connectors' own sign-ins are refreshed ahead once a day, so one that has
ended says **Sign in** before an agent needs it.

Microsoft work, school and personal accounts stay signed in the same way: Scient answers "Stay
signed in?" with Yes and visits the account page now and then, which keeps Microsoft's session
going. When your organization only lets you in from a managed computer, **Needs you** says **Sign
in in Microsoft Edge**: only Edge on an enrolled computer can pass that check.

Some sites keep one session per account, so signing in anywhere signs you out everywhere else.
Turn on **Sign in only when I ask** in the row's menu (or ask an agent to) and Scient never signs in
there by itself: when its session ends, it asks you in **Needs you** instead of signing you out of
your own browser.

A scheduled task an agent pins to a sign-in runs only as that sign-in, in its profile, on this
computer. Before each run Scient checks the sign-in still works there, signing back in by itself
when it can. A run it can't make says why in the task: signed out, not allowed, or couldn't reach
the site. A signed-out run asks you once in **Needs you** and waits; nothing retries it in a loop.
Sign in from **Needs you**, on the computer or the phone, and the task runs at once.

Saved sign-ins fill login forms as they appear, without replacing what you type, and submit by
themselves only to sign you back in where they worked before. The toolbar chip picks another.
Incognito never fills, and an agent's tab gets only the sign-ins that agent may use. After you
submit a new or changed password, Scient offers to save it. On the web and the phone, a tab Scient's
server runs has the same key: Scient signs you in there, and the password never reaches that device.
**Don't ask for this site** is remembered for all your devices; the login's menu offers **Offer to
save again**. A sign-in waiting for you offers **Use saved** when Scient didn't type the password.

On the phone, each computer's settings have **Accounts & secrets**: the agent switch, your saved
logins and keys, each with **Check** and **Turn on/off for agents**.

**When a sign-in doesn't go through**, Scient waits before trying that site by itself again: half
an hour after a failure, then a day; an hour after the site limits it; until you're back when it
needs you. A refused password, or a refused code from the saved 2FA key, waits for a new value, so
Scient never repeats it. The row says **Sign-in failed**, **Needs you**, **Password rejected** or
**Code rejected**, with a **Sign in** button; a sign-in that waited for you when Scient quit, or
whose Needs you entry you dismissed, says **Interrupted**. **Can't reach** means Scient couldn't
reach the site from this computer (the network, a VPN, the site down): it says nothing about the
sign-in, and Scient doesn't sign in again because of it. Papers waiting on it show "N papers
wait for you to sign in to …" in the Library. Your own **Sign in** or **Check my accounts** always runs, and
saving a new password lets Scient try again.

**Needs you** at the top of Accounts lists every approval and sign-in waiting for you, each with
**Open chat**, and the Accounts & secrets item in Settings shows a dot. A sign-in waiting for you
says what to do next, and **Password refused** once the site turned down the password tried in its
tab, whoever typed it. Saved passwords says how
many need you. A notice names the account and what to do, once, and goes when the wait ends; one
with no chat opens Accounts. On the phone, what waits with no chat shows at the top of the thread
list and of Accounts & secrets, and a sign-in there has **Sign in**: Scient types what it may, and
you approve the push or pick the code on the phone. When an agent's question goes unanswered, it waits here instead of
holding up the agent: a sign-in with **Sign in**, an approval or a key or password an agent asked you
to save with **Open chat**, where you can answer the agent again.

**Sign in** opens the site's own sign-in beside your work. Scient types what it may and you finish
the rest: a push, a CAPTCHA or a passkey. The password you type is kept once the site lets you in.
A CAPTCHA or passkey needs the desktop. A page that stays blank says **Page didn't load**;
**Open in browser** shows it in the browser.

### Sign-in codes

Codes come from, in order: the saved 2FA key; **Codes from this Mac**, Messages and Mail on the
computer Scient's server runs on; a code an agent reads from your own mail; and you. **Sign-in
codes** says **Enabled**, **Off** or **Needs Full Disk Access** on that computer. On that Mac,
**Open Full Disk Access** opens the setting and shows Scient in Finder to drag into the list;
when you come back it says **Enabled**, with no restart. Elsewhere it names the Mac to allow
Scient on. It's on unless you turn it off. Texts reach
the Mac through Text Message Forwarding on your iPhone.

A code goes into the page by itself, for your own sign-ins, agents' and Scient's own, only when
Scient is sure: the one code mailed to your login's address after the sign-in asked, from a sender
whose code the site accepted before, with no other sign-in on that site under way. A texted code,
and the first code from a sender, is always one click. Otherwise
**Insert code** appears on the chat card, in the browser toolbar for that tab, in **Needs you** and
on the phone: one click, and the server types it, so the code never reaches that device. A code
mailed to another of your addresses is never offered. Scient types at most one found code by
itself for each code the site asks for; if the site refuses it, the next one waits for your click.
If a code Scient typed can't be cleared from the page, the tab stays with you, out of agents'
reach, until you clear it or the tab closes. Scient never types a code while the site shows a limit or a CAPTCHA. Where nothing arrives, a private card asks you on
any of your devices, phone included; agents never see a code Scient found.

A sign-in waiting for you names the step, on the chat card, in **Needs you**, in notices and on
the phone: **Approve on your phone · 42**, **Use your passkey**, **Touch your security key**,
**Enter the code sent to your phone**. While a phone approval waits, Scient keeps watching the page,
even with nobody at the computer, so the sign-in goes on once you approve.

**Check my accounts** opens your browser sign-ins one at a time and marks each signed in, signed
out, needs you or rejected, and says how many it skipped. It counts as your own press, so it tries a
saved password once more. **Check** in a row's menu does the same for one sign-in. For a key it
asks the key's service with one read-only request: **Works** when the service accepts it, **Key
refused** when it refuses it, and **Value readable** for a service Scient has no check for (OpenAI,
Anthropic, OpenRouter, Google AI, Mistral, Groq, xAI, DeepSeek, Together, ElevenLabs, Deepgram and
Zotero have one) or when the service doesn't answer.
A profile that didn't come from a browser offers **Import from a browser…** instead. When a site's
sign-in doesn't work in Main but works in another profile, the site's row in Main says which
profile is used; for Google it offers **Copy from** that profile.

**Apps and connectors** lists connections you sign in to or give a key: Claude, Codex, Droid,
Source Control, [Extensions](extensions.md), Overleaf and ChatGPT dictation. An agent you turned on
that reports no sign-in shows as **Signed out** with **Reconnect**. One that stopped working stays,
with **Reconnect** and what it needs, and opens where it is repaired. A
connector reported by two agents signed in to the same account is one row. Each GitHub login is one
row, with its own chip for Source Control and for the GitHub connector.

### Two-factor, new passwords and backup codes

When a site shows its two-factor setup in a Scient tab, Scient reads the QR code (or the setup
link) from the page itself, puts the current code in the box, and once the setup page is gone keeps
the key on that site's login: **Two-factor saved**, with **Undo**. From then on Scient types the
codes; an authenticator app you also scanned keeps working. To bring keys over from Google
Authenticator, choose **Import passwords…** and pick photos or screenshots of its export QR
codes: each key goes on its login, and the note names any it couldn't place. Microsoft
Authenticator can't export its keys; set each one up again in Scient's browser.

On a sign-up or change-password form, **Fill a strong password** in the address bar puts a
password the form's stated rules accept into it (and your saved password into its current box).
Once the site takes it, Scient saves it: **Password updated** or **Saved**, with **Undo**. A
password the site refuses is never saved.

Saved passwords marks a login whose password was seen in a breach **Leaked**, one used on another
login **Reused**, and a short or common one **Weak**. Breaches are checked with Have I Been Pwned:
only the first five characters of the password's SHA-1 hash leave the computer. On the desktop,
**Fix** opens the site's change-password page and fills it the same way.

Backup codes a site lists are kept on its login: **Backup codes saved**, with **Undo**. When a
sign-in waits for a code, **Use a backup code** types the next one, on the computer or the phone,
and takes it off the list. Scient never uses one by itself, and agents only see how many are left.

### Google

Google decides each sign-in inside the browsers built into apps, Scient's included. It may
let you sign in in the tab as usual, or refuse with "This browser or app may not be
secure". When it refuses, in the tab or in a window a site's **Continue with Google** opened,
Scient explains over the page and offers two ways that work:

- **Sign in in a Chrome window** opens a small window of your own Chrome, Edge, Brave or Chromium,
  with a separate profile that is deleted afterwards. Sign in there and click **Done** (on Linux,
  close the window); the tab's profile gets the sign-in and the tab opens the page again, signed
  in. For **Continue with Google**, the window opens the site you were on: press **Continue with
  Google** there again.
- **Open in my browser** opens Google, or the site you were on, in your usual browser, and you
  carry on there. Nothing comes back into Scient's profile.

A profile already holding a Google sign-in keeps using it: Google's account chooser and other
sites' **Continue with Google** work in it without asking for anything.

If Google asks for a passkey you don't have (on Windows, a **Windows Security** window asking for a
passkey, a phone or a security key), cancel it and choose **Try another way** on Google's page.
Google then offers your password or another way it knows, such as a phone prompt. You don't need
an authenticator app for this.

A Google sign-in copied into Scient, from the window or from a browser import, is a copy: Google
may stop accepting it, sooner where Google ties sign-ins to the browser that made them, which
Chrome does on Windows. After the window copies a Google sign-in, Scient asks Google right away
and says whether Google accepted it; after a browser import, the profile's row shows it at the
next check. When it stops working, the profile's row says so and offers **Refresh from Chrome**
or the window again. For Google you use all day, your own browser is the reliable place.

Scient asks Google itself whether each profile's Google sign-in still works: at startup, when you
come back to the app, when you check, and soon after a Google page you use shows you signed in.
An answer it couldn't get, or one that contradicts the profile, changes nothing.

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
else, connect your university: choose **Connect your university** beside the Library's title. Its
own sign-in opens beside your work, and its crest then stands in that place, showing **Sign in**
and naming the university when its sign-in has lapsed. If your university isn't listed, paste a
link from your library's website; an OpenAthens link (`go.openathens.net/redirector/…`) signs in
through OpenAthens and takes your university's name. The first article you open at a journal
reloads once through your university. Being on campus never counts as signed in, and scripts can't
take your university sign-in's session.

The crest's menu lists each university once, however many ways in it has: an old library link and
its directory entry are one university with two routes, and a student and a staff username are two
memberships of it. Each line says where the university stands, from the computer that runs it, on
every window: **Signing in…** while a sign-in runs, then how it ended (signed in, needs you,
cancelled, failed or timed out), and **Couldn't check** when a quick look couldn't tell. A small
spinner shows while that look runs. **Sign in** goes through the way in that can sign you in (the
one with a saved password, else the one signed in last), and each other way in has its own Sign in
below it. The tab Scient opens for the sign-in closes when it ends, unless the university's own
page still waits for you. When Google closes the connection during the
sign-in, the tab offers the Chrome window, and the sign-in continues once you're back.

**Sign out** in the menu, or on the university's row in **Settings → Accounts & secrets**, signs
you out of the university's own sites in each browser profile it lives in, and out of OpenAthens
where it signs in through OpenAthens, never out of Google or Microsoft. A library link on a
vendor's site signs out of that address alone, never the vendor's other sites. A sign-in already
under way finishes first, and a paper waiting to go through the university doesn't. Until every
site is cleared the line reads **Sign-out unfinished**, or **Couldn't fully sign out** with the
address a vendor's shared sign-in still reaches, with Sign out there to press again. Signing in
again ends that sign-out. Scient then never signs you
back in by itself, nor keeps the session in use, for papers, checks or copies into Main, until you
choose **Sign in** again. **Remove** removes the university with all its
routes. **Add university** connects another one.

**Get PDF** attaches a source's paper; **Get missing PDFs** fetches a project's whole list, and
agents queue any number. One queue runs every paper, one at a time per publisher, and pauses a
publisher that refuses several in a row. A sign-in or a publisher's check asks you once, then every
paper waiting on it continues, even after a restart; so does connecting your university after an
agent asked. What an agent's papers may use is decided each time one is tried, from that
conversation's access in **Settings → Accounts & secrets**: a university it may not use is
skipped, and its papers say "this conversation may not use …" until you allow it there. Many university licences forbid systematic
downloading, so how many papers you fetch is your call. Scient saves only a PDF that is the paper,
in the project's `papers` folder, and never fetches one twice. Papers an agent gets for your
library also go on their source in the [Library](sources.md), which is added when missing.

A paper tries the university that last delivered from that publisher, else the one you signed in to
most recently, and at most one other. **Get PDF** says at the button how it went: attached (naming
the university it came through), or what it waits for. Papers waiting for your university offer
**Sign in** when it is already connected. Papers no route reached can be retried with **Retry**, or
put away with the dismiss button, which every window remembers.

NEJM can ask you to accept its terms before the first paper opens through your university.
Scient pauses those papers and offers **Open** in the same browser profile. Read the terms
yourself and accept only if you agree; Scient never accepts them for you. After you open the
page, the queue checks again for up to ten minutes and continues when access is available.
If you finish later, ask for the paper again to resume it.

## What Accounts doesn't protect against

Hidden values stay out of agent conversations, but not away from a malicious program running as
you. On Windows and Linux, other programs running as you can read keychain items. Without a usable
keychain, Scient keeps its encryption key in a file only you can read.
