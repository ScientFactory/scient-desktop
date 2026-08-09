# Provider full-app lab

Status: local development experiment. This is not product or release behavior.

This lab runs the normal Scient application while replacing only the web client's provider status stream and provider-lifecycle actions with synthetic state. Projects, drafts, Settings, the composer, and the model picker remain the real application surfaces. The lab never inspects provider homes, credentials, PATH, or the stable Scient app, and its lifecycle controller never runs a real installation or sign-in action.

## Checkout

- Worktree: `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-desktop-next-provider-full-app-lab-20260809`
- Branch: `experiment/provider-full-app-lab-20260809`
- Provider implementation base: `849ea2580d9bad07d5499c939b62fe532ada2d24`

## Run in isolation

Use a free port offset and a lab-specific home directory. Do not reuse or stop the stable development app.

```sh
VITE_SCIENT_PROVIDER_LAB=1 \
T3CODE_PORT_OFFSET=531 \
pnpm run dev --home-dir "$PWD/.scient-next/provider-full-app-lab"
```

With offset `531`, the web app is `http://localhost:6264` and its isolated server is `127.0.0.1:14304`. Pair only with the one-time token printed by this server. Never copy a token into documentation or chat.

The floating **Provider simulation** control changes the simulated computer, jumps to a provider state, injects the next failure, or resets the lab. Install and sign-in operations advance automatically so the primary flow can be tried like a real product flow; **Advance** remains available for explicitly loaded in-progress states. Reset and cancellation clear scheduled synthetic work so an old operation cannot change a newly selected state.

Only Codex is synthesized because it is the provider with an implemented assisted lifecycle in this branch. The lab deliberately does not invent equivalent Claude, Cursor, Grok, or OpenCode flows.

## Fresh-provider visual experiment

When the simulated computer has no ready provider, the composer renders the Scient-owned **Choose your AI** onboarding picker. Its default state does not prefer Codex or repeat the provider catalog in the main pane: the provider rail is the chooser, while the main pane gives one short instruction. Searching can surface matching provider rows, and selecting a provider opens its focused setup state. Codex continues into the synthetic assisted lifecycle; providers without an implemented assisted lifecycle route to the real provider settings surface rather than pretending that an automated flow exists.

## Codex lifecycle experiment

The Codex path stays inside the picker instead of opening a second confirmation dialog:

1. **Install Codex** is the user's consent to start a private, verified installation. The backend may still plan and validate the operation, but the user is not asked to confirm the same intent twice.
2. The same compact surface reports preparing, downloading, verifying, installing, testing, and activation progress. Cancellation is available and leaves the simulated computer unchanged.
3. After installation, **Sign in to Codex** starts the provider-owned browser flow. Scient never asks for or stores the provider password, and the sign-in page can be reopened while the flow is active.
4. Scient verifies the account and available models. When the provider becomes ready, the composer returns to the normal inherited model picker with the discovered Codex model selected.
5. Installation and sign-in failures remain in the same surface with a focused retry action. Repair, removal, and advanced troubleshooting remain outside this compact first-run flow.

This is a visual and interaction prototype backed by synthetic lifecycle state. It performs no real download, installation, browser authorization, credential access, or provider request.
