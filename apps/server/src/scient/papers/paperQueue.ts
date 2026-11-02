// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AccountId,
  AccountsError,
  EnvironmentId,
  PaperItem,
  ThreadId,
  type PaperAsked,
  type PaperQueueSummary,
  type PaperRequest,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { AccountsService } from "../accounts/AccountsService.ts";
import { userRunInvocation } from "../accounts/checkAccounts.ts";
import { attachSourcePdf } from "../sources/ScientSourcesCoordinator.ts";
import {
  PAPERS_THREAD,
  clearHolds,
  fetchOnePaper,
  pausedPublishers,
  type PaperRequester,
} from "./paperAttempt.ts";
import { paperFileName, type Paper } from "./paperLookup.ts";

export type { PaperRequester } from "./paperAttempt.ts";

const QUEUE_FILE = [".scient", "papers", "queue.json"] as const;
/** After the user acts, a sign-in may take a while to finish: keep trying for ten minutes. */
const RETRY_GAP = "30 seconds";
const RETRIES_AFTER_ACTING = 20;
const BROWSER_RETRY_GAP = "1 minute";
const MOST_BROWSER_FAILURES = 5;

const StoredRequester = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: Schema.optionalKey(ThreadId),
  browser: Schema.Boolean,
  accounts: Schema.Union([Schema.Literal("all"), Schema.Array(AccountId)]),
});
const Stored = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  items: Schema.Array(PaperItem),
  /** Who asked for each paper, so a restart keeps it to what they may use. */
  requesters: Schema.optional(Schema.Record(Schema.String, StoredRequester)),
});
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(Stored));

interface Queue {
  readonly root: string;
  threadId: ThreadId | undefined;
  items: Map<string, PaperItem>;
  running: boolean;
  retries: number;
  /** Whoever last acted here: the environment the queue runs in. */
  requester: PaperRequester;
  /** Each paper runs with what its requester may use, whoever else asked since. */
  readonly requesters: Map<string, PaperRequester>;
  browserDown: boolean;
  readonly browserFailures: Map<string, number>;
}
const queues = new Map<string, Queue>();

const savePdf = Effect.fn("Papers.save")(
  function* (root: string, paper: Paper, bytes: Uint8Array) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = path.join(root, "papers");
    yield* fs.makeDirectory(folder, { recursive: true });
    const name = paperFileName(paper);
    for (let copy = 1; ; copy += 1) {
      const file = copy === 1 ? name : name.replace(/\.pdf$/u, `-${copy}.pdf`);
      const target = path.join(folder, file);
      // Exclusive, so two saves of different papers can't take the same name.
      const created = yield* fs.writeFile(target, bytes, { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
      );
      if (created) return `papers/${file}`;
      // The same paper again reuses its file.
      if (Buffer.from(yield* fs.readFile(target)).equals(Buffer.from(bytes)))
        return `papers/${file}`;
    }
  },
  Effect.mapError(
    () => new AccountsError({ reason: "unavailable", message: "The PDF could not be saved." }),
  ),
);

/** The queue survives a restart in the project, next to its sources. */
const store = Effect.fn("Papers.queue.store")(function* (queue: Queue) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(queue.root, ...QUEUE_FILE);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(
    file,
    encodeStored({
      ...(queue.threadId === undefined ? {} : { threadId: queue.threadId }),
      items: [...queue.items.values()],
      requesters: Object.fromEntries(
        [...queue.requesters].filter(([itemId]) => queue.items.has(itemId)),
      ),
    }),
  );
});

const readStored = Effect.fn("Papers.queue.read")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(root, ...QUEUE_FILE))
    .pipe(Effect.orElseSucceed(() => undefined));
  return text === undefined ? Option.none() : decodeStored(text);
});

const load = Effect.fn("Papers.queue.load")(function* (root: string, requester: PaperRequester) {
  const known = queues.get(root);
  if (known) return known;
  const stored = yield* readStored(root);
  const queue: Queue = {
    root,
    threadId: Option.isSome(stored) ? stored.value.threadId : undefined,
    items: new Map(
      (Option.isSome(stored) ? stored.value.items : []).map((item) => [item.itemId, item]),
    ),
    running: false,
    retries: 0,
    requester,
    requesters: new Map(
      Object.entries(Option.isSome(stored) ? (stored.value.requesters ?? {}) : {}),
    ),
    browserDown: false,
    browserFailures: new Map(),
  };
  queues.set(root, queue);
  return queue;
});

const summary = (queue: Queue, now: number): PaperQueueSummary => {
  const items = [...queue.items.values()];
  const requests = new Map<string, PaperRequest>();
  for (const { needed } of items) {
    if (!needed) continue;
    const key = `${needed.kind}|${needed.site ?? ""}`;
    requests.set(key, { ...needed, count: (requests.get(key)?.count ?? 0) + 1 });
  }
  return {
    root: queue.root,
    ...(queue.threadId === undefined ? {} : { threadId: queue.threadId }),
    waiting: items.filter((item) => item.state === "waiting").length,
    saved: items.filter((item) => item.state === "saved").length,
    failed: items.filter((item) => item.state === "no-access" || item.state === "not-found").length,
    requests: [...requests.values()],
    paused: pausedPublishers(now).map(({ site, until }) => ({
      site,
      until: DateTime.formatIso(DateTime.makeUnsafe(until)),
    })),
  };
};

const announce = Effect.fn("Papers.queue.announce")(function* (queue: Queue) {
  const accounts = yield* AccountsService;
  yield* store(queue).pipe(Effect.ignore);
  yield* accounts.setPaperQueue(summary(queue, yield* Clock.currentTimeMillis));
});

const attach = Effect.fn("Papers.attach")(function* (
  root: string,
  source: NonNullable<PaperAsked["source"]>,
  relative: string,
) {
  const path = yield* Path.Path;
  return yield* Effect.tryPromise({
    try: () =>
      attachSourcePdf({
        root,
        sourceId: source.sourceId,
        expectedRevision: source.expectedRevision,
        pdfPath: path.join(root, relative),
        fileName: path.basename(relative),
      }),
    catch: () =>
      new AccountsError({
        reason: "unavailable",
        message: `The PDF is in ${relative}, but it could not be attached to this source.`,
      }),
  });
});

const runItem = Effect.fn("Papers.queue.item")(function* (queue: Queue, item: PaperItem) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const savedBefore = (paper: Paper) => {
    const relative = `papers/${paperFileName(paper)}`;
    return fs.exists(path.join(queue.root, relative)).pipe(
      Effect.map((exists) => (exists ? relative : undefined)),
      Effect.orElseSucceed(() => undefined),
    );
  };
  // A paper from an older queue file has no record of who asked, so it gets free copies only.
  const requester: PaperRequester = queue.requesters.get(item.itemId) ?? {
    environmentId: queue.requester.environmentId,
    browser: false,
    accounts: [],
  };
  const fetched = yield* fetchOnePaper(item, requester, savedBefore).pipe(
    Effect.catch((error) =>
      Effect.succeed({ state: "no-access" as const, message: error.message, broken: true }),
    ),
  );
  // The browser going away says nothing about the paper, so it waits for the browser instead.
  const failures = (queue.browserFailures.get(item.itemId) ?? 0) + 1;
  if ("broken" in fetched && failures < MOST_BROWSER_FAILURES) {
    queue.browserFailures.set(item.itemId, failures);
    queue.browserDown = true;
    return;
  }
  const { itemId, doi, url, source } = item;
  const base = {
    itemId,
    ...(doi ? { doi } : {}),
    ...(url ? { url } : {}),
    ...(source ? { source } : {}),
    title: ("paper" in fetched ? fetched.paper?.title : undefined) ?? item.title,
  };
  const known = base.title === undefined ? (({ title: _, ...rest }) => rest)(base) : base;
  const result = yield* Effect.gen(function* () {
    if (fetched.state !== "saved")
      return fetched.state === "needs-you"
        ? ({
            ...known,
            state: "needs-you",
            message: fetched.message,
            needed: fetched.needed,
          } as const)
        : ({ ...known, state: fetched.state, message: fetched.message } as const);
    const saved = fetched.path ?? (yield* savePdf(queue.root, fetched.paper, fetched.bytes!));
    const attached = source ? yield* attach(queue.root, source, saved) : undefined;
    return {
      ...known,
      state: "saved",
      route: fetched.route,
      published: fetched.published,
      path: saved,
      ...(attached?.outcome === "stale"
        ? { message: `This source changed meanwhile; attach ${saved} from there.` }
        : {}),
    } as const;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({ ...known, state: "no-access", message: error.message } as const),
    ),
  );
  // A finished paper runs no more; one waiting or needing the person runs again as its requester.
  if (result.state === "saved" || result.state === "no-access" || result.state === "not-found")
    queue.requesters.delete(itemId);
  queue.items.set(itemId, result);
  yield* announce(queue);
});

const wake = (queue: Queue) => {
  for (const item of queue.items.values())
    if (item.state === "needs-you" && item.needed?.kind !== "university") {
      const { needed: _, message: __, ...rest } = item;
      queue.items.set(item.itemId, { ...rest, state: "waiting" });
    }
};

/** Runs until nothing is waiting: publishers side by side, each one at a reader's pace. */
const work = Effect.fn("Papers.queue.work")(function* (queue: Queue) {
  while (true) {
    if (queue.browserDown) {
      queue.browserDown = false;
      yield* Effect.sleep(BROWSER_RETRY_GAP);
    }
    const waiting = [...queue.items.values()].filter((item) => item.state === "waiting");
    if (waiting.length > 0) {
      yield* Effect.forEach(waiting, (item) => runItem(queue, item), {
        concurrency: "unbounded",
        discard: true,
      });
      continue;
    }
    const stuck = [...queue.items.values()].some(
      (item) => item.state === "needs-you" && item.needed?.kind !== "university",
    );
    if (queue.retries <= 0 || !stuck) break;
    queue.retries -= 1;
    yield* Effect.sleep(RETRY_GAP);
    clearHolds();
    wake(queue);
    yield* announce(queue);
  }
  queue.running = false;
});

const ensureRunning = Effect.fn("Papers.queue.run")(function* (queue: Queue) {
  if (queue.running) return;
  queue.running = true;
  yield* work(queue).pipe(
    Effect.provideService(
      AgentInvocationContext,
      userRunInvocation(PAPERS_THREAD, queue.requester.environmentId),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        queue.running = false;
      }),
    ),
    Effect.forkDetach,
  );
});

const sameAsked = (a: PaperAsked, b: PaperAsked) =>
  (a.doi !== undefined && a.doi.toLowerCase() === b.doi?.toLowerCase()) ||
  (a.doi === undefined && b.doi === undefined && a.url !== undefined && a.url === b.url);

/** Adds papers to the project's queue and returns them; a paper already queued is not repeated. */
export const requestPapers = Effect.fn("Papers.queue.request")(function* (
  root: string,
  papers: ReadonlyArray<PaperAsked>,
  requester: PaperRequester,
) {
  const queue = yield* load(root, requester);
  queue.requester = requester;
  if (requester.threadId !== undefined) queue.threadId = requester.threadId;
  const unfinished = [...queue.items.values()].some(
    (item) => item.state === "waiting" || item.state === "needs-you",
  );
  // A finished list has been read by whoever asked; a new list starts afresh. One paper joins it,
  // so a Get PDF doesn't wipe a list an agent hasn't read yet.
  if (!unfinished && papers.length > 1) {
    queue.items.clear();
    queue.requesters.clear();
  }
  const items = papers.map((asked) => {
    const existing = [...queue.items.values()].find(
      (item) => sameAsked(item, asked) && item.state !== "no-access" && item.state !== "not-found",
    );
    if (existing) return existing;
    const item: PaperItem = { ...asked, itemId: NodeCrypto.randomUUID(), state: "waiting" };
    queue.items.set(item.itemId, item);
    queue.requesters.set(item.itemId, requester);
    return item;
  });
  yield* announce(queue);
  yield* ensureRunning(queue);
  return items;
});

/** The user signed in, passed a check or connected their university: everything waiting goes on. */
export const continuePapers = Effect.fn("Papers.queue.continue")(function* (
  root: string,
  requester: PaperRequester,
) {
  const queue = yield* load(root, requester);
  queue.requester = requester;
  clearHolds();
  for (const item of queue.items.values())
    if (item.state === "needs-you") {
      const { needed: _, message: __, ...rest } = item;
      queue.items.set(item.itemId, { ...rest, state: "waiting" });
    }
  queue.retries = RETRIES_AFTER_ACTING;
  yield* announce(queue);
  yield* ensureRunning(queue);
});

/** The projects with papers waiting for the person. */
export const waitingPaperRoots = () =>
  [...queues.values()]
    .filter(({ items }) => [...items.values()].some((item) => item.state === "needs-you"))
    .map(({ root }) => root);

export const paperQueueRunning = (root: string) => queues.get(root)?.running === true;

/** A project's papers as they stand. */
export const listPapers = Effect.fn("Papers.queue.list")(function* (root: string) {
  const known = queues.get(root);
  if (known) return [...known.items.values()];
  const stored = yield* readStored(root);
  return Option.isSome(stored) ? stored.value.items : [];
});

/** Picks up a list a restart interrupted, and shows it again. */
export const resumePapers = Effect.fn("Papers.queue.resume")(function* (
  root: string,
  requester: PaperRequester,
) {
  const queue = yield* load(root, requester);
  yield* announce(queue);
  yield* ensureRunning(queue);
  return [...queue.items.values()];
});

/** The paper's state once it stops waiting, or undefined if it's still waiting by the deadline. */
export const waitForPaper = Effect.fn("Papers.queue.wait")(function* (
  root: string,
  itemId: string,
  patience: Duration.Input,
) {
  const settled = Effect.gen(function* () {
    while (true) {
      const item = queues.get(root)?.items.get(itemId);
      if (item === undefined || item.state !== "waiting") return item;
      yield* Effect.sleep("1 second");
    }
  });
  return Option.getOrUndefined(yield* settled.pipe(Effect.timeoutOption(patience)));
});
