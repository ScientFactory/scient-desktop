# Credentials and sessions

For API keys and tokens, declare a sensitive string in the manifest's `user_config` and map it into `server.mcp_config.env`; that is the only home for a secret (never args, code or project files). The connector starts and lists tools without credentials, and protected handlers return `needsSetup`. Set `required: true` only when the connector is useless without the key. The user enters keys through `scient_connector_setup`, not chat or `request_secret`.

For a new API that needs a key: check startup and the setup-message path in the folder, save the connector, complete setup, then inspect a real read on the installed connector. A folder check can't accept a new key. Use `replaceKeys` only with evidence the key was rejected; an ordinary 403 can mean access denied or policy rather than a bad key.

For a website session, declare `_meta["com.scientfactory.scient"].signIn.site` as its origin; setup links an Accounts sign-in. `scient_connector_check {folder, signIn, calls}` tests an unsaved folder with that account; after saving, use `connector`. With no account yet, add one with `scient_account_add` (website or university sign-in). A declined or timed-out card ends setup for this turn; report it once.

The session helper receives `SCIENT_SIGN_IN_SITE`, private cookie-file paths and a browser user agent. Hold cookies, CSRF and session tokens in memory only, and trace where each token comes from; never copy them into the connector, logs, fixtures or results. Sign-in happens through Scient's Accounts flow, including any human-only challenge; the connector itself never posts password forms.

Detect expiry from the site's observed signed-out response; a generic 403 isn't enough. The `SCIENT_SIGN_IN_EXPIRED` marker makes the host sign in and replay the call, so emit it only for a read that is known safe to repeat. A write with an uncertain outcome needs a readback, not a replay. Test expiry with synthetic responses.

Bind credential-bearing requests to the intended origin. The inherited session helper strips standard authorization headers on redirects, but not custom secret headers: with custom credentials, either follow no cross-origin redirects or implement and test an explicit origin allowlist, and stop unexpected redirects before sending. The browser user agent is for compatibility, never for passing a bot check.

For OAuth-only APIs the template has no OAuth lifecycle. Use a vendor-hosted MCP connector, a supported package's OAuth flow or a service-issued personal token, and report the limitation if none fits. Password grants and stored client secrets are out of bounds.
