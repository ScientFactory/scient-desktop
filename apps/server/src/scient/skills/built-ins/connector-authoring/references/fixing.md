# Fixing a connector

Read this when a connector stopped, fails a tool call, returns wrong data, or the user asks to
improve one. The aim is the smallest change that makes it work again, checked the same way it
failed.

## 1. Get a copy and the facts

`scient_connector_copy {connector}` copies it to `connectors/<slug>/` in this chat's folder and
returns its status, the last error and the recent log (keys removed). Work only on that copy.
Read `manifest.json`, the README (its request map and test questions, if any) and the code.

## 2. Reproduce it

Run `scient_connector_check {folder, connector, calls}` with `connector` set, so the check uses
the user's settings, keys and sign-in, and with the call that failed. A fix you can't reproduce
is a guess: if it doesn't fail now, say so, and look in the log for when and how it failed.

## 3. Find the cause

| What you see                                                                                 | Likely cause                                                                                           | Fix                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `Cannot find module …`                                                                       | `entry_point` or `args` name a file that isn't there                                                   | Point them at the real file; keep `${__dirname}/…`.                                              |
| `SyntaxError: Cannot use import statement` or `Unexpected token 'export'`                    | ES module code in a `.js` file without `"type": "module"`                                              | Use `.mjs`, or add a `package.json` with `"type": "module"`.                                     |
| `fetch is not defined`, or other missing built-ins                                           | An old Node on PATH runs it                                                                            | Use `server.type: "node"` with `command: "node"`, so Scient runs it on its own Node.             |
| A missing package                                                                            | Its `node_modules` isn't in the folder                                                                 | Install inside the folder, or remove the dependency.                                             |
| It exits at once with no error                                                               | It writes to stdout, exits when a key is missing, or crashes on start                                  | Logs to stderr only; start without keys; read the log.                                           |
| Every call gets 401                                                                          | The key changed or was revoked                                                                         | `scient_connector_setup {connector, replaceKeys: […]}`.                                          |
| `SCIENT_SIGN_IN_EXPIRED` on every call, or "needs you to sign in" when the user is signed in | False alarm: a 403 for "no access", a page that has a password field, a changed sign-in path           | Tighten the check: `loginPath`, `isSignedOut`, `forbiddenMeansExpired` (`auth-and-sessions.md`). |
| "needs you to sign in"                                                                       | The site wants the person (captcha, text code)                                                         | Tell the user to sign in from Accounts or the connector's page. Nothing to fix in code.          |
| 404, a changed JSON shape, empty results that used to be full                                | The site changed                                                                                       | See "When the site changed".                                                                     |
| 429 or blocked                                                                               | Too many requests                                                                                      | Slow down (`minGapMs`), fetch less, cache.                                                       |
| Time-outs                                                                                    | Pages too big or a slow endpoint                                                                       | Smaller pages, a longer `timeoutMs` for that call only.                                          |
| Fails only on Windows                                                                        | Paths joined by hand, CRLF line endings in parsing, a `.cmd` or `.bat` program started without a shell | Use `node:path`, split lines on `/\r?\n/`, and see `local-tools.md` for starting programs.       |
| JSON parse errors                                                                            | The site sent HTML: an error page, maintenance, or the sign-in page                                    | Check the content type first (`readJson` and `session.json` do).                                 |

## 4. When the site changed

1. Do the task by hand in Scient's browser and list the requests (`study-a-website.md`).
2. Compare with the request map in the README: renamed paths, new required parameters, a new
   token, a new GraphQL hash, renamed fields.
3. Change only what moved. Update the map and its date.

## 5. Keep the fix small

- Change what broke, nothing else. No rewrites, no new style, no renamed tools.
- Keep tool names, parameters and result fields: agents and skills depend on them. If a
  result must change, add a field rather than rename one.
- Bump `version` in `manifest.json` (the last number for a fix).

## 6. Check, then save

- Check again with the call that failed and the calls that worked before.
- `scient_connector_save {folder, connector}`. Scient checks it, swaps it in, restarts it and
  keeps the old version; the connector's page has **Undo last change**.
- A connector someone else published (a vendor's bundle) is never changed in place: your fix
  becomes the user's own copy, shown as "Your copy of …". Tell the user that updates from the
  publisher won't reach this copy, and suggest reporting the problem to them if it is public.

## 7. Tell the user

What broke, what you changed (a line or two), how you checked it, and that Undo is on the
connector's page.
