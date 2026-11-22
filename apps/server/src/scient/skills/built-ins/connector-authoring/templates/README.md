# {{DISPLAY_NAME}}

A connector for Scient: a small program that gives agents tools for one service. As it
comes, it contains an OpenAlex example. Verify current API access with a real read before
calling it working. Change it into the connector you need.

It needs nothing installed. Scient runs it on its own copy of Node, on macOS, Windows and
Linux. It also runs on Node 20 or newer, and in Claude Desktop when exported as `.mcpb`.

## Files

| File            | What it is                                                                              |
| --------------- | --------------------------------------------------------------------------------------- |
| `manifest.json` | Name, how to start it, settings and keys it asks for, its tools. MCP Bundle format.     |
| `server.mjs`    | The tools. This is the file you change.                                                 |
| `mcp.mjs`       | The MCP side: messages over stdin and stdout, input checks, errors. Usually left as is. |
| `http.mjs`      | Polite web requests: pacing, timeouts, read retries, omitted response bodies.           |
| `session.mjs`   | The user's sign-in to a website, from Scient's Accounts. Delete it if unused.           |

## Placeholders

`scient_connector_copy` fills these in `manifest.json` and this README:

| Placeholder        | Filled with                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `{{NAME}}`         | The program name: lowercase letters, digits and dashes, e.g. `moodle-huji`. Agents see its tools under this name. |
| `{{DISPLAY_NAME}}` | The name people see, e.g. "HUJI Moodle".                                                                          |

## Make it yours (for the agent)

1. In `server.mjs`, replace `search_works` and `get_work` with tools shaped like the user's
   tasks. Keep each tool's `inputSchema` strict and its result short.
2. In `manifest.json`, set `description`, the `tools` list (names and one-line descriptions,
   the same as in `server.mjs`), and `user_config` for the settings and keys it needs.
   Change `version` when you change behaviour.
3. Check it with `scient_connector_check` and real sample calls, then save it with
   `scient_connector_save`. The `connector-authoring` skill has the details.

### A key

In `manifest.json`, declare it and hand it to the program through the environment:

```json
"user_config": {
  "api_key": { "type": "string", "title": "Example API key", "description": "Where to get it.", "sensitive": true, "required": true }
},
"server": { "mcp_config": { "command": "node", "args": ["${__dirname}/server.mjs"], "env": { "EXAMPLE_API_KEY": "${user_config.api_key}" } } }
```

In `server.mjs`, read `process.env.EXAMPLE_API_KEY`. When it is empty, start anyway and have
the tools that need it `throw needsSetup("The Example API key")`. Never put a key in a file,
in `args`, or in a message.

### A website the user signs in to

Add the site to `manifest.json`:

```json
"_meta": { "com.scientfactory.scient": { "signIn": { "site": "https://moodle.example.edu" } } }
```

Then use the session in `server.mjs`:

```js
import { createSession } from "./session.mjs";

const session = createSession({ http });
// In a tool handler:
const events = await session.json("/lib/ajax/service.php?…", {}, { signal });
```

`session.fetch` and `session.json` send the user's cookies, follow redirects, and throw the
`SCIENT_SIGN_IN_EXPIRED` error when the site sends them to its sign-in page. For explicitly read-only tools, Scient then signs in
again and retries. The included MCP helper (`mcp.mjs`) suppresses this replay marker for other tools;
check an uncertain write outcome before retrying. The program never sees the password.

### Libraries

Zero dependencies is best: Scient cannot count on npm being on the user's computer. When a
library is truly needed and npm is there, install it inside this folder (`npm install` here,
with a `package.json` that has `"type": "module"`), so `node_modules` travels with the
connector. The official MCP SDK (`@modelcontextprotocol/sdk`) may replace `mcp.mjs` then.

## Run it by hand

`node server.mjs` waits for MCP messages on stdin and logs to stderr. Scient's check
(`scient_connector_check`) is the real test.

## Helper limits

These helpers omit arbitrary response bodies and unexpected exception details from errors.
ToolError strings and deliberate logs must still be written without secrets. `safeUrl` masks
only recognized parameter names. Do not treat it as a general redactor.

`search_works` is offset browsing, not a complete-export tool. At its boundary it returns
`truncated: true` and a reason even when `has_more` is false. `get_work` still caps authors
at 25 and abstracts at 4,000 characters; inspect the omission fields/markers.

Do not use custom secret headers across redirects with the inherited session helper. It only
strips standard authorization headers; an explicit permitted-origin rule needs separate work.
The app's host can replay expiry markers. Only tools honestly marked read-only may emit one;
the included MCP helper blocks it for the other tools. This is not an idempotency guarantee.

Check OpenAlex's current authentication and quota documentation before relying on the
example in a production connector.
