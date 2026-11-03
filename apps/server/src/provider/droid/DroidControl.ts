/**
 * Droid's own session protocol, for operations ACP lacks; ACP keeps owning turns.
 * Droid writes to a session it loads (it records SessionStart hooks), so open a
 * session here only while no ACP process holds it.
 */
import { DroidClient, ProcessTransport, SettingsLevel } from "@factory/droid-sdk/node";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

const DROID_CONTROL_ERROR_TAG = "DroidControlError";
export class DroidControlError extends Data.TaggedError(DROID_CONTROL_ERROR_TAG)<{
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = Predicate.isTagged(DROID_CONTROL_ERROR_TAG);
}

export interface DroidControlClient {
  readonly listSkills: () => Promise<unknown>;
  /** Records the choice in Droid's user-level settings. */
  readonly setSkillDisabled: (skillName: string, disabled: boolean) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface DroidControlInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /** Opens this existing session; otherwise the client starts a new one in `cwd`. */
  readonly sessionId?: string | undefined;
}

export type DroidControlClientFactory = (
  input: DroidControlInput & { readonly signal: AbortSignal },
) => Promise<DroidControlClient>;

type SdkResult<Response> = Response extends { readonly result: infer A } ? A : never;

/** SDK calls answer with either a result or an error; an error rejects. */
function unwrap<Response extends object>(response: Response): SdkResult<Response> {
  if ("error" in response && response.error) {
    throw new Error((response.error as { readonly message: string }).message);
  }
  return (response as unknown as { readonly result: SdkResult<Response> }).result;
}

// The SDK's high-level createSession requires FACTORY_API_KEY and loses subscription-login
// support. Its transport and protocol client keep the existing login, SDK framing and cleanup.
const liveDroidControlClient: DroidControlClientFactory = async (input) => {
  const transport = new ProcessTransport({
    droidExecPath: input.binaryPath,
    cwd: input.cwd,
    // The SDK spreads the server's environment under this one. Undefined
    // entries mask what the agent environment contract removed; Node omits them.
    env: input.environment as Record<string, string>,
  });
  let client: DroidClient | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (client ? client.close() : transport.close()).finally(() => {
      input.signal.removeEventListener("abort", onAbort);
    });
    return closePromise;
  };
  const onAbort = () => {
    void close();
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    await transport.connect();
    // The SDK rejects a failed write through its own promise and leaves the
    // stream's error event unhandled: a Droid that exits before a request is
    // written would end the server with an uncaught EPIPE.
    transport.getManagedProcess()?.childProcess.stdin?.on("error", () => undefined);
    const opened = new DroidClient({ transport });
    client = opened;
    if (input.sessionId) unwrap(await opened.loadSession({ sessionId: input.sessionId }));
    else
      unwrap(await opened.initializeSession({ machineId: "scient-droid-control", cwd: input.cwd }));
  } catch (cause) {
    await close().catch(() => undefined);
    throw cause;
  }
  const connected = client;
  return {
    close,
    listSkills: async () => unwrap(await connected.listSkills()),
    setSkillDisabled: async (skillName, disabled) => {
      unwrap(await connected.setSkillDisabled(skillName, disabled, SettingsLevel.User));
    },
  };
};

/** Opens a control client for `use`, and always closes it. */
export const withDroidControl = <A, E, R>(
  input: DroidControlInput & { readonly purpose: string },
  use: (client: DroidControlClient) => Effect.Effect<A, E, R>,
  makeClient: DroidControlClientFactory = liveDroidControlClient,
): Effect.Effect<A, E | DroidControlError, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: (signal) => makeClient({ ...input, signal }),
      catch: (cause) =>
        new DroidControlError({ cause, detail: `Failed to start Droid for ${input.purpose}.` }),
    }),
    use,
    (client) =>
      Effect.promise(() => client.close()).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Failed to close Droid after ${input.purpose}.`, { cause }),
        ),
      ),
  );

/** Runs one client call, naming what failed. */
export const droidControlCall = <A>(detail: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => new DroidControlError({ cause, detail }),
  });
