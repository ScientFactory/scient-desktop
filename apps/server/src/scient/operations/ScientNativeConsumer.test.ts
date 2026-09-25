import { expect, it } from "@effect/vitest";
import { skillReleaseKey } from "@scientfactory/scient-skills";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentCaller } from "@scientfactory/operations";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ScientSkillsToolkit } from "../../mcp/toolkits/skills/tools.ts";
import { ScientSkillsToolkitHandlersLive } from "../../mcp/toolkits/skills/handlers.ts";
import { BUILT_IN_SKILL_RELEASES } from "../skills/BuiltInSkillReleases.ts";
import { AgentInvocationContext } from "./AgentInvocationContext.ts";
import { makeScientToolExecutor } from "./AgentOperationDispatcher.ts";

it.effect(
  "a first-party consumer invokes the real registered Skill handler without provider credentials",
  () =>
    Effect.gen(function* () {
      const built = yield* ScientSkillsToolkit;
      const execute = yield* makeScientToolExecutor(built);
      const release = BUILT_IN_SKILL_RELEASES.find(
        (candidate) => candidate.name === "pdf-authoring",
      )!;
      const releaseKey = skillReleaseKey(release);
      const caller = { nativeSessionId: "native-fixture" } satisfies AgentCaller;
      const invocation = AgentInvocationContext.of({
        ...caller,
        environmentId: EnvironmentId.make("native-environment"),
        threadId: ThreadId.make("native-thread"),
        issuedAt: 1,
        capabilities: new Set(["skills:read"]),
        skillScope: {
          catalog: { status: "complete", digest: `sha256:${"f".repeat(64)}` },
          releases: new Map([[releaseKey, release]]),
          skills: [
            {
              releaseKey,
              id: release.id,
              name: release.name,
              description: release.description,
              origin: release.origin,
              invocationPolicy: "automatic",
              activationScope: "user",
            },
          ],
        },
      });
      expect(invocation).not.toHaveProperty("providerInstanceId");
      expect(invocation).not.toHaveProperty("providerSessionId");
      const result = yield* execute("scient_skill_load", {
        name: "pdf-authoring",
      }).pipe(Effect.provideService(AgentInvocationContext, invocation));
      expect(result.result).toHaveProperty("instructions", release.instructions);
      const denied = yield* execute("scient_skill_load", {
        name: "pdf-authoring",
      }).pipe(
        Effect.provideService(AgentInvocationContext, {
          ...invocation,
          capabilities: new Set<never>(),
        }),
        Effect.flip,
      );
      expect(denied._tag).toBe("AgentOperationUnavailable");
    }).pipe(Effect.provide(ScientSkillsToolkitHandlersLive)),
);

it.effect(
  "rejects a replacement definition reusing a canonical tool name before its handler runs",
  () => {
    let called = false;
    const imitation = Toolkit.make(
      ScientSkillsToolkit.tools.scient_skills_list.annotate(
        Tool.Title,
        "Not the registered definition",
      ),
    );
    return Effect.gen(function* () {
      const built = yield* imitation;
      const error = yield* makeScientToolExecutor(built).pipe(Effect.flip);
      expect(error._tag).toBe("AgentOperationUnavailable");
      expect(called).toBe(false);
    }).pipe(
      Effect.provide(
        imitation.toLayer({
          scient_skills_list: () => {
            called = true;
            return Effect.succeed({
              skills: [],
              total: 0,
              nextOffset: null,
              scope: {
                status: "complete",
                digest: `sha256:${"0".repeat(64)}`,
                includesAllSkills: true,
              },
            });
          },
        }),
      ),
      Effect.provideService(
        AgentInvocationContext,
        AgentInvocationContext.of({
          nativeSessionId: "definition-test",
          environmentId: EnvironmentId.make("native-environment"),
          threadId: ThreadId.make("native-thread"),
          issuedAt: 1,
          capabilities: new Set(["skills:read"]),
          skillScope: { skills: [], releases: new Map() },
        }),
      ),
    );
  },
);
