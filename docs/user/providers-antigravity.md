# Antigravity in Scient

Scient integrates Google's Antigravity CLI (`agy`) as a first-class coding provider. It supports a
reviewed app-private installation, sign-in with an existing Google account subscription, live
streaming, multi-turn conversations, model discovery, and structured Git-writing helpers.

Scient does not ask for your Google password, read token contents, or store Google tokens. The
official Antigravity CLI opens and completes sign-in, keeps the resulting session in its own local
credential store, and refreshes it when necessary.

## Assisted setup

Select **Antigravity** in the first-provider setup or model picker.

1. If `agy` is missing, choose **Install Antigravity**. On supported desktop targets, Scient
   downloads a pinned official Google release into the app's private runtime directory, verifies
   its exact size and SHA-512 digest, smoke-tests it, and only then activates it. This does not
   modify your shell profile or system package manager.
2. Choose **Sign in with Google**. Scient launches the official interactive `agy` client in a
   supervised terminal. Antigravity opens Google's sign-in page, or reuses a valid session already
   present in Antigravity's local credential store.
3. Complete sign-in with the Google account that has the subscription you want to use. If Google
   shows a one-time authorization code, paste it into Scient. Scient returns it directly to the
   waiting Antigravity process, then asks `agy models` to verify the account and discover the models
   actually available to it.

If managed installation is unavailable, Scient shows Google's official platform installer command.
You can also set an explicit `agy` binary path in **Settings > Providers > Antigravity**.

## Subscription boundary

This integration intentionally uses Antigravity's normal Google-account authentication path. Scient
does not forward ambient API-key or custom-endpoint environment variables to Antigravity, so an
unrelated developer key cannot silently replace subscription-backed usage or billing.

If your standalone Antigravity installation is explicitly configured for API-key mode, remove that
provider override as described in Google's Antigravity authentication documentation before using it
with Scient. The app will otherwise report that it could not verify a connected Google account.

Signing out first sends Antigravity's own `/logout` command. Some CLI releases incorrectly block
that command behind first-run screens even when a consumer session already exists. When that
happens, Scient removes Antigravity's private `antigravity-oauth-token` file and, on macOS, the exact
`gemini` Keychain item used by this CLI build. It then confirms with `agy models` that the account is
disconnected. This may also sign out other local applications using the same Antigravity credential
store.

## Models and reasoning

The model list is account-owned and dynamic. Scient does not hard-code a claim that every account
has the same models. It reads the current `agy models` result, groups effort variants into one model,
and presents available **Low**, **Medium**, and **High** reasoning choices where supported.

Scient prefers `gemini-3.7-flash` when the account reports it, then falls back to the next available
model. Changing the model or reasoning effort starts a new Scient thread because those values are
fixed when the native Antigravity process starts.

## Runtime behavior

Each active Scient thread owns one persistent `agy` process using Antigravity's documented
`stream-json` input and output. This keeps the native conversation warm across turns and streams
assistant deltas, tool activity, usage, and the provider conversation ID into Scient's canonical
event model. If the process is cancelled or crashes, Scient closes it and resumes the last completed
native conversation in a fresh process on the next turn.

Attachments are copied into a private, session-scoped staging directory and that directory alone is
added to Antigravity's allowed paths. It is deleted with the session. Commit messages, pull-request
content, branch names, and thread titles use Antigravity's native JSON-schema structured output and
are validated before Scient accepts them.

## Permissions and current limitations

Antigravity headless mode cannot pause and relay interactive terminal approval questions to Scient.
In **Full access**, Scient uses Antigravity's documented non-interactive permission bypass. In more
restrictive modes, Antigravity may deny protected commands rather than ask inside the app.

Native Antigravity conversations currently do not support Scient's in-thread model switching,
interactive approval responses, or rollback. The UI reports those operations as unsupported instead
of simulating success.

## Troubleshooting

- **Antigravity is missing:** use the reviewed install action, Google's displayed installer, or set
  the absolute binary path in provider settings.
- **Sign-in did not open:** use **Reopen sign-in page** when Scient captured Antigravity's secure
  authorization URL, or **Open sign-in help** for Google's authentication instructions.
- **Connected but no models:** confirm the chosen Google account has Antigravity access, then retry
  sign-in. `agy models` must succeed and return at least one model before the provider is ready.
- **API-key configuration error:** return the standalone Antigravity CLI to its default account-based
  authentication mode; Scient intentionally does not run this provider with API keys.
- **Broken managed copy:** choose **Repair Antigravity**. A failed repair leaves the previously
  activated healthy version in place.
