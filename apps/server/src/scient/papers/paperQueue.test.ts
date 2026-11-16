import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId, type PaperQueueSummary } from "@t3tools/contracts";
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
  waitingPaperRoots,
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
  /** A paper whose DOI ends in "slow" says it started, then waits for this. */
  slow: Promise.resolve(),
  started: () => {},
}));

// vi.mock factories are hoisted above this file's imports, so they import what they use.
/** No real fetching: each paper ends as its DOI says, and who it ran as is kept. */
vi.mock("./paperAttempt.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof PaperAttempt>();
  const { gen, promise } = await import("effect/Effect");
  const fetchOnePaper: typeof actual.fetchOnePaper = (asked, requester, savedBefore) =>
    gen(function* () {
      fetched.calls.push({ doi: asked.doi, requester });
      const paper = { landingUrl: `https://doi.org/${asked.doi}`, openAccess: [] };
      const before = yield* savedBefore({
        ...paper,
        ...(asked.doi ? { doi: asked.doi } : {}),
        title: "A preprint",
      });
      if (before)
        return {
          state: "saved" as const,
          paper,
          path: before.path,
          route: "saved-before" as const,
          published: before.version === "published",
          version: before.version,
        };
      const later = asked.doi?.endsWith("later") === true;
      if (asked.doi?.endsWith("preprint") || (later && fetched.released))
        return {
          state: "saved" as const,
          paper: { ...paper, doi: asked.doi, title: "A preprint" },
          bytes: Buffer.from("%PDF-1.7\npreprint\n"),
          route: "open-access" as const,
          published: false,
          version: "preprint" as const,
        };
      if (asked.doi?.endsWith("slow")) {
        fetched.started();
        yield* promise(() => fetched.slow);
      }
      return asked.doi?.endsWith("needs-you") || asked.doi?.endsWith("slow") || later
        ? {
            state: "needs-you" as const,
            paper,
            message: "Sign in.",
            needed: { kind: "sign-in" as const, site: "Fixture University" },
          }
        : { state: "not-found" as const, message: "Not found." };
    });
  return { ...actual, fetchOnePaper };
});

const environmentId = EnvironmentId.make("env-fixture");
const user: PaperRequester = { environmentId, browser: true };
const agent: PaperRequester = {
  environmentId,
  threadId: ThreadId.make("thread-fixture"),
  browser: true,
};
const otherAgent: PaperRequester = { ...agent, threadId: ThreadId.make("thread-other") };

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
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-state-" });
    const announced = yield* Queue.unbounded<PaperQueueSummary>();
    const settled = (root: string): Effect.Effect<void> =>
      Queue.take(announced).pipe(
        Effect.flatMap((summary) =>
          summary.root === root && summary.waiting === 0 ? Effect.void : settled(root),
        ),
      );
    return yield* test(settled).pipe(
      Effect.provideService(ScientSourcesBackend, "project"),
      Effect.provideService(ServerConfig, { stateDir } as ServerConfig["Service"]),
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
        { doi: "10.1/older", requester: { environmentId, browser: false } },
      ]);
    }),
  ),
);

it.effect("asked again, a paper that waited for the person tries again as whoever asked", () =>
  withServices((settled) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      yield* requestPapers(root, [{ doi: "10.1/needs-you" }], agent);
      yield* settled(root);
      fetched.calls.length = 0;
      yield* requestPapers(root, [{ doi: "10.1/needs-you" }], otherAgent);
      yield* settled(root);
      expect(fetched.calls).toEqual([{ doi: "10.1/needs-you", requester: otherAgent }]);
      // The user's own request stays theirs when an agent asks for the same paper.
      const mine = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      yield* requestPapers(mine, [{ doi: "10.1/needs-you" }], user);
      yield* settled(mine);
      fetched.calls.length = 0;
      yield* requestPapers(mine, [{ doi: "10.1/needs-you" }], agent);
      yield* settled(mine);
      expect(fetched.calls).toEqual([{ doi: "10.1/needs-you", requester: user }]);
    }),
  ),
);

it.effect(
  "an attempt that began before the user acted doesn't leave its paper waiting on them",
  () =>
    withServices((settled) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
        const slow = Promise.withResolvers<void>();
        fetched.slow = slow.promise;
        fetched.calls.length = 0;
        const started = Promise.withResolvers<void>();
        fetched.started = started.resolve;
        yield* requestPapers(root, [{ doi: "10.1/slow" }], agent);
        yield* Effect.promise(() => started.promise);
        // The user connects while the first attempt is still out; it then comes back unanswered.
        yield* continuePapers(root, user);
        fetched.slow = Promise.resolve();
        slow.resolve();
        yield* settled(root);
        // So it goes once more, as its requester, instead of waiting on what was just done.
        expect(fetched.calls).toEqual([
          { doi: "10.1/slow", requester: agent },
          { doi: "10.1/slow", requester: agent },
        ]);
      }),
    ),
);

it.effect("reuses only a copy it recorded for this paper, with its version", () =>
  withServices((settled) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      yield* requestPapers(root, [{ doi: "10.1/preprint" }], agent);
      yield* settled(root);
      yield* requestPapers(root, [{ doi: "10.1/preprint" }, { doi: "10.1/other" }], user);
      yield* settled(root);
      expect(yield* listPapers(root)).toMatchObject([
        { doi: "10.1/preprint", route: "saved-before", published: false, version: "preprint" },
        { doi: "10.1/other", state: "not-found" },
      ]);
      // A file of the same name the queue didn't save, that doesn't read as this paper, isn't it.
      const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      yield* fs.makeDirectory(path.join(elsewhere, "papers"));
      yield* fs.writeFileString(path.join(elsewhere, "papers", "A-preprint.pdf"), "not a PDF");
      yield* requestPapers(elsewhere, [{ doi: "10.1/preprint" }], agent);
      yield* settled(elsewhere);
      expect(yield* listPapers(elsewhere)).toMatchObject([
        { route: "open-access", path: "papers/A-preprint-2.pdf" },
      ]);
    }),
  ),
);

it.effect("sets an unreadable queue file aside instead of overwriting it", () =>
  withServices(() =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* restarted("{ not json");
      expect(yield* listPapers(root)).toEqual([]);
      expect(yield* fs.readFileString(`${yield* queueFile(root)}.unreadable`)).toBe(
        JSON.stringify("{ not json"),
      );
    }),
  ),
);

it.effect("finds a project's papers waiting on the user after a restart, until they finish", () =>
  withServices((settled) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-papers-" });
      fetched.released = false;
      yield* requestPapers(root, [{ doi: "10.1/listed-later" }], agent);
      yield* settled(root);
      expect(yield* waitingPaperRoots()).toContain(root);
      fetched.released = true;
      yield* continuePapers(root, user);
      yield* settled(root);
      expect(yield* waitingPaperRoots()).not.toContain(root);
      fetched.released = false;
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
