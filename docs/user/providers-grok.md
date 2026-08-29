# Grok in Scient

Grok Build is xAI's agent for working with project files, code, and commands.
Scient can use it through an existing Grok subscription or supported API-key
environment. Grok owns the account session and credentials; Scient starts the
official sign-in flow without receiving your password or tokens.

For the behavior shared by all assisted providers, see [Providers in Scient](./providers.md).

## Enable and install

Grok is an Early Access provider and is off by default. Enable it from the provider lifecycle
surface or in **Settings > Providers**.

In the local desktop app, choose **Install** to add Scient's reviewed Grok Build runtime. This copy
lives in Scient's private app data. Repair, update, and remove actions affect only that private copy;
a custom path or system installation is left untouched.

You can instead install Grok Build yourself from [xAI's Grok CLI page](https://x.ai/cli) and set its
binary path in the provider settings when it is not available as `grok` on the server's `PATH`.

## Connect a subscription

Choose **Sign in with Grok** and finish the secure flow in the page Grok opens in your browser. If
that page does not open, Scient keeps an **Open sign-in page** fallback while the flow is active. If
browser callbacks are not convenient, choose **Use device code**, copy the displayed code, and enter
it on Grok's secure page. Scient shows a paste field only when the exact live Grok operation asks you
to return a one-time authorization code.

After completion, Scient shows the email address and subscription tier that Grok reports when that
optional metadata is available. If Grok confirms the account but does not return metadata, the
connection remains ready and is shown as a Grok subscription.

## API-key environments

When `XAI_API_KEY` is configured on the machine running Scient, Grok can be ready through that API
key. Scient labels this separately from a subscription account and offers **Use a Grok
subscription** so you can deliberately start account sign-in. Signing out removes only Grok's
cached account session; it does not remove an environment-provided API key.

## Troubleshooting

- **Grok is disabled:** use the Enable action in the lifecycle surface, or enable it in
  **Settings > Providers**.
- **Browser did not open:** use the sign-in-page action shown while the flow is active, or use the
  device-code option.
- **Sign-in is stuck:** cancel the current flow and start it again. Scient sends cancellation to the
  exact Grok auth request and stops its local process.
- **Runtime needs repair:** repair downloads and verifies a fresh reviewed copy before atomically
  replacing the private runtime. The previous working copy remains available until verification
  succeeds.
- **System or custom install:** run `grok login` or `grok logout` on the machine running the Scient
  server when you need manual recovery.
