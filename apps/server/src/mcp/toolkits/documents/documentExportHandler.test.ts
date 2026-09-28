// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScientDocumentPageRenderRequest,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { GeneratedDocumentStore } from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import {
  documentExportTestLayer,
  makeFixtureDirectory,
  makeGeneratedDocumentStore,
  minimalPdf,
  publishedSource,
  renderResultFor,
  writeFixtureFile,
} from "../../../scient/documentExport/DocumentExportTestUtils.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import {
  WorkspaceAuthorityGeneration,
  WorkspaceAuthorityScopeRevision,
  WorkspaceBindingId,
  WorkspaceBindingResolutionError,
  type WorkspaceBindingRecordV1,
} from "../../../scient/projectScope/WorkspaceBinding.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { exportScientDocumentForInvocation } from "./documentExportHandler.ts";

const fixtures: string[] = [];
const layer = documentExportTestLayer("scient-document-export-tool-test-");
const environmentId = EnvironmentId.make("environment-document-export-test");
const threadId = ThreadId.make("thread-document-export");
const decodeRequest = Schema.decodeUnknownSync(ScientDocumentPageRenderRequest);

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const makeResolver = (root: string, state: { changed: boolean }) => {
  const binding: WorkspaceBindingRecordV1 = {
    schemaVersion: 1,
    bindingId: WorkspaceBindingId.make(`binding:${root}`),
    environmentId,
    hostProjectId: ProjectId.make("project-document-export"),
    canonicalRoot: root,
    rootFileSystemIdentity: null,
    scientProjectId: "scient-project-fixture",
    repositoryIdentity: null,
    worktreeIdentity: null,
    lineageBindingId: null,
    trustState: "verified",
    authorityGeneration: WorkspaceAuthorityGeneration.make(1),
    createdAt: "2026-09-28T00:00:00.000Z",
    lastVerifiedAt: "2026-09-28T00:00:00.000Z",
    supersededBy: null,
  };
  const resolved = {
    binding,
    relation: "only-binding" as const,
    relatedBindingCount: 0,
    scopeRevision: WorkspaceAuthorityScopeRevision.make(1),
  };
  return WorkspaceBindingResolver.of({
    resolveWorkspaceRoot: () => Effect.die("unused"),
    assertCurrentWorkspaceScope: () => Effect.die("unused"),
    resolveThread: () => Effect.succeed(resolved),
    resolveTrustedChild: () => Effect.die("unused"),
    assertCurrentThreadScope: () =>
      state.changed
        ? Effect.fail(
            new WorkspaceBindingResolutionError({
              operation: "assert-current-thread-scope",
              kind: "stale-authority",
            }),
          )
        : Effect.succeed(binding),
    diagnosticsForThread: () => Effect.die("unused"),
  });
};

type RenderBehavior =
  | {
      readonly _tag: "render";
      readonly overrides?: Record<string, unknown>;
      readonly blockedRequestCount?: number;
    }
  | { readonly _tag: "no-host" }
  | { readonly _tag: "rejected"; readonly reason: "page-rejected" | "too-large" | "failed" };

const makeBroker = (behavior: RenderBehavior) => {
  const invoke = vi.fn((request: PreviewAutomationBroker.PreviewAutomationInvokeInput) => {
    if (request.operation === "documentPagePdfRender") {
      if (behavior._tag === "no-host") {
        return Effect.fail({ _tag: "PreviewAutomationNoAvailableHostError" } as never);
      }
      if (behavior._tag === "rejected") {
        return Effect.succeed({
          _tag: "rejected",
          reason: behavior.reason,
          detail: "The document page did not finish rendering.",
        });
      }
      const { expected } = decodeRequest(request.input);
      return Effect.succeed({
        _tag: "rendered",
        result: {
          ...renderResultFor(expected, behavior.overrides as never),
          blockedRequestCount: behavior.blockedRequestCount ?? 0,
        },
      });
    }
    return Effect.succeed({});
  });
  return {
    invoke,
    broker: PreviewAutomationBroker.PreviewAutomationBroker.of({
      invoke,
    } as unknown as PreviewAutomationBroker.PreviewAutomationBroker["Service"]),
  };
};

const setup = async () => {
  const root = await makeFixtureDirectory(fixtures, "scient-document-export-project-");
  await writeFixtureFile(root, "notes/report.md", "# Report\n\n![Plot](plot.png)\n");
  return root;
};

const run = (
  input: { readonly sourcePath: string; readonly outputPath: string },
  context: {
    readonly root: string;
    readonly behavior?: RenderBehavior;
    readonly capabilities?: ReadonlySet<AgentInvocationContext.OperationCapability>;
    readonly authority?: { changed: boolean };
  },
) => {
  const store = makeGeneratedDocumentStore();
  const broker = makeBroker(context.behavior ?? { _tag: "render" });
  const effect = exportScientDocumentForInvocation(input).pipe(
    Effect.provideService(
      AgentInvocationContext.AgentInvocationContext,
      AgentInvocationContext.AgentInvocationContext.of({
        environmentId,
        threadId,
        providerSessionId: "session-document-export",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: context.capabilities ?? new Set(["documents:build"]),
        issuedAt: 1,
      }),
    ),
    Effect.provideService(
      WorkspaceBindingResolver,
      makeResolver(context.root, context.authority ?? { changed: false }),
    ),
    Effect.provideService(GeneratedDocumentStore, store.store),
    Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker.broker),
    Effect.provide(Layer.orDie(layer)),
  );
  return { effect, store, broker };
};

describe("scient_document_export", () => {
  it.effect("exports project Markdown to the explicit project PDF path and presents it", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(setup);
      const { effect, store, broker } = run(
        { sourcePath: "notes/report.md", outputPath: "out/report.pdf" },
        { root },
      );
      const result = yield* effect;
      expect(result).toMatchObject({
        sourcePath: "notes/report.md",
        outputPath: "out/report.pdf",
        format: "pdf",
        source: publishedSource,
        title: "Report",
        validation: "structural",
        visualReviewPerformed: false,
      });
      expect(result.warnings).toEqual([
        'resource-unresolved: Image "plot.png" was not found in the project.',
      ]);
      const request = broker.invoke.mock.calls[0]?.[0];
      expect(request?.operation).toBe("documentPagePdfRender");
      expect(request?.input).toEqual({
        inputRelativeUrl: expect.not.stringContaining(root),
        expected: expect.objectContaining({ documentKind: "workspace-file" }),
      });
      expect(broker.invoke).toHaveBeenLastCalledWith(
        expect.objectContaining({ operation: "documentPdfPresent" }),
      );
      expect(store.publishPdf).toHaveBeenCalledWith(
        expect.objectContaining({ provenanceKind: "browser-export" }),
      );
      const written = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, "out/report.pdf")),
      );
      expect(written).toEqual(Buffer.from(minimalPdf("document-page")));
    }),
  );

  it.effect("keeps the refused-request note and counts exactly what the limit left out", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(async () => {
        const directory = await makeFixtureDirectory(fixtures, "scient-document-export-notes-");
        const images = Array.from({ length: 500 }, (_, index) => `![m${index}](m${index}.png)`);
        await writeFixtureFile(directory, "notes/report.md", `# Report\n\n${images.join(" ")}\n`);
        return directory;
      });
      // 500 capture warnings and 20 page warnings: 520 distinct notes, more
      // than the export's own 512.
      const diagnostics = Array.from({ length: 20 }, (_, index) => ({
        severity: "warning",
        code: "math-unrendered",
        detail: `Math ${index} could not be typeset.`,
      }));
      const { effect } = run(
        { sourcePath: "notes/report.md", outputPath: "out/report.pdf" },
        { root, behavior: { _tag: "render", overrides: { diagnostics }, blockedRequestCount: 2 } },
      );
      const result = yield* effect;
      expect(result.warnings).toHaveLength(64);
      expect(result.warnings).toContain("resource-unresolved: 2 web resources were not loaded.");
      expect(result.warnings).toContain("blocked-external-resources");
      // 61 of the 520 are listed; the count is not taken from the export's own summary.
      expect(result.warnings.at(-1)).toBe("…and 459 more notes, listed at the end of the PDF.");
      expect(result.warnings.some((warning) => warning.includes("not listed here"))).toBe(false);
    }),
  );

  it.effect("reports an unavailable desktop without writing anything", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(setup);
      const { effect, store } = run(
        { sourcePath: "notes/report.md", outputPath: "out/report.pdf" },
        { root, behavior: { _tag: "no-host" } },
      );
      const error = yield* Effect.flip(effect);
      expect(error).toMatchObject({
        code: "renderer-unavailable",
        message: "A current connected Scient desktop is required to export this PDF.",
      });
      expect(store.beginProduction).not.toHaveBeenCalled();
      const exists = yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(root, "out/report.pdf")).then(
          () => true,
          () => false,
        ),
      );
      expect(exists).toBe(false);
    }),
  );

  it.effect("writes only to an explicit project-relative PDF path within authority", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(setup);
      for (const [outputPath, code] of [
        ["../escape.pdf", "invalid-output-path"],
        ["/tmp/absolute.pdf", "invalid-output-path"],
        ["out/report.docx", "unsupported-format"],
        ["out/report", "unsupported-format"],
      ] as const) {
        const { effect, broker } = run({ sourcePath: "notes/report.md", outputPath }, { root });
        const error = yield* Effect.flip(effect);
        expect(error.code, outputPath).toBe(code);
        expect(broker.invoke).not.toHaveBeenCalled();
      }
      const noAuthority = run(
        { sourcePath: "notes/report.md", outputPath: "out/report.pdf" },
        { root, capabilities: new Set() },
      );
      expect((yield* Effect.flip(noAuthority.effect)).code).toBe("capability-unavailable");
      const notMarkdown = run(
        { sourcePath: "notes/report.html", outputPath: "out/report.pdf" },
        { root },
      );
      expect((yield* Effect.flip(notMarkdown.effect)).code).toBe("invalid-source-path");
    }),
  );

  it.effect("refuses an unfinished page and leaves the project output untouched", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(setup);
      yield* Effect.promise(() => writeFixtureFile(root, "out/report.pdf", "previous"));
      const { effect, store } = run(
        { sourcePath: "notes/report.md", outputPath: "out/report.pdf" },
        {
          root,
          behavior: {
            _tag: "render",
            overrides: {
              diagnostics: [
                {
                  severity: "fatal",
                  code: "math-incomplete",
                  detail: "Math did not finish rendering.",
                },
              ],
            },
          },
        },
      );
      const error = yield* Effect.flip(effect);
      expect(error).toMatchObject({
        code: "render-failed",
        message: "Math did not finish rendering.",
      });
      expect(store.publishPdf).not.toHaveBeenCalled();
      const previous = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, "out/report.pdf"), "utf8"),
      );
      expect(previous).toBe("previous");
    }),
  );

  it.effect("reports a refused page and an over-limit PDF from the desktop", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(setup);
      const refused = run(
        { sourcePath: "notes/report.md", outputPath: "out/report.pdf" },
        { root, behavior: { _tag: "rejected", reason: "page-rejected" } },
      );
      expect(yield* Effect.flip(refused.effect)).toMatchObject({
        code: "render-failed",
        message: "The document page did not finish rendering.",
      });
      const tooLarge = run(
        { sourcePath: "notes/report.md", outputPath: "out/report.pdf" },
        { root, behavior: { _tag: "rejected", reason: "too-large" } },
      );
      const error = yield* Effect.flip(tooLarge.effect);
      expect(error.code).toBe("too-large");
      expect(error.message).toContain("64 MiB");
      expect(tooLarge.store.publishPdf).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps a published revision when the workspace changes before the write", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(setup);
      const authority = { changed: false };
      const { effect, store } = run(
        { sourcePath: "notes/report.md", outputPath: "out/report.pdf" },
        { root, authority },
      );
      store.publishPdf.mockImplementation(() =>
        Effect.sync(() => {
          authority.changed = true;
          return publishedSource;
        }),
      );
      const error = yield* Effect.flip(effect);
      expect(error).toMatchObject({
        code: "partial-publication",
        publishedSource,
        outputPath: "out/report.pdf",
      });
    }),
  );
});
