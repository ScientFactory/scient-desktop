# Antigravity in Scient

Antigravity is Google's agent for working with project files, code, commands,
and Git workflows. Scient can manage a private copy of its `agy` tool and
connect it to an existing Google account subscription.

Scient does not ask for your Google password, read token contents, or store Google tokens. The
official Antigravity CLI opens and completes sign-in, keeps the resulting session in its own local
credential store, and refreshes it when necessary.

For the behavior shared by all assisted providers, see [Providers in Scient](./providers.md).

## Assisted setup

Select **Antigravity** in the first-provider setup or model picker.

1. If `agy` is missing, choose **Install Antigravity**. On supported desktop targets, Scient
   downloads and verifies a qualified stable official Google release in its private app data,
   smoke-tests it, and only then activates it. This does not modify your shell profile or system
   package manager.
2. Choose **Sign in with Google**. Scient launches the official interactive `agy` client in a
   supervised terminal. Antigravity opens Google's sign-in page, or reuses a valid session already
   present in Antigravity's local credential store.
3. Complete sign-in with the Google account that has the subscription you want
   to use. If Google shows a one-time authorization code, paste it into Scient.
   Scient then checks the account and discovers the models available to it.

If managed installation is unavailable, Scient directs you to Google's official installer. You can
also set an explicit `agy` binary path in **Settings > Providers > Antigravity**.

## Subscription boundary

This integration intentionally uses Antigravity's normal Google-account authentication path. Scient
does not forward ambient API-key or custom-endpoint environment variables to Antigravity, so an
unrelated developer key cannot silently replace subscription-backed usage or billing.

If your standalone Antigravity installation is explicitly configured for API-key mode, remove that
provider override as described in Google's Antigravity authentication documentation before using it
with Scient. The app will otherwise report that it could not verify a connected Google account.

Signing out first sends Antigravity's own `/logout` command. If the CLI blocks that command behind a
first-run screen, Scient can remove only the provider-owned local consumer credentials needed to
complete logout, without reading token contents. It then verifies that Antigravity reports the
account as disconnected. This may also sign out other local applications using the same Antigravity
credential store.

## Models and reasoning

The model list is account-owned and dynamic. Scient does not hard-code a claim that every account
has the same models. It reads the current `agy models` result, groups effort variants into one model,
and presents available **Low**, **Medium**, and **High** reasoning choices where supported.

Scient selects a default from the models the account reports. Changing the model or reasoning effort
starts a new Scient thread because those values are fixed when the native Antigravity process starts.

## Session behavior

Each thread keeps its Antigravity conversation across turns. If the provider
process crashes or is cancelled, the next turn resumes from the last completed
provider state. Message attachments are made available only to that session and
its temporary copies are removed when the session ends.

## Permissions and current limitations

Antigravity headless mode cannot pause and relay interactive terminal approval questions to Scient.
In **Full access**, Scient uses Antigravity's documented non-interactive permission bypass. In more
restrictive modes, Antigravity may deny protected commands rather than ask inside the app.

Native Antigravity conversations currently do not support Scient's in-thread model switching,
interactive approval responses, or rollback. The UI reports those operations as unsupported instead
of simulating success.

## Troubleshooting

- **Antigravity is missing:** use the qualified install action, Google's official installer, or set
  the absolute binary path in provider settings.
- **Sign-in did not open:** use **Reopen sign-in page** when Scient captured Antigravity's secure
  authorization URL, or **Open sign-in help** for Google's authentication instructions.
- **Connected but no models:** confirm the chosen Google account has Antigravity access, then retry
  sign-in. `agy models` must succeed and return at least one model before the provider is ready.
- **API-key configuration error:** return the standalone Antigravity CLI to its default account-based
  authentication mode; Scient intentionally does not run this provider with API keys.
- **Broken managed copy:** choose **Repair Antigravity**. Repair restores the exact active release,
  and a failed repair leaves the previously activated healthy version in place.
