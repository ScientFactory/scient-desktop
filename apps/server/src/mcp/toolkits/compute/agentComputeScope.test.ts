import { describe, expect, it } from "@effect/vitest";
import type { ComputeSessionRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ownedSession, type AgentScope } from "./agentComputeScope.ts";

describe("an agent's compute session", () => {
  it.effect("is started once when a chat's first two calls arrive together", () =>
    Effect.gen(function* () {
      const sessions: ComputeSessionRecord[] = [];
      let starts = 0;
      const gateway = {
        listSessions: () => Effect.yieldNow.pipe(Effect.as([...sessions])),
        startSession: (input: Pick<ComputeSessionRecord, "sessionId" | "languageId" | "owner">) =>
          Effect.sync(() => {
            starts += 1;
            const session = { ...input, status: "ready" } as ComputeSessionRecord;
            sessions.push(session);
            return session;
          }),
      };
      const scope = { cwd: "/project", threadId: "thread", gateway } as unknown as AgentScope;
      const owner = { _tag: "agent", threadId: "thread" } as const;
      const [first, second] = yield* Effect.all(
        [ownedSession(scope, "python", owner), ownedSession(scope, "python", owner)],
        { concurrency: 2 },
      );
      expect(starts).toBe(1);
      expect(second.sessionId).toBe(first.sessionId);
    }),
  );
});
