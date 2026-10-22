import type {
  MarkdownDraftCheckpoint,
  MarkdownDraftCheckpointStore,
} from "./markdownDraftCheckpoint";

export interface TestCheckpointStore extends MarkdownDraftCheckpointStore {
  readonly values: Map<string, MarkdownDraftCheckpoint>;
}

export function createTestCheckpointStore(
  initial?: Iterable<readonly [string, MarkdownDraftCheckpoint]>,
): TestCheckpointStore {
  const values = new Map<string, MarkdownDraftCheckpoint>(initial);
  return {
    values,
    async read(key: string): Promise<MarkdownDraftCheckpoint | undefined> {
      return values.get(key);
    },
    async replace(
      key: string,
      expectedToken: string | undefined,
      next: MarkdownDraftCheckpoint | undefined,
    ): Promise<boolean> {
      const existing = values.get(key);
      if (existing?.token !== expectedToken) {
        return false;
      }
      if (next === undefined) {
        values.delete(key);
      } else {
        values.set(key, next);
      }
      return true;
    },
  };
}
