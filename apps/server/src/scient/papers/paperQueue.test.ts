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
import { fakeAccounts } from "../accounts/agent/AccountsService.testkit.ts";
import type * as PaperAttempt from "./paperAttempt.ts";
import { listPapers, requestPapers, resumePapers, type PaperRequester } from "./paperQueue.ts";

const fetched = vi.hoisted(() => ({
  calls: [] as Array<{ doi: string | undefined; requester: PaperRequester }>,
}));

/** No real fetching: each paper ends as its DOI says, and who it ran as is kept. */
vi.mock("./paperAttempt.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof PaperAttempt>();
  const { succeed } = await import("effect/Effect");
  const paper = { landingUrl: "https://doi.org/10.1/x", openAccess: [] };
  const fetchOnePaper: typeof actual.fetchOnePaper = (asked, requester) => {
    fetched.calls.push({ doi: asked.doi, requester });
    return succeed(
      asked.doi?.endsWith("needs-you")
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
