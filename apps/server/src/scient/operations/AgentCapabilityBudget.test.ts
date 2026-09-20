import { expect, it } from "@effect/vitest";
import { skillReleaseKey, type SkillRelease } from "@scientfactory/scient-skills";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import { Tool } from "effect/unstable/ai";

import { scientTools } from "../../mcp/ScientOperationCatalog.ts";
import {
  listScientSkillsForInvocation,
  ScientSkillsToolkitHandlersLive,
} from "../../mcp/toolkits/skills/handlers.ts";
import { ScientSkillsToolkit } from "../../mcp/toolkits/skills/tools.ts";
import { makeScientToolExecutor } from "./AgentOperationDispatcher.ts";
import { SCIENT_CORE_AWARENESS } from "../../provider/ScientAwareness.ts";
import { BUILT_IN_SKILL_RELEASES } from "../skills/BuiltInSkillReleases.ts";
import { prepareScientSkillTurn } from "../skills/ScientSkillInvocation.ts";
import { AgentInvocationContext, type AgentSkillDescriptor } from "./AgentInvocationContext.ts";

const fixtures = (count: number) => {
  const base = BUILT_IN_SKILL_RELEASES[0]!;
  const releases = new Map<string, SkillRelease>();
  const skills: AgentSkillDescriptor[] = [];
  for (let index = 0; index < count; index++) {
    const name = `fixture-${String(index).padStart(3, "0")}`;
    const release = {
      ...base,
      id: `fixture.${index}`,
      name,
      description: `Scientific workflow ${index}; inspect measurements and preserve evidence.`,
    };
    const releaseKey = skillReleaseKey(release);
    releases.set(releaseKey, release);
    skills.push({
      releaseKey,
      id: release.id,
      name,
      description: release.description,
      origin: "scient",
      invocationPolicy: "automatic",
      activationScope: "user",
    });
  }
  return { releases, skills };
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.live(
  "adds zero automatic catalog bytes and preserves rare and explicit access at 28, 100 and 500 entries",
  () =>
    Effect.gen(function* () {
      const execute = yield* makeScientToolExecutor(yield* ScientSkillsToolkit);
      const coreBytes = Buffer.byteLength(SCIENT_CORE_AWARENESS);
      expect(coreBytes).toBeLessThan(2_000);
      for (const count of [28, 100, 500]) {
        const fixture = fixtures(count);
        const ordinary = prepareScientSkillTurn(
          "Explain this function.",
          fixture.skills,
          fixture.releases,
        );
        expect(ordinary.input).toBe("Explain this function.");
        expect(ordinary.skillScope.skills).toHaveLength(count);
        const rareName = fixture.skills.at(-1)!.name;
        expect(ordinary.input).not.toContain(rareName);
        const selected = prepareScientSkillTurn(
          `Use $${rareName} for this task.`,
          fixture.skills.map((skill) =>
            skill.name === rareName ? { ...skill, invocationPolicy: "explicit" as const } : skill,
          ),
          fixture.releases,
          undefined,
          [rareName],
        );
        expect(selected.input).toContain(`\`${rareName}\` (selected by the user`);
        expect(selected.input).not.toContain("additional skills");
        expect(Buffer.byteLength(selected.input!)).toBeLessThan(600);
        const invocation = AgentInvocationContext.of({
          nativeSessionId: "budget-fixture",
          environmentId: EnvironmentId.make("budget-environment"),
          threadId: ThreadId.make("budget-thread"),
          issuedAt: 1,
          capabilities: new Set(["skills:read"]),
          skillScope: ordinary.skillScope,
        });
        const found = yield* execute("scient_skills_list", { query: rareName }).pipe(
          Effect.provideService(AgentInvocationContext, invocation),
        );
        if (!("skills" in found.result)) throw new Error("Expected Skill discovery success");
        expect(found.result.skills.map((skill) => skill.name)).toEqual([rareName]);
        const loaded = yield* execute("scient_skill_load", { name: rareName }).pipe(
          Effect.provideService(AgentInvocationContext, invocation),
        );
        if (!("instructions" in loaded.result)) throw new Error("Expected Skill load success");
        expect(loaded.result.instructions).toBe(
          fixture.releases.get(fixture.skills.at(-1)!.releaseKey)!.instructions,
        );
        const names: string[] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          const page: Effect.Success<ReturnType<typeof listScientSkillsForInvocation>> =
            yield* listScientSkillsForInvocation({ offset, limit: 20 }).pipe(
              Effect.provideService(AgentInvocationContext, invocation),
            );
          expect(page.skills.length).toBeLessThanOrEqual(20);
          names.push(...page.skills.map((skill) => skill.name));
          offset = page.nextOffset;
        }
        expect(names).toEqual(fixture.skills.map((skill) => skill.name));
        expect(new Set(names).size).toBe(names.length);
        const fallbackNames: string[] = [];
        offset = 0;
        while (offset !== null) {
          const page: Effect.Success<ReturnType<typeof listScientSkillsForInvocation>> =
            yield* listScientSkillsForInvocation({
              query: "unmatched query",
              offset,
              limit: 20,
            }).pipe(Effect.provideService(AgentInvocationContext, invocation));
          expect(page.skills.length).toBeLessThanOrEqual(20);
          expect(page.total).toBe(count);
          expect(page.hint).toContain("showing available skills");
          fallbackNames.push(...page.skills.map((skill) => skill.name));
          offset = page.nextOffset;
        }
        expect(fallbackNames).toEqual(names);
        const samples = Array.from({ length: 101 }, () => {
          const start = performance.now();
          prepareScientSkillTurn("Explain this function.", fixture.skills, fixture.releases);
          return performance.now() - start;
        });
        const initialMeasuredMs = samples.shift()!;
        samples.sort((a, b) => a - b);
        yield* Effect.logInfo({
          fixture: "skill-orientation",
          count,
          coreBytes,
          providerInputBytes: Buffer.byteLength(ordinary.input!),
          automaticOrientationBytes: 0,
          loadedInstructionBytes: Buffer.byteLength(loaded.result.instructions),
          discoveryResultBytes: Buffer.byteLength(encode(found.result)),
          loadedResultBytes: Buffer.byteLength(encode(loaded.result)),
          combinedCoreInputSchemasAndResultsBytes:
            coreBytes +
            Buffer.byteLength(ordinary.input!) +
            Buffer.byteLength(
              encode(
                scientTools.map((tool) => ({
                  name: tool.name,
                  description: Tool.getDescription(tool),
                  inputSchema: Tool.getJsonSchema(tool),
                })),
              ),
            ) +
            Buffer.byteLength(encode(found.result)) +
            Buffer.byteLength(encode(loaded.result)),
          initialMeasuredMs,
          p50Ms: samples[49],
          p95Ms: samples[94],
        });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(
          ScientSkillsToolkitHandlersLive,
          Logger.layer([Logger.consoleJson], { mergeWithExisting: false }),
        ),
      ),
    ),
);

it.live(
  "records eager schema growth honestly instead of treating a short prompt as lazy tool delivery",
  () =>
    Effect.gen(function* () {
      const schemas = scientTools.map((tool) => ({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
      }));
      const size = (count: number) =>
        Buffer.byteLength(
          encode(
            Array.from({ length: count }, (_, index) => ({
              ...schemas[index % schemas.length],
              name: `fixture_${index}`,
            })),
          ),
        );
      expect(size(500)).toBeGreaterThan(size(100) * 4);
      expect(size(100)).toBeGreaterThan(size(29) * 2);
      expect(scientTools).toHaveLength(29);
      yield* Effect.logInfo({
        fixture: "eager-input-schemas",
        actual29Bytes: Buffer.byteLength(encode(schemas)),
        synthetic29Bytes: size(29),
        synthetic100Bytes: size(100),
        synthetic500Bytes: size(500),
      });
    }).pipe(Effect.provide(Logger.layer([Logger.consoleJson], { mergeWithExisting: false }))),
);
