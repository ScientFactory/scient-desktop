# Cursor in Scient

Scient can use the official Cursor Agent CLI with an existing Cursor account. Cursor owns the
account session and credentials; Scient starts Cursor's official browser flow and verifies the
result without receiving your password or tokens.

For the behavior shared by all assisted providers, see [Providers in Scient](./providers.md).

## Enable and install

Enable Cursor in **Settings > Providers** or choose it from the composer's provider rail. Scient
preserves an explicit custom binary path or a healthy `cursor-agent` already installed on the server.
When neither is usable, a supported local desktop can offer a reviewed Scient-managed copy.

Install, update, repair, and remove affect only Scient's private runtime. They never overwrite or
delete a custom or system Cursor installation. If a healthy system runtime is active and
**Use Scient-managed Cursor** is available, the reviewed private install remains an explicit choice.

## Sign in

Choose **Sign in to Cursor**. Scient asks Cursor not to open a browser itself, validates the official
Cursor authorization URL, and opens that page once. While the operation is active,
**Reopen Cursor sign-in** can open the same validated page again.

Cursor's flow does not accept a code pasted into Scient. After the browser flow finishes, Scient uses
a fresh Cursor account probe before reporting the provider as connected and ready. If Cursor
finishes before returning a page, Scient verifies the completed account directly instead of asking
the user to sign in again.

When an API endpoint, API key, or token configuration owns authentication, Scient does not show an
irrelevant browser sign-in or sign-out action.

## Updates and removal

An active Scient-managed copy uses Scient's reviewed update, repair, and removal path. A custom or
system Cursor installation keeps Cursor's existing external update behavior. Removing the managed
copy preserves the Cursor account and returns eligible default instances to a healthy system runtime.

Signing out first stops affected Cursor sessions, then asks Cursor to revoke its account session. It
does not remove any runtime.

## Troubleshooting

- **Browser did not open:** use **Reopen Cursor sign-in** while the flow is active.
- **Cursor needs repair:** repair the Scient-managed copy; a failed repair keeps the previous working
  copy active.
- **Custom Cursor setup:** verify the configured binary path and any endpoint or token settings in
  the provider's advanced configuration.
- **System installation:** update it with Cursor's own supported updater. Scient-managed controls do
  not modify it.
