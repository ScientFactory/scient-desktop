import { LEGACY_WORDS_TRANSITION_ENABLED } from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import type { ClientSettings, EnvironmentId, SpeechCustomWords } from "@t3tools/contracts";

function importId(words: SpeechCustomWords): string {
  return Array.from(
    sha256(
      new TextEncoder().encode(JSON.stringify(words.map(({ term, aliases }) => [term, aliases]))),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function startLegacySpeechWordsMigration(input: {
  readonly read: () => ClientSettings;
  readonly send: (
    environmentId: EnvironmentId,
    batch: { id: string; words: SpeechCustomWords },
  ) => Promise<readonly string[]>;
  readonly persist: (update: (current: ClientSettings) => ClientSettings) => Promise<unknown>;
  readonly targets: () => readonly EnvironmentId[];
  readonly subscribe: (wake: () => void) => () => void;
}): () => void {
  if (!LEGACY_WORDS_TRANSITION_ENABLED) return () => {};
  let active = true;
  const running = new Set<EnvironmentId>();
  const delays = new Map<EnvironmentId, number>();
  const timers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();

  function wake() {
    if (!active) return;
    const { speechCustomWords, legacySpeechWordsArchive = [] } = input.read();
    const batches = [...legacySpeechWordsArchive];
    if (speechCustomWords !== undefined) {
      const id = importId(speechCustomWords);
      if (!batches.some((batch) => batch.id === id))
        batches.push({ id, words: speechCustomWords, acknowledged: [] });
    }

    for (const environmentId of input.targets()) {
      if (running.has(environmentId) || timers.has(environmentId)) continue;
      const batch = batches.find(({ acknowledged }) => !acknowledged.includes(environmentId));
      if (!batch) continue;
      running.add(environmentId);
      void importBatch(environmentId, batch);
    }
  }

  async function importBatch(
    environmentId: EnvironmentId,
    { id, words }: { id: string; words: SpeechCustomWords },
  ) {
    try {
      const receipts = await input.send(environmentId, { id, words });
      if (!receipts.includes(id)) throw new Error("Missing Words import receipt");
      if (!active) return;
      await input.persist((current) => {
        const { speechCustomWords, legacySpeechWordsArchive = [], ...settings } = current;
        const existing = legacySpeechWordsArchive.find((batch) => batch.id === id);
        const acknowledged = [...new Set([...(existing?.acknowledged ?? []), environmentId])];
        return {
          ...settings,
          ...(speechCustomWords !== undefined && importId(speechCustomWords) !== id
            ? { speechCustomWords }
            : {}),
          legacySpeechWordsArchive: [
            ...legacySpeechWordsArchive.filter((batch) => batch.id !== id),
            { id, words, acknowledged },
          ],
        };
      });
      delays.delete(environmentId);
    } catch {
      if (active) {
        const delay = delays.get(environmentId) ?? 1_000;
        timers.set(
          environmentId,
          setTimeout(() => {
            timers.delete(environmentId);
            wake();
          }, delay),
        );
        delays.set(environmentId, Math.min(delay * 2, 60_000));
      }
    } finally {
      running.delete(environmentId);
      wake();
    }
  }

  const unsubscribe = input.subscribe(wake);
  wake();
  return () => {
    active = false;
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
