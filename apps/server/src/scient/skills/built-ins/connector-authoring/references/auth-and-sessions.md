# Keys, sign-ins and staying signed in

Read this when a connector needs a key, a token, an OAuth app, or the user's sign-in to a
website. The rule behind all of it: secrets live in Scient's Accounts. The connector gets
them at start, through its environment, and never stores, prints or asks for them.

## Pick the way in

| The service has                                                                                                     | Use                                    | The program gets        |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------- |
| A public API, no key                                                                                                | Nothing                                | None                    |
| An API key or a personal token (OpenAlex, NCBI, Semantic Scholar, Zotero, GitHub)                                   | A `user_config` key                    | An environment variable |
| A token the user makes in the site's settings (Moodle "security keys", a library's API token)                       | A `user_config` key, same as above     | An environment variable |
| Only OAuth                                                                                                          | See "OAuth APIs" below                 | None                    |
| No API, or an API that works only with the browser's session (most university portals, library sites, course sites) | A website sign-in (`signIn`)           | Cookie files            |
| Files or a database on this computer                                                                                | Settings of type `directory` or `file` | Paths                   |

## API keys

Declare the key in `manifest.json` and map it to an environment variable. Keys go in `env`
only; Scient refuses a key in `args`, where other programs could read it.

```json
"user_config": {
  "api_key": {
    "type": "string",
    "title": "NCBI API key",
    "description": "Optional. Make one in your NCBI account settings; it raises the limit to 10 requests a second.",
    "sensitive": true,
    "required": false
  }
},
"server": {
  "type": "node",
  "entry_point": "server.mjs",
  "mcp_config": {
    "command": "node",
    "args": ["${__dirname}/server.mjs"],
    "env": { "NCBI_API_KEY": "${user_config.api_key}" }
  }
}
```

- `sensitive: true` with `type: "string"` makes it a key: Scient keeps it in Accounts (an
  API-key account linked to the connector), not in the connector's settings.
- `required: true` when nothing works without it. A connector with a missing required key is
  still added; it shows Needs setup, and its tools tell the agent to run setup.
- In code: `const key = process.env.NCBI_API_KEY?.trim() ?? "";`. An unanswered optional key
  arrives as an empty string.
- Start and list tools without the key. The tools that need it throw
  `needsSetup("The NCBI API key")` (from `mcp.mjs`).
- Send it in a header when the API allows (`Authorization: Bearer …`, `x-api-key`), not in the
  URL. If it must go in the URL, use `safeUrl()` for anything you log or return.
- When the API refuses the key (401, or 403 with an "invalid key" body), say so: "The key
  was refused. Call scient_connector_setup with replaceKeys."
- After `scient_connector_save` returns `needs-setup`, call
  `scient_connector_setup {connector}`. Each key opens a private card where the user pastes it,
  or links a key they already saved. Never ask for a key in chat and never use
  `request_secret` for a connector key.

Plain settings (a site address, a default folder) are `user_config` fields without
`sensitive`. Ask the user in chat, then pass them as `settings` to `scient_connector_setup`.

## Website sign-ins

For a site the user signs in to with a username and password (often with an authenticator
code or a university single sign-on).

### Declare it

```json
"_meta": {
  "com.scientfactory.scient": {
    "signIn": { "site": "https://moodle.example.edu" }
  }
}
```

`site` is the origin only (`https://` and the host, no path). Setup lists the sign-in as missing until the user
links it to an Accounts website or university sign-in for that site. `scient_connector_setup`
offers that.

### What the program gets

| Variable                     | Holds                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCIENT_SIGN_IN_SITE`        | The site's origin.                                                                                                                                                                                         |
| `SCIENT_SIGN_IN_COOKIES`     | Path to a JSON file: `[{name, value, domain, path, expires, secure, httpOnly, sameSite}]`.                                                                                                                 |
| `SCIENT_SIGN_IN_COOKIES_TXT` | The same cookies in Netscape format, for curl (`-b`) or Python (`http.cookiejar.MozillaCookieJar`).                                                                                                        |
| `SCIENT_SIGN_IN_USER_AGENT`  | The user agent of the browser the cookies came from. `session.mjs` sends it with the session, because some sites end a session that arrives from another browser. Use it only with the user's own session. |

The files are private, rewritten at each start and after each new sign-in, and removed with the
connector. The program never gets the password: Scient signs in, not the connector.

### Use it

```js
import { createHttp } from "./http.mjs";
import { createSession } from "./session.mjs";

const http = createHttp({ userAgent: "moodle-connector/0.1 (Scient connector)", minGapMs: 500 });
const session = createSession({ http });

// In a handler:
const data = await session.json("/webservice/…", {}, { signal });
const page = await (await session.fetch("/my/courses.php", {}, { signal })).text();
```

`session.fetch` reads the cookie file (again when Scient rewrites it), sends only the cookies
that belong to each host, keeps cookies the site sets while it runs (sessions that refresh on
each request), follows redirects itself, and throws the expired error when the session is gone.
Pass headers as a plain object.

### Know when the session has ended

`session.fetch` treats these as ended:

- a redirect to a sign-in page (paths like `/login`, `/signin`, `/sso`, `/saml`,
  `/cas/login`, `/idp/`, or hosts like `login.microsoftonline.com`);
- status 401 (and 419 or 440, used by some frameworks);
- an HTML page with a password field where data was expected.

Tune it for the site, after you have seen what the site sends a signed-out visitor (open the
same URL in a tab without the sign-in, or look at the response right after the session ends):

- `loginPath`: a regular expression for the site's own sign-in path, when it differs.
- `isSignedOut(response, body)`: a site-specific check, e.g. a JSON body with
  `"errorcode":"requireloginerror"`.
- `forbiddenMeansExpired: true` only for a site known to send 403 when the session ends. By
  default a 403 means "no access to this", which a new sign-in would not fix.

Throw `signInExpired(site, why)` yourself for any other sign. The tool error then starts with
`SCIENT_SIGN_IN_EXPIRED`. Only use it for a real end of session: each one makes Scient sign in
again, and a false one ends with the user being asked to sign in for nothing.

### What happens then

Scient sees the marker, signs the account in again in its own browser profile with the saved
username, password and authenticator code, rewrites the cookie files, restarts the program,
and retries the call once. The agent sees the retried result.

If the site needs the person (a captcha, a text-message code, a new device check), the agent
sees "<site> needs you to sign in: open Settings → Accounts, or the connector's page", and the
connector shows Needs sign-in with a Sign in button. Tell the user exactly that, once. Don't
retry in a loop.

### Tokens inside pages

Many sites also need a value from a page: a CSRF token, Moodle's `sesskey`, a request id.

- Get it from the page or API that hands it out (`session.fetch` the page, read it from the
  HTML or embedded JSON), keep it in memory for this run, and get it again when the site says
  it is invalid.
- Never write it to a file and never return it in a result.

### Never

- Read, ask for, type or store the user's password, authenticator secret or one-time codes in
  the connector. Scient does the signing in.
- Sign in from the connector (posting the login form). It skips the user's saved
  authenticator, trips bot checks, and can lock the account.
- Copy cookies into the connector's folder, a test file, a log or a result.
- Send cookies to any host but the site's own (`session.fetch` doesn't).
- Keep sessions alive with pings or background loops. Scient signs in again when needed.

### While building

A folder you haven't saved can still be checked signed in. The order that works:

1. Study the site in Scient's browser, signed in with `scient_account_sign_in` or by
   `preview_open` with a saved sign-in (`study-a-website.md`).
2. Check without a sign-in first: the program must start and list its tools, and a tool call
   must return the "no sign-in yet" message, not crash.
3. Check signed in: `scient_connector_check {folder, signIn, calls}`, where `signIn` is the name
   of the user's Accounts sign-in for the site (`scient_accounts_list` shows it). If they have
   none, `scient_account_add` with kind `website` asks them to add one. Fix until real calls
   return real data.
4. Save. If the result is `needs-setup` with the sign-in missing, call
   `scient_connector_setup {connector}`, which links the sign-in. After that,
   `scient_connector_check {folder, connector, calls}` uses the connector's own sign-in.

`scient_account_browser_session` exports a site's cookies to private session files for curl
while you study. Use it for reading requests only, and never copy those files anywhere.

## OAuth APIs

The template doesn't support OAuth yet: a connector made from it gets its credentials from
the environment and can't run an OAuth sign-in or keep one fresh. A package connector (npm or
PyPI) that runs its own OAuth sign-in can be added and used as it is.

1. Prefer a personal access token or API key if the service offers one (GitHub, GitLab,
   Zotero, Zenodo, Figshare and many others do). Treat it as a key.
2. If the vendor runs its own remote MCP server, suggest adding that in Extensions instead: it
   signs in with OAuth through Scient.
3. If the site works in the browser, a website sign-in may reach the same data.
4. If none of these fit, tell the user plainly that a connector made with the template
   can't sign in to this service yet, because it offers only OAuth. Don't embed a client
   secret, and never use the user's password to get a token (the "password grant").

## Local files, databases and programs

They need settings, not secrets: see `local-tools.md`. A database password is still a key
(`sensitive: true`, in `env`).
