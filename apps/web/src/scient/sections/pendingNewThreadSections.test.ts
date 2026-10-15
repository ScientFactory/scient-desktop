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
const researchId = ThreadSectionId.make("research");
const research = { environmentId, sectionId: researchId };
const thread = (
  id: string,
  sectionId: string | null = null,
  onEnvironment: EnvironmentId = environmentId,
) => ({
  id: ThreadId.make(id),
  environmentId: onEnvironment,
  sectionId,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pending new-thread sections", () => {
  beforeEach(() => {
    // Clear any entries a previous test left.
    for (const id of ["t1", "t2"]) forgetSectionForNewThread(id);
  });

  it("files the new thread into the remembered section of its environment", async () => {
    rememberSectionForNewThread("t1", research);
    const apply = vi.fn(async () => true);
    applyPendingNewThreadSections([thread("t1")], apply);
    await settle();
    expect(apply).toHaveBeenCalledWith({ environmentId, threadId: "t1" }, research);
  });

  it("drops the entry when the draft was sent on another environment", async () => {
    rememberSectionForNewThread("t1", research);
    const apply = vi.fn(async () => true);
    applyPendingNewThreadSections([thread("t1", null, EnvironmentId.make("other"))], apply);
    await settle();
    expect(apply).not.toHaveBeenCalled();
    // Gone for good, even if a thread of that id later shows on the section's environment.
    applyPendingNewThreadSections([thread("t1")], apply);
    await settle();
    expect(apply).not.toHaveBeenCalled();
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

  it("retains intent through its optimistic membership and a rejected write", async () => {
    rememberSectionForNewThread("t1", research);
    let resolve!: (value: boolean) => void;
    const pending = new Promise<boolean>((done) => {
      resolve = done;
    });
    const apply = vi.fn(() => pending);
    applyPendingNewThreadSections([thread("t1")], apply);
    applyPendingNewThreadSections([thread("t1", researchId)], apply);
    expect(apply).toHaveBeenCalledTimes(1);

    resolve(false);
    await settle();
    apply.mockResolvedValue(true);
    applyPendingNewThreadSections([thread("t1")], apply);
    await settle();
    expect(apply).toHaveBeenCalledTimes(2);
    applyPendingNewThreadSections([thread("t1")], apply);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("retains intent and releases the in-flight guard when the transport throws", async () => {
    rememberSectionForNewThread("t1", research);
    const apply = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue(true);
    applyPendingNewThreadSections([thread("t1")], apply);
    await settle();
    applyPendingNewThreadSections([thread("t1")], apply);
    await settle();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("drops an entry once the thread is already filed", async () => {
    rememberSectionForNewThread("t1", research);
    const apply = vi.fn(async () => true);
    applyPendingNewThreadSections([thread("t1", "elsewhere")], apply);
    applyPendingNewThreadSections([thread("t1")], apply);
    await settle();
    expect(apply).not.toHaveBeenCalled();
  });

  it("files an entry saved before sections named their environment on the thread's own", async () => {
    vi.resetModules();
    storage.set("scient:sidebar:pending-new-thread-sections", {
      t9: { sectionId: "research", rememberedAt: Date.now() },
    });
    const legacy = await import("./pendingNewThreadSections");
    const apply = vi.fn(async () => true);
    const remote = EnvironmentId.make("remote");
    legacy.applyPendingNewThreadSections([thread("t9", null, remote)], apply);
    await settle();
    expect(apply).toHaveBeenCalledWith(
      { environmentId: remote, threadId: "t9" },
      { environmentId: remote, sectionId: "research" },
    );
  });
});
