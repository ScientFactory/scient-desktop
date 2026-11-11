---
name: connector-authoring
description: Find, add, build, test, fix or improve a connector (an MCP server) in Scient. Use when the user asks for a connector or to connect a service, asks to make, fix, repair or improve a connector or MCP server, when a connector stopped, needs sign-in or returns errors, or when the user needs to reach a service, website, database, file collection or command-line tool that no installed connector or Scient tool covers, including sites with no public API that the user signs in to.
---

# Connector Authoring

A connector gives agents tools for one service. In Scient it is a folder with a
`manifest.json` (MCP Bundle format) and a small Node program. Scient starts it, hands it keys
and sign-ins from Accounts, and checks it before it goes in. The goal: a connector that does
the user's real tasks, returns correct data, stays signed in, and holds no secret in its files.

This skill grants no tools or permissions.

## Make a connector

1. **Add one that exists before building.** `scient_connector_list {query}` (for example
   `{"query":"gmail"}`) shows the user's connectors and ones Scient can add from Discover and
   the MCP Registry. If one fits, `scient_connector_add {from}` with its `name` adds it, on for
   every project; a key or the user's own sign-in app it needs is asked in a private card.
   Add one connector for the need: not alternatives, or aggregators that bundle many services,
   unless the user asks.
   Then follow its message (`scient_connector_setup` for `needs-setup`,
   `scient_connector_control {action: "sign-in"}` for `needs-sign-in`). New chats get its
   tools; in this chat, call them through `scient_connector_check {connector, calls}`.
   `scient_connector_add` also takes an https MCP address or a `.mcpb` file. Build one only when none fits; an
   entry's `reason` says why it can't be added, a good place to start. Also check Scient's own
   tools (papers, sources, accounts, compute). If the work is one-off, a script fits better; if
   it is know-how rather than access, a skill does (`scient-skill-authoring`).
2. **Ask briefly**, in one message and only what you don't know: which service (a link), the
   two or three things they want to do with it (with an example), and how they sign in (an API
   key, a university or site login, nothing).
3. **Choose the kind:**
   - a web API with a key or none: `auth-and-sessions.md` for keys, `science-apis.md` for
     science services;
   - an API that only offers OAuth: the template can't sign in with OAuth yet; read
     `auth-and-sessions.md`, "OAuth APIs", for what to do instead;
   - a website the user signs in to, with no documented API: `study-a-website.md` first, then
     `auth-and-sessions.md`;
   - files, a database or a command-line tool on this computer: `local-tools.md`.
4. **Plan a few tools** shaped like the user's tasks, not one per endpoint. Read
   `tool-design.md`. Tell the user the plan in a few lines and go on.
5. **Build from the template.** `scient_connector_copy {name}` writes a working connector to
   `connectors/<slug>/` (an OpenAlex example with no dependencies). Read its `README.md`,
   replace the example tools in `server.mjs`, and update `manifest.json`. Keep `mcp.mjs`,
   `http.mjs` and `session.mjs` unless you have a reason. Scient runs Node connectors on its own
   Node, and npm may be missing: add libraries only when truly needed, installed inside the
   folder.
6. **Test with real calls.** `scient_connector_check {folder, calls}` with real inputs from the
   user's tasks. For a site the user signs in to, add `signIn` with the name of their Accounts
   sign-in, so the check runs signed in. Read the data: it must match the source, not just
   arrive. See `testing.md`. Fix and check again until it passes. If the service keeps
   answering 429 or 403, to plain requests too, stop after a couple of tries: tell the user,
   and don't save a connector you couldn't check.
7. **Save and set up.** `scient_connector_save {folder}`. When it says `needs-setup`, call
   `scient_connector_setup {connector}`: keys open a private card, a sign-in links the user's
   Accounts sign-in. Then check once more with `connector` set, so it uses them. (`signIn` is
   only for a folder that isn't saved yet.) New chats get its tools; in this chat, call them
   through `scient_connector_check {connector, calls}`.
8. **Report** in a few lines: what it does, its tools, what you tested with one real result,
   what you didn't test, and how to take it back: a new connector has nothing earlier to go
   back to, so the user removes it on its page (Remove can be undone); after a fix, its page
   has **Undo last change**.

## Fix or improve a connector

1. **Find what is wrong.** `scient_connector_list` gives each connector's status (`ready`,
   `needs-setup`, `needs-sign-in`, `error`, `off`) and last error. `scient_connector_check
   {connector}` (no folder) tests an installed one, hosted or local, and lists its tools;
   with `calls` it makes them too.
2. **A hosted connector** (it runs online) has no code to fix. `needs-sign-in`:
   `scient_connector_control {connector, action: "sign-in"}` opens its sign-in in this chat's
   browser as the user's own tab, for them to finish (your preview tools don't see it; tell
   them it is open); then check again. `off`: `action: "on"`. Other errors are
   the service's: tell the user what it said.
3. **A local connector**: `needs-setup` is `scient_connector_setup`. A one-off failure may need
   only `scient_connector_control {connector, action: "restart"}`. Otherwise copy and fix it:
   1. `scient_connector_copy {connector}` copies it into this chat's folder and returns its
      status, last error and log. For an npm or PyPI package connector, the package's code
      comes too, in `package/`, with its dependencies; `source` says where to edit. A command
      that runs a script outside its folder is named in `source`: copy the script in to change
      it.
   2. Read the error, the log and the code. Read `fixing.md`.
   3. Reproduce with `scient_connector_check {folder, connector, calls}`, using the call that
      failed.
   4. Make the smallest fix. Keep tool names, inputs and result fields.
   5. Check again: the failing call and the calls that worked before.
   6. `scient_connector_save {folder, connector}`. Scient keeps the old version (Undo on the
      connector's page). A vendor's connector or a package becomes the user's own copy; say
      so.

Turning connectors on, off or restarting them needs no question first. Removing one is the
user's: tell them where (its page in Settings → Extensions). When the user asks you not to
change anything, that includes connectors: don't add, save, set up or switch any.

Go from the diagnosis to the saved fix in one go; don't stop to ask whether to go ahead.
Ask only when the fix needs something from the user (a key, a sign-in, a choice of behaviour).

## Hard rules

- **Secrets only through Scient.** Keys, passwords, tokens and cookies never go in chat, code,
  `manifest.json`, files, logs or results. Keys reach the program through setup and Accounts,
  as environment variables; sign-ins as Scient's cookie files. Never ask for a key in chat.
- **The user's own account, used fairly.** Only their account, for their own use. Respect the
  site's terms; if they forbid automated access, say so and stop. Be polite: pace requests,
  back off when limited, identify honestly. Send the browser's user agent only with the
  user's own sign-in session (`SCIENT_SIGN_IN_USER_AGENT`), never to get past a bot check.
- **Never get past a captcha or 2FA yourself.** Hand it to the user.
- **Read first.** Explore by reading. Ask the user before any request that changes data
  (submit, post, delete, enroll, pay), while studying and when testing.
- **No captures with secrets.** Never save request captures, HAR files, cookies or page dumps
  in the connector or the project. Use masked or made-up values in notes and tests.

## References

- `references/tool-design.md`: when planning or changing tools (names, schemas, results,
  paging, errors, annotations).
- `references/auth-and-sessions.md`: when the connector needs a key, OAuth, or the user's
  sign-in to a website, and how it stays signed in.
- `references/study-a-website.md`: before building for a site with no documented API.
- `references/science-apis.md`: when using OpenAlex, NCBI, arXiv, Crossref, Semantic Scholar,
  ClinicalTrials.gov, Zotero, Moodle or a similar service.
- `references/local-tools.md`: for local files, databases and command-line tools.
- `references/testing.md`: before calling a connector done.
- `references/fixing.md`: when a connector fails or the user asks to improve one.
- `references/sources.md`: where these methods come from.
- `templates/`: the connector `scient_connector_copy` writes; read its `README.md`.
