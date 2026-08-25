# Droid (Factory) in Scient

[Droid](https://factory.ai) is Factory's coding agent. Scient talks to the `droid` CLI over the same
agent protocol used for other providers, so Droid sessions stream like any other provider's: tool
calls, file edits, and nested Tasks all appear in the thread.

Droid is marked **Early Access** in Scient because its integration is newer than the other providers.
Its provider-specific behaviors and current limitations are documented below.

For the behavior shared by all assisted providers, see [Providers in Scient](./providers.md).

## Setup and account connection

The local desktop app can install a reviewed Droid runtime privately for Scient. A custom binary
path or a healthy system installation is preserved and used as-is; Scient never replaces or
removes it. Managed install, repair, and removal appear only when the runtime is Scient-owned.

Droid supports two existing-account modes:

- **Factory account pairing** (default): choose **Sign in with Factory**. Droid opens its secure
  browser flow itself. Factory owns the browser, callback, and credential store; Scient receives no
  password or token and does not invent or parse a sign-in URL.
- **`FACTORY_API_KEY`** (advanced): when this environment variable is configured before Scient
  starts, Droid uses it directly. The key is passed to the CLI only and is never displayed by
  Scient. Interactive account actions are hidden because they cannot manage an environment-owned
  key.

You can still point Scient at an existing binary under **Settings > Providers > Droid > Binary
path**. With no custom path, Scient preserves a healthy `droid` found on the app's `PATH`; otherwise
it can offer the reviewed app-private runtime.

## Enabling Droid

1. Open **Settings > Providers** and enable **Droid**, or pick Droid from the composer's provider
   rail.
2. If Droid is missing, choose **Install** and review the official artifact before continuing.
3. Choose **Sign in with Factory**, finish the provider-opened browser flow, and wait for Scient to
   verify the connected account.
4. When Droid reports **Ready**, pick a model and start a thread.

Repair downloads and verifies a fresh reviewed copy before atomically replacing Scient's managed
runtime. Remove deletes only that app-private copy; neither action changes Factory credentials,
custom paths, or system installations. **Sign out** appears only if the exact running Droid version
advertises ACP logout. When it does not, Scient hides the action instead of offering an unreliable
terminal-automation fallback.

## Models and reasoning effort

Droid advertises its model list itself; Scient does not hardcode one. You can change models within
an existing thread: Scient applies the new model before the next turn and waits for Droid's
authoritative configuration update before sending your message. Selecting a reasoning effort sets
Droid's model-specific effort option the same way. Effort choices come from the selected model's own ladder:
during discovery Scient briefly selects each model to read the ladder that model actually supports,
so what you see matches the CLI. If that per-model walk fails or times out, models stay listed with
an unknown effort surface rather than a wrong list. Each model option's description may also carry
a factory-token cost label (for example `0.5×`), which Scient shows next to the model name.

Factory custom (`custom:`) models follow the same live-capability rule: when Droid advertises a
reasoning-effort ladder for the selected custom model, Scient shows it and applies the selected
value before the turn. Scient does not guess a ladder for custom models that expose none.

## Autonomy modes

Scient's permission modes map onto Droid's graduated autonomy ladder:

| Scient mode       | Droid autonomy |
| ----------------- | -------------- |
| Approval required | `normal`       |
| Auto-accept edits | `auto-low`     |
| Auto              | `auto-medium`  |
| Full access       | `auto-high`    |

The mode is applied per turn; changing it mid-thread takes effect on the next message. Scient's
runtime-mode mapping is exhaustive, so adding a new Scient mode requires an explicit Droid mapping
at compile time instead of silently choosing an autonomy level.

## Behavior notes and limitations

- **Checkpoints / rollback is not supported.** Droid's ACP surface does not expose a revert
  operation, so the rollback action is unavailable in Droid threads.
- **Steering** works by sending your follow-up message into the running turn; the adapter counts
  prompts so steering never collides with turn bookkeeping.
- **Structured questions** from Droid appear in Scient's normal user-input prompt and resume the
  turn after you answer.
- **Idle watchdog**: if a Droid turn produces nothing (no events at all) for 10 minutes, Scient
  cancels it so the thread never hangs forever. Threads using nested Tasks get a 60-minute ceiling
  instead. Tune the idle limit with `SCIENT_DROID_TURN_IDLE_TIMEOUT_MS` (milliseconds).
- **Quota**: Droid usage draws on your Factory plan. If the CLI reports an out-of-quota or
  payment-required error, the turn fails with that message and you can retry after topping up or
  waiting for the quota window.
- **External runtime maintenance stays external.** Scient can repair or remove only its own
  app-private runtime. Update a custom or system Droid installation with the tool that installed it.
