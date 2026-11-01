import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectSettingsOverrideSweep from "./ProjectSettingsOverrideSweep.ts";

const liveProjectId = ProjectId.make("project:live");
const deletedProjectId = ProjectId.make("project:deleted");

it.effect("removes a deleted project's whole entry, including keys a null reset keeps", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    yield* ProjectSettingsOverrideSweep.sweep;

    const settings = yield* serverSettings.getSettings;
    assert.deepEqual(settings.projectSettingsOverrides, {
      [liveProjectId]: { threadTitleInstructions: "" },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          projectSettingsOverrides: {
            [liveProjectId]: { threadTitleInstructions: "" },
            [deletedProjectId]: {
              defaultAutoPull: true,
              threadTitleInstructions: "Use ticket ids",
              providerInstances: { [ProviderInstanceId.make("codex_work")]: { enabled: true } },
            },
          },
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () =>
            Effect.succeed([
              {
                id: liveProjectId,
                title: "Live",
                workspaceRoot: "/work/live",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ]),
        }),
      ),
    ),
  ),
);
