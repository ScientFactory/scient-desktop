import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AccountsService } from "../accounts/AccountsService.ts";
import { fakeAccounts } from "../accounts/Accounts.testkit.ts";
import { askedForLibrary, getPaperForSource } from "./getPaper.ts";
import { initializeScientProject } from "@scientfactory/project-init";
import { importScientSource } from "@scientfactory/scient-sources/store";
import * as FileSystem from "effect/FileSystem";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { userRunInvocation } from "../accounts/checkAccounts.ts";
import { ThreadId } from "@t3tools/contracts";
import type * as PaperQueue from "./paperQueue.ts";
import { ScientSourcesBackend } from "../sources/SourcesBackend.ts";

const asked = vi.hoisted(() => ({ requests: [] as Array<unknown> }));

/** The queue answers at once: the paper was saved and attached to its source. */
vi.mock("./paperQueue.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof PaperQueue>();
  const { succeed } = await import("effect/Effect");
  const item = { itemId: "item-1", doi: "10.1/x", state: "saved" as const };
  const requestPapers: typeof actual.requestPapers = (root, papers, requester) => {
    asked.requests.push({ root, papers, requester });
    return succeed([{ ...item, state: "waiting" as const }]);
  };
  const waitForPaper: typeof actual.waitForPaper = () =>
    succeed({ ...item, path: "papers/x.pdf", route: "open-access" as const, published: false });
  return { ...actual, requestPapers, waitForPaper };
});

it.effect("reports a saved paper as attached to its source, as the user's own request", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("env-fixture");
    const result = yield* getPaperForSource(
      { root: "/project", sourceId: "source-1", expectedRevision: 3, doi: "10.1/x" },
      environmentId,
    );
    expect(result).toEqual({ status: "attached", published: false });
    expect(asked.requests).toEqual([
      {
        root: "/project",
        papers: [{ doi: "10.1/x", source: { sourceId: "source-1", expectedRevision: 3 } }],
        requester: { environmentId, browser: true, accounts: "all" },
      },
    ]);
  }).pipe(
    // The queue is stubbed, so these only satisfy its signature.
    Effect.provideService(AccountsService, fakeAccounts().service),
    Effect.provideService(
      PreviewAutomationBroker,
      PreviewAutomationBroker.of({
        connect: () => Effect.succeed(Stream.empty),
        focusHost: () => Effect.void,
        respond: () => Effect.void,
        invoke: () => Effect.die("no browser in this test"),
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);

const invocationWith = (capabilities: ReadonlyArray<"accounts" | "sources:write">) => ({
  ...userRunInvocation(ThreadId.make("thread-fixture"), EnvironmentId.make("env-fixture")),
  capabilities: new Set(capabilities),
});

it.effect("files an agent's paper in the Library only with the Sources write grant", () =>
  Effect.gen(function* () {
    const paper = { doi: "10.1/x", addToLibrary: true };
    expect(
      yield* askedForLibrary("/project", paper).pipe(
        Effect.provideService(AgentInvocationContext, invocationWith(["accounts"])),
      ),
    ).toEqual({
      asked: { doi: "10.1/x" },
      note: "This conversation may not change the Library, so the PDF was only saved.",
    });
    expect(
      yield* askedForLibrary("/project", paper).pipe(
        Effect.provideService(
          AgentInvocationContext,
          invocationWith(["accounts", "sources:write"]),
        ),
      ),
    ).toEqual({ asked: { doi: "10.1/x", library: true } });
  }),
);

it.effect("attaches to a named source at its current revision, or says it is missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-paper-get-" });
    yield* Effect.promise(() => initializeScientProject({ root }));
    const { record } = yield* Effect.promise(() =>
      importScientSource({
        root,
        operationId: "op-fixture",
        candidate: {
          sourceKey: "named",
          type: "article",
          customType: null,
          title: "A named source",
          creators: [],
          issuedRaw: null,
          issuedYear: null,
          identifiers: [],
          abstract: null,
          containerTitle: null,
          publisher: null,
          volume: null,
          issue: null,
          pages: null,
          language: null,
          url: null,
          tags: [],
          externalReferences: [],
          fieldProvenance: [],
          pdfAvailable: false,
          pdfFileName: null,
          pdfAttachmentCount: 0,
        },
      }),
    );
    const ask = (sourceId: string) =>
      askedForLibrary(root, { doi: "10.1/x", sourceId }).pipe(
        Effect.provideService(
          AgentInvocationContext,
          invocationWith(["accounts", "sources:write"]),
        ),
        Effect.provideService(ScientSourcesBackend, "project"),
      );
    expect(yield* ask(record!.sourceId)).toEqual({
      asked: { doi: "10.1/x", source: { sourceId: record!.sourceId, expectedRevision: 1 } },
    });
    expect(yield* ask("source_missing")).toEqual({
      missing: "There is no source source_missing in this project's Library.",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
