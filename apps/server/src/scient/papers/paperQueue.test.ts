import * as NodeServices from "@effect/platform-node/NodeServices";
import { AccountId, EnvironmentId, ThreadId, type PaperQueueSummary } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { vi } from "vite-plus/test";
import { AccountsService } from "../accounts/AccountsService.ts";
import { fakeAccounts } from "../accounts/Accounts.testkit.ts";
import type * as PaperAttempt from "./paperAttempt.ts";
import {
  continuePapers,
  listPapers,
  requestPapers,
  resumePapers,
  type PaperRequester,
} from "./paperQueue.ts";
import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import { importScientSource, listScientSourceRecords } from "@scientfactory/scient-sources/store";
import {
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import { readScientProjectPins } from "@scientfactory/scient-sources/project-pins";
import { sourceAttachmentAbsolutePath } from "@scientfactory/scient-sources/store";
import { ServerConfig } from "../../config.ts";
import {
  SourceIdentifierLookup,
  verifiableSourceIdentifier,
  type ResolveSourceIdentifier,
} from "../sources/SourceIdentifierResolver.ts";
import { ScientSourcesBackend } from "../sources/SourcesBackend.ts";

const fetched = vi.hoisted(() => ({
  calls: [] as Array<{ doi: string | undefined; requester: PaperRequester }>,
  /** A paper whose DOI ends in "later" needs the person until this is set. */
  released: false,
}));

/** No real fetching: each paper ends as its DOI says, and who it ran as is kept. */
vi.mock("./paperAttempt.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof PaperAttempt>();
  const { succeed } = await import("effect/Effect");
  const paper = { landingUrl: "https://doi.org/10.1/x", openAccess: [] };
  const fetchOnePaper: typeof actual.fetchOnePaper = (asked, requester) => {
    fetched.calls.push({ doi: asked.doi, requester });
    const later = asked.doi?.endsWith("later") === true;
    if (asked.doi?.endsWith("preprint") || (later && fetched.released))
      return succeed({
        state: "saved" as const,
        paper: { ...paper, doi: asked.doi, title: "A preprint", openAccess: [] },
        bytes: Buffer.from("%PDF-1.7\npreprint\n"),
        route: "open-access" as const,
        published: false,
        version: "preprint" as const,
      });
    return succeed(
      asked.doi?.endsWith("needs-you") || later
        ? {
            state: "needs-you" as const,
            paper,
            message: "Sign in.",
            needed: { kind: "sign-in" as const, site: "Fixture University" },
          }
        : { state: "not-found" as const, message: "Not found." },
    );
  };
  return { ...actual, fetchOnePaper };
});

const environmentId = EnvironmentId.make("env-fixture");
const user: PaperRequester = { environmentId, browser: true, accounts: "all" };
const agent: PaperRequester = {
  environmentId,
  threadId: ThreadId.make("thread-fixture"),
  browser: true,
  accounts: [AccountId.make("acc_fixture1")],
};

const queueFile = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(root, ".scient", "papers", "queue.json");
  });

const readQueue = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return JSON.parse(yield* fs.readFileString(yield* queueFile(root)));
  });

/** A project no queue in memory knows yet, as after a restart, holding this queue file. */
const restarted = (stored: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
    const file = yield* queueFile(root);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, JSON.stringify(stored));
    return root;
  });

/** A Library source for this DOI, with no PDF yet. */
const sourceFor = (root: string, doi: string) =>
  Effect.promise(async () => {
    await initializeScientProject({ root });
    const candidate: ScientSourceCandidate = {
      sourceKey: "fixture",
      type: "article",
      customType: null,
      title: "A source waiting for its PDF",
      creators: [],
      issuedRaw: null,
      issuedYear: null,
      identifiers: [{ scheme: "doi", value: doi }],
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
    };
    const { record } = await importScientSource({ root, operationId: "fixture", candidate });
    return { sourceId: record!.sourceId, expectedRevision: record!.revision };
  });

/** Runs a test whose `settled` waits until the queue has stored and shown nothing waiting. */
const withServices = <A, E>(
  test: (
    settled: (root: string) => Effect.Effect<void>,
  ) => Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | AccountsService
    | HttpClient.HttpClient
    | PreviewAutomationBroker
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const announced = yield* Queue.unbounded<PaperQueueSummary>();
    const settled = (root: string): Effect.Effect<void> =>
      Queue.take(announced).pipe(
        Effect.flatMap((summary) =>
          summary.root === root && summary.waiting === 0 ? Effect.void : settled(root),
        ),
      );
    return yield* test(settled).pipe(
      Effect.provideService(ScientSourcesBackend, "project"),
      Effect.provideService(AccountsService, {
        ...fakeAccounts().service,
        setPaperQueue: (summary) => Queue.offer(announced, summary).pipe(Effect.asVoid),
      }),
      // The fetching is stubbed, so neither the network nor the browser is ever reached.
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("no network in this test")),
      ),
      Effect.provideService(
        PreviewAutomationBroker,
        PreviewAutomationBroker.of({
          connect: () => Effect.succeed(Stream.empty),
          focusHost: () => Effect.void,
          respond: () => Effect.void,
          invoke: () => Effect.die("no browser in this test"),
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("keeps an agent's limited access across a restart, whoever resumes the queue", () =>
  withServices((settled) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      const [item] = yield* requestPapers(root, [{ doi: "10.1/needs-you" }], agent);
      yield* settled(root);
      const stored = yield* readQueue(root);
      // Waiting on the person, it keeps its requester for when it runs again.
      expect(stored.requesters).toEqual({ [item!.itemId]: agent });

      const interrupted = {
        ...stored,
        items: stored.items.map(({ itemId, doi }: { itemId: string; doi: string }) => ({
          itemId,
          doi,
          state: "waiting",
        })),
      };
      const fresh = yield* restarted(interrupted);
      expect(yield* listPapers(fresh)).toEqual(interrupted.items);
      fetched.calls.length = 0;
      yield* resumePapers(fresh, user);
      yield* settled(fresh);
      expect(fetched.calls).toEqual([{ doi: "10.1/needs-you", requester: agent }]);
    }),
  ),
);

it.effect("runs a paper from an older queue file with free copies only", () =>
  withServices((settled) =>
    Effect.gen(function* () {
      const root = yield* restarted({
        items: [{ itemId: "item-older", doi: "10.1/older", state: "waiting" }],
      });
      fetched.calls.length = 0;
      yield* resumePapers(root, user);
      yield* settled(root);
      expect(fetched.calls).toEqual([
        { doi: "10.1/older", requester: { environmentId, browser: false, accounts: [] } },
      ]);
    }),
  ),
);

it.effect("forgets who asked once a paper is finished", () =>
  withServices((settled) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      yield* requestPapers(root, [{ doi: "10.1/gone" }], agent);
      yield* settled(root);
      const stored = yield* readQueue(root);
      expect(stored.items).toMatchObject([{ doi: "10.1/gone", state: "not-found" }]);
      expect(stored.requesters).toEqual({});
    }),
  ),
);

/** Every identifier resolves to the same registry record. */
const foundInRegistry: ResolveSourceIdentifier = async (identifiers) => {
  const identifier = verifiableSourceIdentifier(identifiers)!;
  return {
    status: "found",
    identifier,
    retrievedAt: "2026-11-10T00:00:00.000Z",
    metadata: {
      type: "article",
      title: "The registry's title",
      creators: [],
      issuedRaw: "2026",
      issuedYear: 2026,
      identifiers: [identifier],
      abstract: "An abstract, so no enrichment is looked up.",
      abstractSections: [],
      containerTitle: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: null,
    },
  };
};

it.effect("files a paper asked for the Library on a new source, credited to the agent", () =>
  withServices((settled) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      yield* Effect.promise(() => initializeScientProject({ root }));
      yield* requestPapers(root, [{ doi: "10.1/preprint", library: true }], agent);
      yield* settled(root);

      const records = yield* Effect.promise(() => listScientSourceRecords(root));
      expect(records).toMatchObject([
        {
          title: "The registry's title",
          origin: { actor: "agent", intake: "paper" },
          verification: { state: "verified" },
          attachments: [{ retrieval: { route: "open-access", version: "preprint" } }],
        },
      ]);
      expect(yield* listPapers(root)).toMatchObject([
        {
          state: "saved",
          version: "preprint",
          path: "papers/A-preprint.pdf",
          sourceId: records[0]!.sourceId,
        },
      ]);
    }).pipe(Effect.provideService(SourceIdentifierLookup, foundInRegistry)),
  ),
);

it.effect("on the library backend, files a paper on a library record pinned in its project", () =>
  withServices((settled) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-state-" });
      yield* Effect.promise(() => initializeScientProject({ root }));
      yield* requestPapers(root, [{ doi: "10.1/preprint", library: true }], agent).pipe(
        Effect.provideService(ServerConfig, { stateDir } as ServerConfig["Service"]),
        Effect.provideService(ScientSourcesBackend, "library"),
      );
      yield* settled(root);

      const library = scientLibraryLocation(scientLibraryRootFor(stateDir));
      const records = yield* Effect.promise(() => listScientSourceRecords(library));
      expect(records).toMatchObject([
        { title: "The registry's title", origin: { actor: "agent", intake: "paper" } },
      ]);
      const pdf = sourceAttachmentAbsolutePath(library, records[0]!.attachments[0]!);
      expect(pdf.startsWith(path.join(library.root, "files"))).toBe(true);
      expect(yield* fs.exists(pdf)).toBe(true);
      expect(yield* Effect.promise(() => readScientProjectPins(root))).toMatchObject([
        { sourceId: records[0]!.sourceId },
      ]);
      expect(yield* fs.exists(path.join(root, ".scient", "sources", "records"))).toBe(false);
    }).pipe(Effect.provideService(SourceIdentifierLookup, foundInRegistry)),
  ),
);

it.effect("credits an agent's PDF on a named source to the agent", () =>
  withServices((settled) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      const source = yield* sourceFor(root, "10.1/preprint");
      yield* requestPapers(root, [{ doi: "10.1/preprint", source }], agent);
      yield* settled(root);

      expect(yield* Effect.promise(() => listScientSourceRecords(root))).toMatchObject([
        { sourceId: source.sourceId, updatedBy: "agent", attachments: [{}] },
      ]);
    }),
  ),
);

it.effect("files a waiting paper on the source a later request names", () =>
  withServices((settled) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      const source = yield* sourceFor(root, "10.1/later");
      yield* requestPapers(root, [{ doi: "10.1/later" }], user);
      yield* settled(root);
      yield* requestPapers(root, [{ doi: "10.1/later", source }], agent);
      yield* settled(root);
      fetched.released = true;
      yield* continuePapers(root, user);
      yield* settled(root);

      expect(yield* listPapers(root)).toMatchObject([
        { state: "saved", sourceId: source.sourceId },
      ]);
      expect(yield* Effect.promise(() => listScientSourceRecords(root))).toMatchObject([
        { sourceId: source.sourceId, updatedBy: "agent", attachments: [{}] },
      ]);
    }),
  ),
);

it.effect("keeps the credit of a named source when a Library request joins it", () =>
  withServices((settled) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      const source = yield* sourceFor(root, "10.1/joined-later");
      fetched.released = false;
      yield* requestPapers(root, [{ doi: "10.1/joined-later", source }], user);
      yield* settled(root);
      yield* requestPapers(root, [{ doi: "10.1/joined-later", library: true }], agent);
      yield* settled(root);
      fetched.released = true;
      yield* continuePapers(root, user);
      yield* settled(root);

      expect(yield* Effect.promise(() => listScientSourceRecords(root))).toMatchObject([
        { sourceId: source.sourceId, updatedBy: "user", attachments: [{}] },
      ]);
    }),
  ),
);
