import { ComputeLanguageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ServerSettingsService, layerTest } from "../../serverSettings.ts";
import {
  machineSelectionKey,
  makeScientificRuntimePreferences,
} from "./ScientificRuntimePreferences.ts";

const MATLAB = ComputeLanguageId.make("matlab");
const PYTHON = ComputeLanguageId.make("python");

describe("scientific runtime preference ownership", () => {
  it.effect("reads a legacy MATLAB choice without rewriting it", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const legacy = vi.fn(() =>
        Effect.succeed({ executablePath: "/legacy/matlab", warning: null }),
      );
      const preferences = makeScientificRuntimePreferences(settings, {
        readRuntimeExecutablePath: legacy,
      });
      expect((yield* preferences.getSettings).scientificComputing.languages[MATLAB]).toEqual({
        enabled: true,
        executable: "/legacy/matlab",
      });
      expect((yield* settings.getSettings).scientificComputing.languages[MATLAB]).toBeUndefined();
      expect(yield* preferences.readRuntimeExecutablePath("matlab")).toEqual({
        executablePath: "/legacy/matlab",
        warning: null,
      });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("makes both execution paths observe canonical updates and an explicit clear", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const legacy = vi.fn(() =>
        Effect.succeed({ executablePath: "/legacy/matlab", warning: null }),
      );
      const preferences = makeScientificRuntimePreferences(settings, {
        readRuntimeExecutablePath: legacy,
      });
      yield* preferences.writeRuntimeExecutablePath("matlab", "/selected/matlab");
      expect((yield* settings.getSettings).scientificComputing.languages[MATLAB]?.executable).toBe(
        "/selected/matlab",
      );
      yield* settings.updateSettings({
        scientificComputing: { languages: { [MATLAB]: { executable: "/changed/matlab" } } },
      });
      expect((yield* preferences.readRuntimeExecutablePath("matlab")).executablePath).toBe(
        "/changed/matlab",
      );
      yield* preferences.writeRuntimeExecutablePath("matlab", null);
      expect((yield* preferences.readRuntimeExecutablePath("matlab")).executablePath).toBeNull();
      expect(legacy).not.toHaveBeenCalled();
      expect((yield* settings.getSettings).scientificComputing.languages[PYTHON]).toEqual({
        enabled: true,
        executable: "/chosen/python",
      });
    }).pipe(
      Effect.provide(
        layerTest({
          scientificComputing: {
            languages: { [PYTHON]: { enabled: true, executable: "/chosen/python" } },
          },
        }),
      ),
    ),
  );

  it.effect("moves an unscoped choice into this machine's selection and leaves others alone", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const legacy = {
        readRuntimeExecutablePath: () => Effect.succeed({ executablePath: null, warning: null }),
      };
      const here = makeScientificRuntimePreferences(settings, legacy, "host-a");
      yield* here.migrate();
      expect((yield* settings.getSettings).scientificComputing.languages[PYTHON]).toEqual({
        enabled: true,
        executable: "",
        selections: { "host-a": "/chosen/python" },
      });
      expect((yield* here.readRuntimeExecutablePath("python")).executablePath).toBe(
        "/chosen/python",
      );
      // The same profile on another computer starts from Automatic, not from this path.
      const copied = makeScientificRuntimePreferences(settings, legacy, "host-b");
      expect((yield* copied.readRuntimeExecutablePath("python")).executablePath).toBeNull();
      expect((yield* copied.getSettings).scientificComputing.languages[PYTHON]?.executable).toBe(
        "",
      );
      yield* copied.writeRuntimeExecutablePath("python", "/b/python");
      expect((yield* here.readRuntimeExecutablePath("python")).executablePath).toBe(
        "/chosen/python",
      );
      expect((yield* copied.readRuntimeExecutablePath("python")).executablePath).toBe("/b/python");
    }).pipe(
      Effect.provide(
        layerTest({
          scientificComputing: {
            languages: { [PYTHON]: { enabled: true, executable: "/chosen/python" } },
          },
        }),
      ),
    ),
  );

  it.effect("a project's choice on this machine wins over the machine default", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const preferences = makeScientificRuntimePreferences(
        settings,
        { readRuntimeExecutablePath: () => Effect.die("unused") },
        "host-a",
      );
      expect(yield* preferences.projectExecutable("python", "study")).toBe(
        "/study/.venv/bin/python",
      );
      expect(yield* preferences.projectExecutable("python", "other")).toBeNull();
    }).pipe(
      Effect.provide(
        layerTest({
          scientificComputing: {
            languages: {
              [PYTHON]: {
                enabled: true,
                executable: "",
                selections: {
                  "host-a": "/usr/bin/python3",
                  "host-a/study": "/study/.venv/bin/python",
                  "host-b/other": "/elsewhere/python",
                },
              },
            },
          },
        }),
      ),
    ),
  );

  it("keys choices by computer and account, stable across restarts", () => {
    const here = {
      hostname: "lab-mac",
      platform: "darwin" as const,
      architecture: "arm64",
      homeDirectory: "/Users/ada",
    };
    expect(machineSelectionKey(here)).toBe(machineSelectionKey({ ...here }));
    expect(machineSelectionKey({ ...here, homeDirectory: "/Users/grace" })).not.toBe(
      machineSelectionKey(here),
    );
    expect(machineSelectionKey({ ...here, hostname: "home-mac" })).not.toBe(
      machineSelectionKey(here),
    );
  });
});
