import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadSectionId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PINNED_AT = "2025-12-31T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const RESEARCH = ThreadSectionId.make("research");

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        pullRequests: [],
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: NOW,
  };
}

const sectionCommand = (sectionId: ThreadSectionId | null) =>
  ({
    type: "thread.section.set",
    commandId: CommandId.make(`cmd-section-${sectionId ?? "none"}`),
    threadId: THREAD_ID,
    sectionId,
  }) as const;

it.layer(NodeServices.layer)("thread sections", (it) => {
  it.effect("files and clears a section without touching activity or lifecycle state", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel({
        pinnedAt: PINNED_AT,
        pinOrderKey: "g",
        settledOverride: "settled",
        settledAt: NOW,
      });
      for (const sectionId of [RESEARCH, null]) {
        const decided = yield* decideOrchestrationCommand({
          command: sectionCommand(sectionId),
          readModel,
        });
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "thread.meta-updated",
          payload: { threadId: THREAD_ID, sectionId, updatedAt: NOW },
        });
        for (const event of events) {
          readModel = yield* projectEvent(readModel, {
            ...event,
            sequence: readModel.snapshotSequence + 1,
          });
        }
        expect(readModel.threads[0]).toMatchObject({
          sectionId,
          updatedAt: NOW,
          pinnedAt: PINNED_AT,
          pinOrderKey: "g",
          settledOverride: "settled",
          settledAt: NOW,
        });
      }
    }),
  );

  for (const [label, overrides] of [
    ["archived", { archivedAt: NOW }],
    ["deleted", { deletedAt: NOW }],
  ] satisfies ReadonlyArray<readonly [string, Partial<OrchestrationThread>]>) {
    it.effect(`rejects filing a ${label} thread`, () =>
      Effect.gen(function* () {
        const error = yield* decideOrchestrationCommand({
          command: sectionCommand(RESEARCH),
          readModel: makeReadModel(overrides),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }),
    );
  }
});
