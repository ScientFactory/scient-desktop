/**
 * DesktopUpdateFacts - persisted update facts, kept until one backend's analytics outbox holds
 * them: installs run with every backend stopped, and apply outcomes precede any backend.
 * @module DesktopUpdateFacts
 */
import {
  DESKTOP_UPDATE_FACTS_LIMIT,
  DesktopUpdateFact,
  type DesktopUpdateFact as DesktopUpdateFactValue,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../../app/DesktopManagedPolicy.ts";
import * as DesktopObservability from "../../app/DesktopObservability.ts";
// Read only at call time: the backend manager's stream imports this module.
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import { scientAnalyticsMetadata } from "../../backend/scientAnalyticsMetadata.ts";

export const DESKTOP_UPDATE_FACTS_FILE = "desktop-update-facts.json";
const MAX_FACT_AGE_MS = 14 * 86_400_000;

const Journal = Schema.Struct({
  version: Schema.Literal(1),
  /** Facts dropped for room or age since a summary last reported the count. */
  dropped: Schema.Number,
  facts: Schema.Array(DesktopUpdateFact),
});
type Journal = typeof Journal.Type;
const JournalJson = Schema.fromJsonString(Journal);
const decodeJournal = Schema.decodeUnknownEffect(JournalJson);
const encodeJournal = Schema.encodeEffect(JournalJson);

export type DesktopUpdateFactProperties = Readonly<Record<string, string | number | boolean>>;

export class DesktopUpdateFacts extends Context.Service<
  DesktopUpdateFacts,
  {
    /** Journals a fact and offers the journal to the designated backend; off records nothing. */
    readonly record: (
      name: DesktopUpdateFactValue["name"],
      properties: DesktopUpdateFactProperties,
    ) => Effect.Effect<void>;
    /** The facts offered to one backend; each offer carries every pending fact. */
    readonly deliveries: (sourceId: string) => Stream.Stream<ReadonlyArray<DesktopUpdateFactValue>>;
    readonly sourceReady: (sourceId: string) => Effect.Effect<void>;
    readonly sourceRemoved: (sourceId: string) => Effect.Effect<void>;
    /** The backend's outbox holds these facts, or analytics there must never send them. */
    readonly acknowledge: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/scient/updateOutcomes/DesktopUpdateFacts") {}

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-update-facts");

const emptyJournal: Journal = { version: 1, dropped: 0, facts: [] };

/** Keeps the newest facts within the count and age bounds, counting what it drops. */
function boundJournal(journal: Journal, nowMs: number): Journal {
  const fresh = journal.facts.filter((fact) => {
    const occurredAt = Date.parse(fact.occurredAt);
    return Number.isFinite(occurredAt) && nowMs - occurredAt <= MAX_FACT_AGE_MS;
  });
  const kept = fresh.slice(-DESKTOP_UPDATE_FACTS_LIMIT);
  return {
    version: 1,
    dropped: journal.dropped + journal.facts.length - kept.length,
    facts: kept,
  };
}

/** Primary when it is ready; otherwise the earliest ready backend, as in a WSL-only setup. */
function designatedSource(ready: ReadonlyArray<string>): string | undefined {
  const primary = DesktopBackendManager.PRIMARY_INSTANCE_ID;
  return ready.includes(primary) ? primary : ready[0];
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const env = yield* HostProcess.Environment;
  const metadata = scientAnalyticsMetadata(environment, env.SCIENT_ANALYTICS_ENABLED);
  // Read once and shared with the updater's policy; a policy that cannot be used counts as off.
  const telemetryAllowed = yield* (yield* DesktopManagedPolicy.DesktopManagedPolicy).read.pipe(
    Effect.map((found) => found?.document?.limits?.telemetry !== false),
    Effect.orElseSucceed(() => false),
  );
  const consent = env.SCIENT_ANALYTICS_CONSENT ?? "diagnostic";
  const enabled =
    metadata.SCIENT_ANALYTICS_ENABLED === "true" &&
    telemetryAllowed &&
    ["essential", "product", "diagnostic"].includes(consent);
  const buildChannel =
    metadata.SCIENT_ANALYTICS_BUILD_CHANNEL as DesktopUpdateFactValue["buildChannel"];

  const directory = environment.path.join(environment.baseDir, "runtime");
  const journalPath = environment.path.join(directory, DESKTOP_UPDATE_FACTS_FILE);
  const temporaryPath = `${journalPath}.tmp`;
  const writeLock = yield* Semaphore.make(1);

  const persist = (journal: Journal) =>
    encodeJournal(journal).pipe(
      Effect.flatMap((text) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(fileSystem.writeFileString(temporaryPath, text)),
            Effect.andThen(fileSystem.rename(temporaryPath, journalPath)),
          ),
      ),
      Effect.catch((error) =>
        logWarning("Could not save the update facts journal.", { errorTag: error._tag }),
      ),
    );

  const nowMs = Clock.currentTimeMillis;
  const loaded = yield* fileSystem.readFileString(journalPath).pipe(
    Effect.flatMap(decodeJournal),
    Effect.orElseSucceed(() => emptyJournal),
  );
  // Facts are never kept for a session that may not send them, nor sent from one later.
  const initial = enabled ? boundJournal(loaded, yield* nowMs) : emptyJournal;
  if (!enabled && loaded.facts.length > 0) {
    yield* fileSystem.remove(journalPath, { force: true }).pipe(Effect.ignore);
  }
  const journalRef = yield* Ref.make(initial);
  const readyRef = yield* Ref.make<ReadonlyArray<string>>([]);
  const offers = yield* PubSub.unbounded<{
    readonly sourceId: string;
    readonly facts: ReadonlyArray<DesktopUpdateFactValue>;
  }>();

  const offer = Effect.gen(function* () {
    const target = designatedSource(yield* Ref.get(readyRef));
    const { facts } = yield* Ref.get(journalRef);
    if (target === undefined || facts.length === 0) return;
    yield* PubSub.publish(offers, { sourceId: target, facts });
  });

  const update = (f: (journal: Journal, nowMs: number) => Journal) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const next = f(yield* Ref.get(journalRef), yield* nowMs);
        yield* Ref.set(journalRef, next);
        yield* persist(next);
      }),
    );

  const record = Effect.fn("DesktopUpdateFacts.record")(function* (
    name: DesktopUpdateFactValue["name"],
    properties: DesktopUpdateFactProperties,
  ) {
    if (!enabled) return;
    const id = yield* random.uuidV4();
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    yield* update((journal, now) => {
      // A summary reports the drops since the last one; its own fact then carries the count.
      const reportsDrops = name === "app.update.summary";
      const fact: DesktopUpdateFactValue = {
        id,
        name,
        occurredAt,
        appVersion: metadata.SCIENT_ANALYTICS_APP_VERSION,
        buildChannel,
        properties: reportsDrops
          ? { ...properties, droppedFactCount: journal.dropped }
          : properties,
      };
      return boundJournal(
        {
          version: 1,
          dropped: reportsDrops ? 0 : journal.dropped,
          facts: [...journal.facts, fact],
        },
        now,
      );
    });
    yield* offer;
  });

  return DesktopUpdateFacts.of({
    record,
    deliveries: (sourceId) =>
      Stream.fromPubSub(offers).pipe(
        Stream.filter((delivery) => delivery.sourceId === sourceId),
        Stream.map((delivery) => delivery.facts),
      ),
    sourceReady: Effect.fn("DesktopUpdateFacts.sourceReady")(function* (sourceId) {
      yield* Ref.update(readyRef, (ready) =>
        ready.includes(sourceId) ? ready : [...ready, sourceId],
      );
      yield* offer;
    }),
    sourceRemoved: Effect.fn("DesktopUpdateFacts.sourceRemoved")(function* (sourceId) {
      const designated = yield* Ref.modify(readyRef, (ready) => [
        designatedSource(ready) === sourceId,
        ready.filter((id) => id !== sourceId),
      ]);
      if (designated) yield* offer;
    }),
    acknowledge: Effect.fn("DesktopUpdateFacts.acknowledge")(function* (ids) {
      yield* update((journal) => ({
        ...journal,
        facts: journal.facts.filter((fact) => !ids.includes(fact.id)),
      }));
    }),
  });
});

export const layer = Layer.effect(DesktopUpdateFacts, make);
