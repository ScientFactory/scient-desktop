// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { AnnotationRecord } from "@scientfactory/annotations";
import { createDocumentNoteSession, readDocumentNoteDraft } from "./annotationDraft";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});
const command = {
  action: "edit",
  annotationId: "a",
  highlighted: false,
  expectedRevision: 1,
  operationId: "initial-operation",
  note: "Original",
} as const;
function setup() {
  let revision = 1;
  const save = vi.fn(
    async (input: { note: string }) =>
      ({
        annotationId: "a",
        highlighted: false,
        revision: ++revision,
        note: input.note,
      }) as AnnotationRecord,
  );
  const onSaved = vi.fn();
  const onError = vi.fn();
  const session = createDocumentNoteSession({
    key: "draft",
    note: "Original",
    baseline: "Original",
    command,
    save,
    onSaved,
    onError,
    onBusy: vi.fn(),
  });
  return { session, save, onSaved, onError };
}
it("backs up immediately, debounces typing, and clears only after acknowledgement", async () => {
  const { session, save } = setup();
  session.change("First");
  expect(readDocumentNoteDraft("draft")?.note).toBe("First");
  await vi.advanceTimersByTimeAsync(500);
  session.change("Final");
  await vi.advanceTimersByTimeAsync(899);
  expect(save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...command, note: "Final" });
  expect(readDocumentNoteDraft("draft")).toBeNull();
});
it("flushes on leaving without waiting for the debounce", async () => {
  const { session, save } = setup();
  session.change("Leaving now");
  expect(await session.leave()).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
  await vi.runAllTimersAsync();
  expect(save).toHaveBeenCalledTimes(1);
});
it("serializes edits typed during an in-flight save with the acknowledged revision", async () => {
  const { session, save } = setup();
  let finish!: (value: AnnotationRecord) => void;
  save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  session.change("First");
  const saving = session.flush();
  session.change("Latest");
  expect(save).toHaveBeenCalledTimes(1);
  finish({ annotationId: "a", highlighted: false, revision: 2, note: "First" } as AnnotationRecord);
  await saving;
  expect(save.mock.calls[1]?.[0]).toMatchObject({
    annotationId: "a",
    highlighted: false,
    expectedRevision: 2,
    note: "Latest",
  });
  expect(save.mock.calls[1]?.[0]).not.toMatchObject({ operationId: command.operationId });
  expect(readDocumentNoteDraft("draft")).toBeNull();
});
it("retains an uncertain command and retries it before applying later typing", async () => {
  const { session, save, onError } = setup();
  save.mockRejectedValueOnce(new Error("offline"));
  session.change("First");
  expect(await session.flush()).toBe(false);
  expect(onError).toHaveBeenCalled();
  session.change("Latest");
  expect(readDocumentNoteDraft("draft")).toMatchObject({
    note: "Latest",
    attempt: true,
    command: { note: "First" },
  });
  await session.flush();
  expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
  expect(save.mock.calls[2]?.[0]).toMatchObject({ note: "Latest", expectedRevision: 2 });
});
it("explicit cancel discards only the unsaved draft and sends no request", async () => {
  const { session, save } = setup();
  session.change("Discard me");
  session.discard();
  await vi.runAllTimersAsync();
  await session.leave();
  expect(save).not.toHaveBeenCalled();
  expect(readDocumentNoteDraft("draft")).toBeNull();
});
it("does not turn an emptied note into an implicit highlight or delete it", async () => {
  const { session, save } = setup();
  session.change("");
  expect(await session.leave()).toBe(false);
  expect(save).not.toHaveBeenCalled();
  expect(readDocumentNoteDraft("draft")?.note).toBe("");
});
it("waits for a captured anchor and still saves after the editor unmounts", async () => {
  const save = vi.fn(
    async (input: { note: string }) =>
      ({
        annotationId: "a",
        highlighted: false,
        revision: 2,
        note: input.note,
      }) as AnnotationRecord,
  );
  const session = createDocumentNoteSession({
    key: "draft",
    note: "",
    save,
    onSaved: vi.fn(),
    onError: vi.fn(),
    onBusy: vi.fn(),
  });
  session.change("Remember this");
  expect(await session.leave()).toBe(false);
  session.prepare(command);
  await session.flush();
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...command, note: "Remember this" });
});
it("keeps the exact uncertain request across recovery", async () => {
  const { session, save } = setup();
  save.mockRejectedValueOnce(new Error("offline"));
  session.change("First");
  await session.flush();
  session.change("Newer");
  const draft = readDocumentNoteDraft("draft")!;
  expect(draft.command?.action).toBe("edit");
  const restored = createDocumentNoteSession({
    key: "draft",
    note: draft.note,
    command: draft.command as typeof command,
    attempt: draft.attempt ?? false,
    save,
    onSaved: vi.fn(),
    onError: vi.fn(),
    onBusy: vi.fn(),
  });
  await restored.flush();
  expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
  expect(save.mock.calls[2]?.[0]).toMatchObject({ note: "Newer" });
});
