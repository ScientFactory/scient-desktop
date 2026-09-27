import { EnvironmentId, ThreadId, ThreadSectionId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, unknown>();
vi.mock("../../hooks/useLocalStorage", () => ({
  getLocalStorageItem: (key: string) => storage.get(key) ?? null,
  setLocalStorageItem: (key: string, value: unknown) => storage.set(key, value),
}));

const { applyPendingNewThreadSections, forgetSectionForNewThread, rememberSectionForNewThread } =
  await import("./pendingNewThreadSections");

const environmentId = EnvironmentId.make("env");
const research = ThreadSectionId.make("research");
const thread = (id: string, sectionId: string | null = null) => ({
  id: ThreadId.make(id),
  environmentId,
  sectionId,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pending new-thread sections", () => {
  beforeEach(() => {
    // Clear any entries a previous test left.
    for (const id of ["t1", "t2"]) forgetSectionForNewThread(id);
  });

  it("files a new thread once, and forgets it only after the write succeeds", async () => {
    rememberSectionForNewThread("t1", research);
    const apply = vi.fn(async () => false);
    applyPendingNewThreadSections([thread("t1")], apply);
    // A second update while the first write is in flight doesn't file twice.
    applyPendingNewThreadSections([thread("t1")], apply);
    await settle();
    expect(apply).toHaveBeenCalledTimes(1);

    // The failed write is retried on the next update.
    apply.mockResolvedValue(true);
    applyPendingNewThreadSections([thread("t1")], apply);
    await settle();
    expect(apply).toHaveBeenCalledTimes(2);
    applyPendingNewThreadSections([thread("t1")], apply);
    await settle();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("forgets a draft reused by another New thread path", async () => {
    rememberSectionForNewThread("t2", research);
    forgetSectionForNewThread("t2");
    const apply = vi.fn(async () => true);
    applyPendingNewThreadSections([thread("t2")], apply);
    await settle();
    expect(apply).not.toHaveBeenCalled();
  });

  it("drops an entry once the thread is already filed", async () => {
    rememberSectionForNewThread("t1", research);
    const apply = vi.fn(async () => true);
    applyPendingNewThreadSections([thread("t1", "elsewhere")], apply);
    applyPendingNewThreadSections([thread("t1")], apply);
    await settle();
    expect(apply).not.toHaveBeenCalled();
  });
});
