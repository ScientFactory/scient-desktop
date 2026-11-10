// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import {
  ReferenceIdentifierLookup,
  type ResolveIdentifierBatch,
} from "../../../scient/references/ReferenceCheck.ts";
import { checkReferencesForInvocation, resolveReferencesForInvocation } from "./handlers.ts";

const lookup: ResolveIdentifierBatch = async (identifiers) =>
  identifiers.map((identifier) => ({
    status: "found" as const,
    identifier,
    retrievedAt: "2026-11-10T12:00:00.000Z",
    metadata: {
      type: "article",
      title: "Light and sleep",
      creators: [],
      issuedRaw: "2021",
      issuedYear: 2021,
      identifiers: [],
      abstract: null,
      abstractSections: [],
      containerTitle: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: null,
    },
  }));

const withProject = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const resolver = workspaceResolverForTest(
      new Map([[root, { projectId: null, scope: workspaceScopeForTest("binding:refs", root) }]]),
    );
    const workspace = yield* resolver.resolveWorkspaceRoot(root);
    return yield* effect.pipe(
      Effect.provideService(
        AgentInvocationContext.AgentInvocationContext,
        AgentInvocationContext.AgentInvocationContext.of({
          environmentId: EnvironmentId.make("test-environment"),
          threadId: ThreadId.make("thread-references"),
          providerSessionId: "session-references",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["sources:read", "sources:write"]),
          issuedAt: 1,
          workspace,
        }),
      ),
      Effect.provideService(WorkspaceBindingResolver, resolver),
      Effect.provideService(ReferenceIdentifierLookup, lookup),
    );
  });

const project = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-references-mcp-"));
    await initializeScientProject({ root });
    await NodeFSP.writeFile(
      NodePath.join(root, "refs.bib"),
      "@article{a, author = {Ng, C.}, title = {Light and sleep}, journal = {Sleep}, year = {2020}, doi = {10.1000/a}}\n",
    );
    return root;
  }),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

describe("Scient references MCP handlers", () => {
  it.effect("checks a project file and applies its fix in the agent's name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* project;
        const report = yield* withProject(root, checkReferencesForInvocation({ path: "refs.bib" }));
        const fix = report.findings.find((finding) => finding.fix)?.fix;
        expect(fix).toMatchObject({ field: "year", current: "2020", value: "2021" });

        const resolution = yield* withProject(
          root,
          resolveReferencesForInvocation({ apply: [fix!], ignore: ["finding-1"] }),
        );
        expect(resolution.fixes.map(({ outcome }) => outcome)).toEqual(["applied"]);
        const ignored = JSON.parse(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, ".scient/reference-check/ignored.json"), "utf8"),
          ),
        );
        expect(ignored.findings).toMatchObject([{ findingId: "finding-1", ignoredBy: "agent" }]);
      }),
    ),
  );

  it.effect("reports a path outside the project without exposing host paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* project;
        const failure = yield* withProject(
          root,
          checkReferencesForInvocation({ path: "../secret.md" }),
        ).pipe(Effect.flip);
        expect(failure.message).toBe("The document path must remain inside the project.");
        expect(failure.message).not.toContain(root);
      }),
    ),
  );
});
