# Cursor in Scient

Cursor runs through the bundled official Cursor SDK. Enable it in **Settings > Providers**
and sign in with your Cursor account, or configure `CURSOR_API_KEY` on the environment that
runs the provider. Each Scient provider instance keeps its own credential; your Cursor editor
and CLI login are separate.

For shared account controls, see [Providers in Scient](./providers.md). For execution capabilities
and limitations, see [Cursor](./cursor.md).

## Sign in and sign out

Choose **Sign in to Cursor** and complete the official browser flow. Scient validates the
authorization URL and opens it once. **Reopen Cursor sign-in** opens that same page while the
operation is active. The provider becomes ready after its account and model checks succeed.
There is no pasted-code step.

Cancelling sign-in stops that SDK login attempt. Closing the details card keeps the attempt
running; reopen it through the provider's progress or Manage control.

A configured `CURSOR_API_KEY` owns SDK authentication instead of the browser flow. Sign-out stops
that instance's running sessions and forgets its saved browser credential while preserving
conversation history. To revoke the generated key before expiry, remove it in Cursor's API-key
dashboard.

## Separate Cursor CLI management

The Cursor CLI controls manage the retained CLI integration. Installing, updating, repairing,
removing, or selecting a CLI copy does not change the bundled SDK used for V2 conversations.
A missing CLI does not prevent SDK sign-in or execution.

Scient preserves explicit custom paths and healthy system installations. Supported local desktop
platforms can offer a qualified private CLI copy. Managed actions affect only that private copy;
they never overwrite or remove a custom or system installation. An explicitly configured external
CLI retains Cursor's own update command. The default bundled SDK has no CLI update command.

## Troubleshooting

- **Browser did not open:** use **Reopen Cursor sign-in** while the flow is active.
- **Unexpected account:** check whether `CURSOR_API_KEY` overrides browser login.
- **CLI needs repair:** repair the private CLI copy; a failed repair preserves the previous working copy.
- **Custom CLI setup:** check the configured binary path and CLI endpoint settings. Those settings
  do not select the SDK executable or override its endpoint. Legacy CLI tokens do not supply SDK credentials.
