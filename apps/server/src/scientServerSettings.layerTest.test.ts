import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ScientServerSettings } from "./scientServerSettings.ts";
import * as ServerSettings from "./serverSettings.ts";

const catalog = {
  revision: 3,
  connections: [],
} satisfies typeof DEFAULT_SERVER_SETTINGS.customModels;
const removed = ProjectId.make("project-removed");
const kept = ProjectId.make("project-kept");

it.effect("the test settings layer builds Scient's settings on its own snapshot", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const scient = yield* ScientServerSettings;
    assert.deepEqual(scient.committedCustomModels(), catalog);
    yield* scient.removeProjectSettingsOverrides([removed]);
    assert.deepEqual(Object.keys((yield* settings.getSettings).projectSettingsOverrides), [kept]);
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({
        customModels: catalog,
        projectSettingsOverrides: {
          [removed]: { threadTitleInstructions: "Removed" },
          [kept]: { threadTitleInstructions: "Kept" },
        },
      }),
    ),
  ),
);
