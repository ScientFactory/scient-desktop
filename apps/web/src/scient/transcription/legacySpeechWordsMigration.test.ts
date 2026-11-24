import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, type ClientSettings } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createClientSettingsWindowSync } from "../multiWindow/clientSettingsSync";
import { startLegacySpeechWordsMigration } from "./legacySpeechWordsMigration";

const words = [
  { term: "שלום", aliases: ["שלם"] },
  { term: "C#", aliases: ["C sharp"] },
];

const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings>>(),
}));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  persistence.getClientSettings.mockReset();
});
const home = EnvironmentId.make("home");
const linked = EnvironmentId.make("linked");
const other = EnvironmentId.make("other");

function fixture() {
  let saved = { ...DEFAULT_CLIENT_SETTINGS, speechCustomWords: words } as ClientSettings;
  const read = () => saved;
  const persist = vi.fn(async (update: (current: ClientSettings) => ClientSettings) => {
    saved = JSON.parse(JSON.stringify(update(saved)));
  });
  const send = vi.fn(async (_target: EnvironmentId, batch: { id: string }) => [batch.id]);
  let targets = [home];
  let wake = () => {};
  const connect = (...ids: EnvironmentId[]) => {
    targets = ids;
    wake();
  };
  const start = () =>
    startLegacySpeechWordsMigration({
      read,
      persist,
      send,
      targets: () => targets,
      subscribe: (callback) => {
        wake = callback;
        return () => {};
      },
    });
  return { read, send, persist, start, connect };
}

it("sends the saved spellings once and removes the storage key after acknowledgment", async () => {
  vi.useFakeTimers();
  const { start, read, send, persist } = fixture();
  const stop = start();
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledExactlyOnceWith(home, {
    id: expect.stringMatching(/^[a-f0-9]{64}$/),
    words,
  });
  expect(persist).toHaveBeenCalledOnce();
  expect(read()).not.toHaveProperty("speechCustomWords");
  expect(read().legacySpeechWordsArchive).toEqual([
    { id: expect.any(String), words, acknowledged: [home] },
  ]);
  stop();

  const restarted = start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).toHaveBeenCalledOnce();
  restarted();
});

it("backs off after failures and retries the same import after restart", async () => {
  vi.useFakeTimers();
  const { start, read, send, persist } = fixture();
  send.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
  const stop = start();
  await vi.advanceTimersByTimeAsync(999);
  expect(send).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(2);
  expect(read().speechCustomWords).toEqual(words);
  expect(persist).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_999);
  expect(send).toHaveBeenCalledTimes(2);
  stop();

  const restarted = start();
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2]).toEqual(send.mock.calls[0]);
  expect(read()).not.toHaveProperty("speechCustomWords");
  restarted();
});

it("keeps an archive across restart and imports it into each new environment independently", async () => {
  vi.useFakeTimers();
  const { start, connect, read, send } = fixture();
  const stop = start();
  await vi.advanceTimersByTimeAsync(0);
  stop();
  connect(home);
  const restarted = start();
  send.mockRejectedValueOnce(new Error("offline"));
  connect(home, linked, other);
  await vi.advanceTimersByTimeAsync(0);
  expect(read().legacySpeechWordsArchive?.[0]).toMatchObject({
    words,
    acknowledged: [home, other],
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read().legacySpeechWordsArchive?.[0]).toMatchObject({
    words,
    acknowledged: [home, other, linked],
  });
  expect(send.mock.calls.map(([id]) => id)).toEqual([home, linked, other, linked]);
  expect(new Set(send.mock.calls.map(([, batch]) => batch.id)).size).toBe(1);
  restarted();
});

it("keeps the active key when the local archive write fails after a server receipt", async () => {
  vi.useFakeTimers();
  const { start, read, send, persist } = fixture();
  persist.mockRejectedValueOnce(new Error("could not save settings"));
  const stop = start();
  await vi.advanceTimersByTimeAsync(0);
  expect(read().speechCustomWords).toEqual(words);
  expect(read().legacySpeechWordsArchive).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(read().legacySpeechWordsArchive?.[0]?.words).toEqual(words);
  expect(read()).not.toHaveProperty("speechCustomWords");
  stop();
});

it("preserves both simultaneous renderer acknowledgments before either receives a settings broadcast", async () => {
  const initial: ClientSettings = { ...DEFAULT_CLIENT_SETTINGS, speechCustomWords: words };
  let saved = initial;
  persistence.getClientSettings.mockImplementation(async () => saved);
  vi.stubGlobal("window", { desktopBridge: { onClientSettingsChanged: () => () => {} } });
  let lock = Promise.resolve();
  const bothQueued = Promise.withResolvers<void>();
  const firstWriteStarted = Promise.withResolvers<void>();
  const finishFirstWrite = Promise.withResolvers<void>();
  const bothSaved = Promise.withResolvers<void>();
  let requests = 0;
  let writes = 0;
  vi.stubGlobal("navigator", {
    locks: {
      request<A>(_name: string, work: () => Promise<A>) {
        if (++requests === 2) bothQueued.resolve();
        const result = lock.then(work);
        lock = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
  });
  const receipts = Promise.withResolvers<void>();
  const mount = (environmentId: EnvironmentId) => {
    let current = initial;
    const replace = (settings: ClientSettings) => {
      current = settings;
    };
    const sync = createClientSettingsWindowSync({
      isHydrated: () => true,
      current: () => current,
      replace,
      hydrateWith: replace,
    });
    const stop = startLegacySpeechWordsMigration({
      read: () => current,
      targets: () => [environmentId],
      subscribe: () => () => {},
      send: async (_id, { id }) => {
        await receipts.promise;
        return [id];
      },
      persist: (update) =>
        sync.queuedWrite(async () => {
          const next = update(current);
          if (++writes === 1) {
            firstWriteStarted.resolve();
            await finishFirstWrite.promise;
          }
          saved = JSON.parse(JSON.stringify(next));
          replace(next);
          if (writes === 2) bothSaved.resolve();
        })(),
    });
    return () => {
      stop();
      sync.reset();
    };
  };
  const stopHome = mount(home);
  const stopLinked = mount(linked);
  try {
    receipts.resolve();
    await Promise.all([firstWriteStarted.promise, bothQueued.promise]);
    expect(saved.speechCustomWords).toEqual(words);
    expect(writes).toBe(1);
    finishFirstWrite.resolve();
    await bothSaved.promise;
    expect(saved).not.toHaveProperty("speechCustomWords");
    expect(saved.legacySpeechWordsArchive).toEqual([
      { id: expect.any(String), words, acknowledged: [home, linked] },
    ]);
  } finally {
    finishFirstWrite.resolve();
    stopLinked();
    stopHome();
  }
});
