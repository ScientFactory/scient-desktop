import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { noWorkspaceBindings } from "./WorkspaceBindingResolver.ts";

it.effect("a host without a binding store resolves no workspace", () =>
  Effect.gen(function* () {
    const byRoot = yield* noWorkspaceBindings
      .resolveWorkspaceRoot("/tmp/project")
      .pipe(Effect.flip);
    const byThread = yield* noWorkspaceBindings
      .resolveThread(ThreadId.make("thread-1"))
      .pipe(Effect.flip);
    assert.equal(byRoot.kind, "workspace-unavailable");
    assert.equal(byThread.kind, "workspace-unavailable");
  }),
);
