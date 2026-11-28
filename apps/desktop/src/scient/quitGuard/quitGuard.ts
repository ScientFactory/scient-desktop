// SCIENT-OWNED: Quit asks first when it would stop this computer's running jobs.
import { COMPUTE_ACTIVE_WORK_PATH, ComputeActiveWork } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Electron from "electron";

import { PRIMARY_INSTANCE_ID } from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";

// The person is waiting on Quit; past this the count is unknown and Quit asks.
const READ_DEADLINE = Duration.seconds(2);

class RunningWorkStatusError extends Schema.TaggedError<RunningWorkStatusError>()(
  "RunningWorkStatusError",
  { status: Schema.Number },
) {}

/** The primary's count, with one fresh session when the cached one has expired. */
const readPrimaryCount = Effect.fn("scient.quitGuard.readPrimaryCount")(function* (
  httpBaseUrl: URL,
) {
  const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const http = yield* HttpClient.HttpClient;
  const request = (token: string) =>
    http.execute(
      HttpClientRequest.get(new URL(COMPUTE_ACTIVE_WORK_PATH, httpBaseUrl)).pipe(
        HttpClientRequest.bearerToken(token),
      ),
    );
  let response = yield* request(yield* auth.getBearerToken);
  if (response.status === 401) {
    yield* auth.forgetBearerToken;
    response = yield* request(yield* auth.getBearerToken);
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new RunningWorkStatusError({ status: response.status });
  }
  return (yield* HttpClientResponse.schemaBodyJson(ComputeActiveWork)(response)).count;
});

/**
 * How many runs quitting would stop right now, across every backend Quit stops; `null` when
 * that can't be told in time. Only the primary has a desktop session to ask with, so another
 * live backend (a WSL one) counts as unknown.
 */
export const readRunningWork = Effect.gen(function* () {
  const instances = yield* (yield* DesktopBackendPool.DesktopBackendPool).list;
  const counts = yield* Effect.forEach(
    instances,
    Effect.fnUntraced(function* (instance) {
      // Nothing runs before a backend is ready, and a stopped backend's runs are already gone.
      if (!(yield* instance.snapshot).ready) return 0;
      if (instance.id !== PRIMARY_INSTANCE_ID) return null;
      const config = yield* instance.currentConfig;
      return Option.isNone(config) ? null : yield* readPrimaryCount(config.value.httpBaseUrl);
    }),
    { concurrency: "unbounded" },
  );
  return counts.some((count) => count === null)
    ? null
    : counts.reduce<number>((total, count) => total + (count ?? 0), 0);
}).pipe(
  Effect.timeout(READ_DEADLINE),
  Effect.catchCause(() => Effect.succeed(null)),
  Effect.withSpan("scient.quitGuard.readRunningWork"),
);

let readAtQuit: () => Promise<number | null> = () => Promise.resolve(0);

/** Called once the backend services exist; until then nothing can be running. */
export const installRunningWorkReader = Effect.gen(function* () {
  const runPromise = Effect.runPromiseWith(
    yield* Effect.context<
      | DesktopBackendPool.DesktopBackendPool
      | DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth
      | HttpClient.HttpClient
    >(),
  );
  readAtQuit = () => runPromise(readRunningWork);
});

export function quitPrompt(count: number | null): { message: string; detail: string } | null {
  if (count === 0) return null;
  if (count === null) {
    return {
      message: "Stop any running jobs and quit?",
      detail: "Scient couldn't check whether runs are still going. Quitting stops them.",
    };
  }
  return count === 1
    ? {
        message: "Stop the running job and quit?",
        detail: "One run is still going. Quitting stops it.",
      }
    : {
        message: "Stop running jobs and quit?",
        detail: `${count} runs are still going or waiting. Quitting stops them.`,
      };
}

/**
 * Whether Quit asked and what the person chose, read when they quit since no window may be open to
 * report it. Quit goes on unless it is `cancelled`.
 */
export async function confirmQuitStopsRunningWork(): Promise<"none" | "confirmed" | "cancelled"> {
  const prompt = quitPrompt(await readAtQuit());
  if (prompt === null) return "none";
  const { response } = await Electron.dialog.showMessageBox({
    type: "warning",
    ...prompt,
    buttons: ["Stop and quit", "Keep running"],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0 ? "confirmed" : "cancelled";
}
