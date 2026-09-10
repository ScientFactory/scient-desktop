import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createForkAttemptStore,
  deliverForkAttempt,
  forkAttemptKey,
  withForkOriginLock,
  type ForkAttempt,
} from "./forkAttempt";

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const attempt: ForkAttempt = {
    environmentId: EnvironmentId.make("env"),
    ready: false,
    handoffDone: false,
    displayTitle: "Renamed fork",
    command: {
      type: "thread.fork",
      commandId: CommandId.make("fork-request"),
      originThreadId: ThreadId.make("origin"),
      newThreadId: ThreadId.make("destination"),
      sourceAssistantMessageId: MessageId.make("answer"),
      workspaceMode: "new-worktree",
      titleOverride: "Renamed fork",
    },
  };
  return {
    storage,
    attempt,
    store: createForkAttemptStore(storage),
    key: forkAttemptKey("env", "origin", "answer"),
  };
}

describe("durable fork attempts", () => {
  it("reuses the exact command and preserves the draft across a lost acknowledgement and reload", async () => {
    const { attempt, store, key, storage } = fixture();
    const discardDraft = vi.fn();
    await expect(
      deliverForkAttempt({
        attempt,
        store,
        key,
        discardDraft,
        dispatch: async () => {
          throw new Error("Socket closed");
        },
      }),
    ).rejects.toThrow("Socket closed");
    expect(discardDraft).not.toHaveBeenCalled();
    const reloaded = createForkAttemptStore(storage);
    const recovered = reloaded.get(key)!;
    expect(recovered.command).toEqual(attempt.command);
    const commands: ForkAttempt[] = [];
    const ready = await deliverForkAttempt({
      attempt: recovered,
      store: reloaded,
      key,
      discardDraft,
      dispatch: async (value) => {
        commands.push(value);
      },
    });
    expect(commands[0]?.command.newThreadId).toBe(attempt.command.newThreadId);
    expect(ready.ready).toBe(true);
    expect(reloaded.get(key)?.displayTitle).toBe("Renamed fork");
  });

  it.each(["rejected", "abandoned"])(
    "cleans only the staged destination after confirmed %s",
    async (forkDisposition) => {
      const { attempt, store, key } = fixture();
      const discardDraft = vi.fn();
      await expect(
        deliverForkAttempt({
          attempt,
          store,
          key,
          discardDraft,
          dispatch: async () => {
            throw { forkDisposition };
          },
        }),
      ).rejects.toMatchObject({ forkDisposition });
      expect(store.get(key)).toBeNull();
      expect(discardDraft).toHaveBeenCalledOnce();
    },
  );

  it.each(["failed", "provisioning", "pending", "unknown"])(
    "retains identity and draft after %s",
    async (forkDisposition) => {
      const { attempt, store, key } = fixture();
      const discardDraft = vi.fn();
      await expect(
        deliverForkAttempt({
          attempt,
          store,
          key,
          discardDraft,
          dispatch: async () => {
            throw { forkDisposition };
          },
        }),
      ).rejects.toMatchObject({ forkDisposition });
      expect(store.get(key)).toEqual(attempt);
      expect(discardDraft).not.toHaveBeenCalled();
    },
  );

  it("opens a ready fork without resending after navigation failed", async () => {
    const { attempt, store, key } = fixture();
    const ready = { ...attempt, ready: true };
    const dispatch = vi.fn();
    expect(
      await deliverForkAttempt({ attempt: ready, store, key, discardDraft: vi.fn(), dispatch }),
    ).toBe(ready);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("accepts durable ready evidence even when the RPC reports an error", async () => {
    const { attempt, store, key } = fixture();
    const result = await deliverForkAttempt({
      attempt,
      store,
      key,
      discardDraft: vi.fn(),
      dispatch: async () => {
        throw { forkDisposition: "ready" };
      },
    });
    expect(result.ready).toBe(true);
  });

  it("serializes a double click across remounts without blocking another environment", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withForkOriginLock("env:origin", async () => {
      await pending;
      return "first";
    });
    expect(await withForkOriginLock("env:origin", async () => "duplicate")).toBeNull();
    expect(await withForkOriginLock("other-env:origin", async () => "other")).toBe("other");
    release();
    expect(await first).toBe("first");
    expect(await withForkOriginLock("env:origin", async () => "next")).toBe("next");
  });

  it("does not dispatch if the attempt cannot be durably saved", async () => {
    const { attempt, key } = fixture();
    const store = createForkAttemptStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("Storage full");
      },
      removeItem: () => {},
    });
    const dispatch = vi.fn();
    await expect(
      deliverForkAttempt({ attempt, key, store, dispatch, discardDraft: vi.fn() }),
    ).rejects.toThrow("Storage full");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
