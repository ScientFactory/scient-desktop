import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type OrchestrationThreadShell,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import { make, ProviderActivity } from "./ProviderActivity.ts";

const CODEX = ProviderDriverKind.make("codex");
const THREAD = ThreadId.make("thread-1");

function isBusy(input: {
  readonly sessions?: ReadonlyArray<Partial<ProviderSession>>;
  readonly thread?: Partial<OrchestrationThreadShell>;
  readonly failDirectory?: boolean;
}) {
  const binding = { threadId: THREAD, provider: CODEX, lastSeenAt: "2026-09-26T00:00:00.000Z" };
  return Effect.gen(function* () {
    const activity = yield* ProviderActivity;
    return yield* activity.isBusy(CODEX);
  }).pipe(
    Effect.provideServiceEffect(ProviderActivity, make),
    Effect.provideService(ProviderService, {
      listSessions: () =>
        Effect.succeed(
          (input.sessions ?? []).map(
            (session) =>
              ({
                provider: CODEX,
                status: "ready",
                threadId: THREAD,
                ...session,
              }) as ProviderSession,
          ),
        ),
    } as unknown as ProviderService["Service"]),
    Effect.provideService(ProviderSessionDirectory, {
      listBindings: () =>
        input.failDirectory
          ? Effect.die("directory unavailable")
          : Effect.succeed([binding as ProviderRuntimeBindingWithMetadata]),
    } as unknown as ProviderSessionDirectory["Service"]),
    Effect.provideService(ProjectionSnapshotQuery, {
      getThreadShellById: () =>
        Effect.succeed(
          input.thread ? Option.some(input.thread as OrchestrationThreadShell) : Option.none(),
        ),
    } as unknown as ProjectionSnapshotQuery["Service"]),
  );
}

it.effect("is idle when no session of the provider is working", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* isBusy({ sessions: [{ status: "ready" }] }), false);
  }),
);

it.effect("is busy while a session starts or runs a turn", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* isBusy({ sessions: [{ status: "running" }] }), true);
    assert.strictEqual(yield* isBusy({ sessions: [{ status: "connecting" }] }), true);
    assert.strictEqual(
      yield* isBusy({ sessions: [{ status: "ready", activeTurnId: TurnId.make("turn-1") }] }),
      true,
    );
  }),
);

it.effect("is busy while a settled turn's background work still runs", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* isBusy({ thread: { id: THREAD, backgroundLiveness: "monitoring", session: null } }),
      true,
    );
  }),
);

it.effect("counts as busy when activity cannot be read", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* isBusy({ failDirectory: true }), true);
  }),
);
