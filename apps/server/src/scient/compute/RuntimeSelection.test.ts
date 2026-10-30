import { describe, expect, it } from "@effect/vitest";
import {
  ComputeLanguageId,
  type ComputeRuntimeProfile,
  type ComputeRuntimeReadiness,
} from "@scientfactory/compute";
import * as Effect from "effect/Effect";

import { chooseRuntime, orderByChoice } from "./RuntimeSelection.ts";

const profile = (executable: string, source: ComputeRuntimeProfile["source"]) => ({
  languageId: ComputeLanguageId.make("python"),
  source,
  executable,
  languageVersion: "3.12",
  architecture: null,
  displayName: executable,
});

const checker = (readiness: Readonly<Record<string, ComputeRuntimeReadiness>>) => {
  const verified: string[] = [];
  return {
    verified,
    verify: (candidate: ComputeRuntimeProfile) =>
      Effect.sync(() => {
        verified.push(candidate.executable);
        const state = readiness[candidate.executable] ?? "ready";
        return {
          profile: candidate,
          verification: {
            profile: candidate,
            readiness: state,
            missingRequirements: [],
            message: state === "ready" ? null : `${candidate.executable} lacks ipykernel`,
            packages: [],
          },
        };
      }),
  };
};

describe("runtime choice", () => {
  it.effect("Automatic skips an unready first runtime for a ready later one", () =>
    Effect.gen(function* () {
      const { verify, verified } = checker({ "/usr/bin/python3": "missing-requirement" });
      const profiles = [profile("/usr/bin/python3", "path"), profile("/managed/python", "managed")];
      const choice = yield* chooseRuntime(profiles, null, verify);
      expect(choice).toMatchObject({ mode: "automatic", selected: { profile: profiles[1] } });
      expect(verified).toEqual(["/usr/bin/python3", "/managed/python"]);
      expect(
        orderByChoice(
          profiles.map((p) => ({ profile: p })),
          choice,
        )[0]!.profile,
      ).toBe(profiles[1]);
    }),
  );

  it.effect("an explicit choice keeps its failure instead of using another runtime", () =>
    Effect.gen(function* () {
      const { verify, verified } = checker({ "/chosen/python": "unusable" });
      const choice = yield* chooseRuntime(
        [profile("/usr/bin/python3", "path"), profile("/chosen/python", "configured")],
        "/chosen/python",
        verify,
      );
      expect(choice).toMatchObject({
        mode: "explicit",
        selected: null,
        problem: "/chosen/python lacks ipykernel",
      });
      expect(verified).toEqual(["/chosen/python"]);
    }),
  );

  it.effect("a broken project environment blocks instead of falling through to PATH", () =>
    Effect.gen(function* () {
      const { verify } = checker({ "/p/.venv/bin/python": "unusable" });
      const choice = yield* chooseRuntime(
        [profile("/usr/bin/python3", "path"), profile("/p/.venv/bin/python", "project")],
        null,
        verify,
      );
      expect(choice).toMatchObject({ mode: "project", selected: null });
      expect(choice.blocker?.profile.executable).toBe("/p/.venv/bin/python");
    }),
  );

  it.effect("nothing found is not a failure of a runtime", () =>
    Effect.gen(function* () {
      expect(yield* chooseRuntime([], null, checker({}).verify)).toEqual({
        mode: "automatic",
        selected: null,
        blocker: null,
        problem: null,
      });
    }),
  );
});
