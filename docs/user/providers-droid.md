# Droid (Factory) in Scient

[Droid](https://factory.ai) is Factory's coding agent. Scient talks to the `droid` CLI over the same
agent protocol used for other providers, so Droid sessions stream like any other provider's: tool
calls, file edits, and nested Tasks all appear in the thread.

Droid is marked **Early Access** in Scient. It is fully functional but newer than the other
providers, and a few Droid-specific behaviors are documented below.

## Requirements

- A `droid` CLI binary (Factory's `@factory/cli`). Install it with your preferred package manager,
  or point Scient at an existing binary under **Settings > Providers > Droid > Binary path**. If no
  path is configured, Scient resolves `droid` through the environment `PATH` inherited by the app.
- One of:
  - **Device pairing** (default): run `droid` once in a terminal and complete its pairing flow.
    Scient's background ACP sessions are deliberately headless and will reuse that cached sign-in;
    they never open an authentication browser themselves.
  - **`FACTORY_API_KEY`**: if that environment variable is set when Scient starts, Droid sessions
    authenticate with it automatically and no pairing is needed. The key is passed through to the
    CLI only; Scient never stores or displays it.

## Enabling Droid

1. Open **Settings > Providers** and enable **Droid**, or pick Droid from the composer's provider
   rail.
2. Scient runs a quick version check and then starts one background Droid session to sign in and
   discover your available models. When the provider reports **Ready**, pick a model and start a
   thread.
3. If Scient reports Droid as unauthenticated, run `droid` in a terminal and complete pairing (or
   set `FACTORY_API_KEY` and restart Scient), then retry the provider check.

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
- **Maintenance is manual.** Scient does not install or update the Droid CLI for you; update it
  with the same tool you used to install it.
