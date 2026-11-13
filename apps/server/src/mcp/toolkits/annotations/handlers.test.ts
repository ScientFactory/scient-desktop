import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { layer as ScientAnnotationsLive } from "../../../scient/annotations/ScientAnnotations.ts";
import {
  temporaryProject,
  textPdf,
  writeProjectFile,
} from "../../../scient/annotations/annotationTestUtils.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { ScientSourcesBackend } from "../../../scient/sources/SourcesBackend.ts";
import {
  addAnnotationForInvocation,
  readAnnotationsForInvocation,
  removeAnnotationForInvocation,
  restoreAnnotationForInvocation,
  updateAnnotationForInvocation,
} from "./handlers.ts";

const environmentId = EnvironmentId.make("environment-annotations-test");
const threadId = ThreadId.make("thread-annotations-test");

function agentContext(root: string) {
  const fixture = workspaceResolverForTest(
    new Map([
      [root, { projectId: "project", scope: workspaceScopeForTest(`binding:${root}`, root) }],
    ]),
  );
  const resolveThread = () =>
    fixture.resolveWorkspaceRoot(root).pipe(
      Effect.map((resolved) => ({
        ...resolved,
        binding: { ...resolved.binding, environmentId, hostProjectId: ProjectId.make("project") },
      })),
    );
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        WorkspaceBindingResolver,
        WorkspaceBindingResolver.of({ ...fixture, resolveThread }),
      ),
      Effect.provideService(
        AgentInvocationContext.AgentInvocationContext,
        AgentInvocationContext.AgentInvocationContext.of({
          environmentId,
          threadId,
          providerSessionId: "session-annotations-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["sources:read", "sources:write"]),
          issuedAt: 1,
        }),
      ),
      Effect.provide(ScientAnnotationsLive),
      // These PDFs live in an unmoved project; ScientAnnotations.library.test.ts covers the Library.
      Effect.provideService(ScientSourcesBackend, "project"),
    );
}

const project = Effect.acquireDisposable(Effect.promise(temporaryProject));

describe("annotation tools", () => {
  it.effect("let an agent highlight, read, edit, remove and restore like a person", () =>
    Effect.gen(function* () {
      const { root } = yield* project;
      yield* Effect.promise(() =>
        writeProjectFile(
          root,
          "papers/sleep.pdf",
          textPdf([["Sleep and memory"], ["Deep sleep doubled recall in mice."]]),
        ),
      );
      const asAgent = agentContext(root);

      const added = yield* asAgent(
        addAnnotationForInvocation({
          pdfRelativePath: "papers/sleep.pdf",
          quote: "deep sleep doubled recall",
          note: "Main result",
        }),
      );
      expect(added).toMatchObject({
        outcome: "created",
        annotation: {
          pages: [2],
          quote: "Deep sleep doubled recall",
          note: "Main result",
          highlighted: true,
          createdBy: "agent",
          removed: false,
        },
        pdf: { paths: ["papers/sleep.pdf"], sources: [] },
      });
      const annotationId = added.annotation!.annotationId;

      const read = yield* asAgent(readAnnotationsForInvocation({ query: "main result" }));
      expect(read).toMatchObject({ outcome: "listed", total: 1, unreadableFiles: 0 });
      expect(read.pdfs[0]!.annotations.map((a) => a.annotationId)).toEqual([annotationId]);

      const stale = yield* asAgent(
        updateAnnotationForInvocation({ annotationId, expectedRevision: 5, note: "Lost edit" }),
      );
      expect(stale).toMatchObject({ outcome: "stale", annotation: { note: "Main result" } });
      const edited = yield* asAgent(
        updateAnnotationForInvocation({ annotationId, expectedRevision: 1, note: "Replicated" }),
      );
      expect(edited).toMatchObject({
        outcome: "updated",
        annotation: { revision: 2, note: "Replicated", updatedBy: "agent" },
        earlierRevisions: [{ revision: 1, note: "Main result" }],
      });
      const reverted = yield* asAgent(
        restoreAnnotationForInvocation({ annotationId, expectedRevision: 2, toRevision: 1 }),
      );
      expect(reverted).toMatchObject({
        outcome: "updated",
        annotation: { revision: 3, note: "Main result" },
      });

      const removed = yield* asAgent(
        removeAnnotationForInvocation({ annotationId, expectedRevision: 3 }),
      );
      expect(removed).toMatchObject({ outcome: "removed", annotation: { removed: true } });
      expect((yield* asAgent(readAnnotationsForInvocation({}))).total).toBe(0);
      const restored = yield* asAgent(
        restoreAnnotationForInvocation({ annotationId, expectedRevision: 4 }),
      );
      expect(restored).toMatchObject({ outcome: "restored", annotation: { removed: false } });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an unclear PDF choice and reports a PDF that is not there", () =>
    Effect.gen(function* () {
      const { root } = yield* project;
      const asAgent = agentContext(root);
      const unclear = yield* asAgent(
        addAnnotationForInvocation({ sourceId: "s", pdfRelativePath: "a.pdf", quote: "x" }),
      ).pipe(Effect.flip);
      expect(unclear).toMatchObject({ code: "invalid-input" });
      expect(
        yield* asAgent(addAnnotationForInvocation({ pdfRelativePath: "missing.pdf", quote: "x" })),
      ).toMatchObject({ outcome: "pdf-not-found", annotation: null });
      expect(
        yield* asAgent(readAnnotationsForInvocation({ sourceId: "no-such-source" })),
      ).toMatchObject({ outcome: "pdf-not-found", total: 0 });
    }).pipe(Effect.scoped),
  );
});
