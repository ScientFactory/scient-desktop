// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise verified skill resources.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { loadSkillCatalog, skillReleaseKey, type SkillRelease } from "@scientfactory/scient-skills";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ScientSkillRegistry from "../../../scient/skills/ScientSkillRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  listScientSkillsForInvocation,
  loadScientSkillForInvocation,
  readScientSkillResourceForInvocation,
} from "./handlers.ts";

const fixtures: string[] = [];

async function makeCatalogFixture() {
  const parent = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-skill-mcp-"));
  fixtures.push(parent);
  const root = NodePath.join(parent, "evidence-review");
  await NodeFSP.mkdir(NodePath.join(root, "references"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "SKILL.md"),
    "---\nname: evidence-review\ndescription: Reviews evidence without widening authority.\n---\n\n# Evidence review\n\nLoad the rubric when needed.\n",
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "scient.skill.json"),
    `${JSON.stringify({
      apiVersion: "scient.skills/v1alpha1",
      id: "scient.evidence-review",
      version: "0.1.0",
      category: "Evidence",
      categoryDescription: "Review evidence carefully.",
      displayOrder: 100,
      supportedScopes: ["user", "project"],
      defaultInvocationPolicy: "automatic",
      origin: { kind: "scient" },
    })}\n`,
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "references", "rubric.md"),
    "Distinguish findings from inference.\n",
    "utf8",
  );
  return loadSkillCatalog([root]);
}

const makeInvocation = (
  releases: ReadonlyArray<SkillRelease>,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["skills:read"]),
  invocationPolicy: "automatic" | "explicit" = "automatic",
) =>
  McpInvocationContext.McpInvocationContext.of({
    environmentId: EnvironmentId.make("environment-skills-test"),
    threadId: ThreadId.make("thread-skills-test"),
    providerSessionId: "session-skills-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities,
    skillScope: {
      releases: new Map(releases.map((release) => [skillReleaseKey(release), release] as const)),
      skills: releases.map((release) => ({
        releaseKey: skillReleaseKey(release),
        id: release.id,
        name: release.name,
        description: release.description,
        origin: release.origin,
        activationScope: "user" as const,
        invocationPolicy,
      })),
    },
    issuedAt: 1,
  });

const provideContext = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    readonly catalog: Awaited<ReturnType<typeof makeCatalogFixture>>;
    readonly invocation: McpInvocationContext.McpInvocationScope;
  },
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, input.invocation),
    Effect.provide(ScientSkillRegistry.layerFromCatalog(input.catalog)),
  );

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Scient skills MCP handlers", () => {
  it.effect("lists and loads only the exact releases bound to the bearer scope", () =>
    Effect.gen(function* () {
      const catalog = yield* Effect.promise(makeCatalogFixture);
      const release = catalog.releases[0]!;
      const releaseKey = skillReleaseKey(release);
      const invocation = makeInvocation([release]);

      const listed = yield* provideContext(listScientSkillsForInvocation(), {
        catalog,
        invocation,
      });
      expect(listed.skills).toHaveLength(1);
      expect(listed.skills[0]).toMatchObject({ releaseKey, id: release.id });

      const releaseRoot = NodePath.join(fixtures[0]!, "evidence-review");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(releaseRoot, "references", "rubric.md"),
          "mutated after the turn snapshot\n",
          "utf8",
        ),
      );
      const currentCatalog = yield* Effect.promise(() => loadSkillCatalog([releaseRoot]));

      const loaded = yield* provideContext(loadScientSkillForInvocation({ name: release.name }), {
        catalog: currentCatalog,
        invocation,
      });
      expect(loaded.instructions).toContain("Load the rubric");
      expect(loaded.resources).toEqual([
        { path: "references/rubric.md", bytes: 37, kind: "reference" },
      ]);

      const resource = yield* provideContext(
        readScientSkillResourceForInvocation({
          name: release.name,
          path: "references/rubric.md",
        }),
        { catalog: currentCatalog, invocation },
      );
      expect(resource).toEqual({
        path: "references/rubric.md",
        encoding: "utf8",
        content: "Distinguish findings from inference.\n",
      });
    }),
  );

  it.effect("denies catalog entries and paths outside the exact turn scope", () =>
    Effect.gen(function* () {
      const catalog = yield* Effect.promise(makeCatalogFixture);
      const releaseKey = skillReleaseKey(catalog.releases[0]!);
      const emptyScope = makeInvocation([]);

      const unavailable = yield* provideContext(
        loadScientSkillForInvocation({ name: catalog.releases[0]!.name }),
        {
          catalog,
          invocation: emptyScope,
        },
      ).pipe(Effect.flip);
      expect(unavailable.code).toBe("not-found");

      const traversal = yield* provideContext(
        readScientSkillResourceForInvocation({
          name: catalog.releases[0]!.name,
          path: "../SKILL.md",
        }),
        { catalog, invocation: makeInvocation([catalog.releases[0]!]) },
      ).pipe(Effect.flip);
      expect(traversal.code).toBe("resource-unavailable");

      const noCapability = yield* provideContext(listScientSkillsForInvocation(), {
        catalog,
        invocation: makeInvocation([catalog.releases[0]!], new Set()),
      }).pipe(Effect.flip);
      expect(noCapability.code).toBe("capability-unavailable");

      const invocation = makeInvocation([catalog.releases[0]!]);
      const descriptor = invocation.skillScope!.skills[0]!;
      const ambiguous = McpInvocationContext.McpInvocationContext.of({
        ...invocation,
        skillScope: {
          releases: invocation.skillScope!.releases,
          skills: [descriptor, { ...descriptor, releaseKey: `${releaseKey}-other` }],
        },
      });
      const nameConflict = yield* provideContext(
        loadScientSkillForInvocation({ name: descriptor.name }),
        { catalog, invocation: ambiguous },
      ).pipe(Effect.flip);
      expect(nameConflict.code).toBe("ambiguous-name");
    }),
  );

  it.effect("exposes an explicit skill only when the exact turn scope includes it", () =>
    Effect.gen(function* () {
      const catalog = yield* Effect.promise(makeCatalogFixture);
      const selectedInvocation = makeInvocation(
        [catalog.releases[0]!],
        new Set(["skills:read"]),
        "explicit",
      );

      const loaded = yield* provideContext(
        loadScientSkillForInvocation({ name: catalog.releases[0]!.name }),
        {
          catalog,
          invocation: selectedInvocation,
        },
      );
      expect(loaded.skill.invocationPolicy).toBe("explicit");

      const hidden = yield* provideContext(
        loadScientSkillForInvocation({ name: catalog.releases[0]!.name }),
        {
          catalog,
          invocation: makeInvocation([]),
        },
      ).pipe(Effect.flip);
      expect(hidden.code).toBe("not-found");
    }),
  );
});
