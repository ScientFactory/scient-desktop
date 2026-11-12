# Study a website that has no documented API

Read this before building a connector for a site whose data the user sees in the browser
but no public API offers. The goal is the smallest set of the site's own requests that
returns the data the user wants, understood well enough to make it reliable, without changing
anything on the site.

## Rules for the whole study

- Only the user's own account, for their own use. Read the site's terms of use; if they forbid
  automated access, tell the user and stop. A general policy that doesn't cover the site isn't
  its terms: when unsure, tell the user what you found and let them decide.
- Read, don't change. Open pages, list and replay reading requests only. Before anything that
  could change data (submit, post, enroll, delete, mark read, pay), ask the user.
- Never get past a captcha, a 2FA prompt or a "verify you are human" page yourself. Hand it to
  the user: `scient_account_sign_in` waits while they do it.
- Go slowly: a pause between replays (half a second or more), no loops over many pages while
  studying.
- Keep secrets out of everything you write. `preview_network` hides cookies, tokens and
  `Authorization` values; don't copy any value you do see into notes, code, tests or chat
  summaries. Never save request captures or HAR files in the project or the connector.

## The tools

| Tool                               | Use it to                                                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview_open`, `preview_navigate` | Open the site in Scient's browser. `preview_open` signs in by itself with a saved sign-in; read its `accountsNote`.                                                                                         |
| `scient_account_sign_in`           | Sign in on your tab with the user's saved account, including authenticator codes. Returns `needs-user` when the person must act.                                                                            |
| `scient_account_find_profile`      | Find a browser profile already signed in to the site.                                                                                                                                                       |
| `preview_snapshot`, `preview_act`  | Read the page and click, type or choose, like the user would.                                                                                                                                               |
| `preview_network`                  | List the tab's recent requests (method, URL, status, type, time); with a request id, see its headers, request body and response body. Secrets are masked. Large bodies go to a file whose path is returned. |
| `preview_evaluate`                 | Run a small script in the page: read in-page config, list script URLs, or `fetch()` a reading request with the page's own cookies.                                                                          |
| `scient_account_browser_session`   | Export the site's cookies to private files for curl, for reading requests only.                                                                                                                             |

## The method

### 1. Say what data you need

Write the goal as data, not clicks: "my assignments due in the next 14 days: course, title,
due time with time zone, submitted or not". This tells you when you are done.

### 2. Look for a front door first

A documented way in is more stable than anything you find in the page. Check, in order:

- The site's or vendor's API docs and developer pages (search "<site or product> API"). Many
  campus systems are known products with APIs: Moodle web services, Canvas REST, Blackboard
  REST, Alma, Primo, DSpace, Pure, Figshare, Dataverse.
- A vendor MCP server or an existing connector (Extensions → Discover).
- Machine-readable descriptions on the site: `/openapi.json`, `/swagger.json`,
  `/v3/api-docs`, `/.well-known/openapi.yaml`, `/api/docs`.
- GraphQL: a `/graphql` endpoint that answers an introspection query (a reading POST).
- Feeds and exports: iCal calendar links (deadlines often have one), RSS, CSV or BibTeX
  exports, OAI-PMH for repositories.
- `robots.txt` and the sitemap, for the site's layout and what it asks of automated visitors.

If one of these gives the data, use it and skip the rest.

### 3. Watch the sign-in once

Open the sign-in page with nothing signed in, then sign in (`scient_account_sign_in`) and list
the requests. Note which responses set cookies, where the browser lands, and whether a token
goes into page storage. Then note what a signed-out visitor gets from a data URL: a redirect,
a 401, a login form, or a JSON error. That is the shape your connector must recognise as
"session ended".

### 4. Do the task by hand, twice

With the user's goal in mind, do it in the browser with `preview_act`: open the course,
filter the dates, page to the next set. Then do it again with different inputs (another
course, other dates). After each run, list the requests with `preview_network`.

Skip the noise: analytics and tracking, ads, fonts, images, style sheets, heartbeats and
polling, error reporting.

### 5. Find the request that carries the data

Open the likely requests by id and read their response bodies. The data is usually JSON from an
`/api/`, `/ajax/` or `service.php` URL, sometimes an HTML fragment, sometimes JSON embedded in
the page (`__NEXT_DATA__`, `application/ld+json`, a `window.__STATE__` object).

Compare the two runs: what changed in the URL, query or body are the inputs; what stayed the
same are constants or session values.

### 6. Trace every value back to where it came from

For each value in that request that isn't an input (an id, a CSRF token, a `sesskey`, a
signature, a version hash), find what produced it: an earlier response body, the page HTML,
in-page config (read it with `preview_evaluate`, e.g. `window.M?.cfg?.sesskey` on Moodle), or a
cookie. Repeat for those requests until only the cookies are left. Write the chain down:

```
GET /my/                      → sesskey (in page config)
POST /lib/ajax/service.php?sesskey=…&info=core_calendar_get_action_events_by_timesort
     body: [{"methodname":"core_calendar_get_action_events_by_timesort","args":{…}}]
                              → events
```

A value you can't trace may live in local storage, IndexedDB or a service worker, or be
computed by the page's script. Look before guessing.

### 7. Replay reading requests

- GET only, unless the request clearly only reads: a GraphQL `query` (not a `mutation`), a
  search POST, a Moodle `get_…` function. Ask the user when unsure.
- Fastest first test: `preview_evaluate` with `fetch(url, {credentials: "include"})` in the
  page, which uses the page's own cookies and origin.
- Then outside the browser, the way the connector will run: through `scient_connector_check`
  once the sign-in is linked (`auth-and-sessions.md`, "While building"), or with curl and the
  files from `scient_account_browser_session`.

### 8. Strip it down

Remove headers one at a time (`Referer`, `Origin`, `X-Requested-With`, custom `X-…`, `Accept`)
and replay. Mark each one required (the answer breaks), affects (the answer changes) or not
needed. Keep the required ones and an honest `User-Agent`. Don't try to imitate a browser's
fingerprint.

### 9. Check against what the page shows

The data must match the page: the same number of rows, and spot-check three items, including a
date (time zones), a name with non-English letters, and an empty case (a course with nothing
due must come back as empty, not as an error). Read field types from real answers (ids are
often strings). Don't write a field into the connector that you haven't seen in a real answer.

### 10. Write down the map

In the connector's `README.md`, under "How it talks to <site>": each request it uses, its
inputs, where each token comes from, what "signed out" looks like, the date you looked, and
which requests you saw work (confirmed) or only read about in the page's code (unverified).
No values. This makes the next fix fast (`fixing.md`).

## Hard cases

| You see                                            | Do                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A signature header or timestamp computed by script | List the page's scripts (`preview_evaluate`: `[...document.scripts].map(s => s.src)`), fetch the bundle, search it for the header name, and re-create it only if it is a plain hash of the request. If it hides a secret key, stop and tell the user. |
| GraphQL                                            | One URL for everything: tell requests apart by `operationName`. Persisted queries send a hash instead of the query; the hash changes when the site updates, so record it and expect fixes.                                                            |
| WebSockets or server-sent events                   | `preview_network` doesn't show their messages. Look for a plain request that gives the same data (often there is one for the first load).                                                                                                             |
| Binary bodies (protobuf, gRPC-web)                 | Look for a JSON variant or another page. Don't build on bytes you can't read.                                                                                                                                                                         |
| Infinite scroll                                    | Find the request that loads the next part and its cursor or offset; that becomes the tool's paging.                                                                                                                                                   |
| Only HTML, no data requests                        | Parse the HTML narrowly: stable ids, `data-` attributes, table headers. Check it on two pages. Prefer an export or feed if the site has one.                                                                                                          |
| A bot check, a block page, or many 429s            | Stop. Don't work around it. Tell the user; the site doesn't want automated access this way.                                                                                                                                                           |
| A sign-in that only the person can pass every time | Tell the user the connector will often need them to sign in; ask if that is still useful.                                                                                                                                                             |

## Done when

- [ ] Each of the user's tasks maps to one or a few traced, confirmed reading requests.
- [ ] You know what "signed out" looks like for each.
- [ ] Inputs, constants and session values are told apart; every token's origin is known.
- [ ] Results were checked against the page.
- [ ] The map is in the README, with no secrets.
