---
name: website-account-automation
description: >-
  Check a private status, download your own report, watch for a change or make a
  specific change on a website with your own account, now or on a schedule, and keep
  that working when the sign-in lapses or the site refuses an action. Use
  connector-authoring to build or repair a Scient connector, and playwright for general
  terminal browser automation.
---

# Website account automation

Do the requested work as the intended account, and report what you verified: done, partly done, or what blocked the rest and who can unblock it.

## Choose the route

Pick the authorized route that fits the task, the account and where it will run: a documented API or export, an installed connector (`scient_connector_list`), or Scient's browser in the person's profile. A task that will repeat and needs structured data may justify a connector over the signed-in session; build it with `connector-authoring`. API keys and tokens go into Accounts with `scient_account_add` (its `sites` say where the key may be sent) and are used through `scient_account_request`. Stay within what the person, the site and their organization allow.

## Know whose account you are using

Use `scient_accounts_list` to pick the account and browser profile, and keep that profile for every later step and run. A tab keeps its profile. Confirm identity from something only that account sees (a name, an address, a known value). A 200 status, or a page that merely loads, proves nothing. Check on the computer where the work will run: a remote host has its own copy of the sign-in, and some sites bind sessions to a device, network or campus.

## Read the evidence before recovering

Classify each result from what the site shows:

- **signed out:** a sign-in page, a login form or an explicit "not logged in";
- **not allowed:** the account is signed in but refused this operation. Prove it with a signed-in page, then carry on with the rest;
- **can't reach:** a network, server or timeout failure. This is never evidence of being signed out;
- **limited:** a rate limit, a hold or a deliberate sign-out by the person;
- **needs the person:** a CAPTCHA, passkey, code or terms page;
- **changed:** an unexpected page or reply;
- **unknown outcome:** a write you can't confirm.

A 401 or 403 alone leaves the cause open. A rejected page token may mean the page changed rather than the session.

For a confirmed lost sign-in, use `scient_account_check` when you're unsure, then `scient_account_sign_in` once. Scient spaces its own renewals, and a sign-in that needs the person already raises one Needs-you item: don't add your own or loop. Respect holds and sign-outs. Hand challenges to the person.

## Do the work, then verify it

Resolve real ambiguity about the account, target or effect before a write. Confirm each write by its receipt or by reading the state back. If the outcome is unknown, check the resulting state before you consider repeating it. Repeat only what is safe to repeat or what you know had no effect. Repeat reads only within the site's limits.

**Scripts:** call `scient_account_browser_session` at the start of each run, and never reuse an earlier export. Prefer the JSON file when the site uses partitioned cookies.

**Derived tokens:** some services issue their own token through the signed-in session, such as an LMS mobile token or a video platform API. Get it the way the site's own page does, save it with `scient_account_add`, and re-derive it once if it's rejected. If the signed-in page also fails, the sign-in is what was lost.

**Sites that allow one session at a time:** a run can sign the person's browser out, and the other way round. Tell them once.

## Keep secrets and sessions private

Passwords stay in Accounts. Cookies, tokens and session files stay in Scient's private session files on that computer. Keep them out of chats, project files, prompts, logs, commits and other machines; Scient copies sign-ins between its computers itself.

Don't promise "signed in until …". Cookie dates mislead, and the site decides. Leave the cookie jar alone rather than deleting cookies to test renewal.

## Schedule when asked

Use `schedule_task` on the host that holds the sign-in. The task's prompt names:

- the account and profile;
- the allowed actions;
- where results go;
- when to notify or stop.

Choose a cadence that suits the site and the need, and don't let runs overlap where they could duplicate a write or disturb the session. For a watch, compare one validated value with the last successful one, and keep failures out of the baseline. Skip a missed write rather than catching up blindly.

Notify on the outcomes the person cares about, and send one notice per unresolved blocker. Tell them the next run, where results go, and how to pause it (`schedule_task` with `enabled: false`). Say whether a first run was verified or is still pending. To withdraw access: the Accounts controls, or "sign out of all devices" at the site.
