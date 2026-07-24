import { describe, expect, it, vi } from "vitest";

import {
  draftNavigationSlotKey,
  runDraftNavigationOnce,
  stageDraftNavigation,
} from "./stagedDraftNavigation";

describe("stagedDraftNavigation", () => {
  it("finalizes only after the destination is active", async () => {
    const calls: string[] = [];

    const committed = await stageDraftNavigation({
      isCurrent: () => true,
      stage: () => calls.push("stage"),
      navigate: async () => {
        calls.push("navigate");
      },
      isDestinationActive: () => {
        calls.push("check");
        return true;
      },
      finalize: () => calls.push("finalize"),
      rollback: () => calls.push("rollback"),
    });

    expect(committed).toBe(true);
    expect(calls).toEqual(["stage", "navigate", "check", "finalize"]);
  });

  it("rolls back a staged draft when a newer navigation wins", async () => {
    const finalize = vi.fn();
    const rollback = vi.fn();

    const committed = await stageDraftNavigation({
      isCurrent: () => true,
      stage: vi.fn(),
      navigate: async () => undefined,
      isDestinationActive: () => false,
      finalize,
      rollback,
    });

    expect(committed).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("rolls back and preserves navigation failures", async () => {
    const rollback = vi.fn();
    const error = new Error("navigation failed");

    await expect(
      stageDraftNavigation({
        isCurrent: () => true,
        stage: vi.fn(),
        navigate: async () => {
          throw error;
        },
        isDestinationActive: () => false,
        finalize: vi.fn(),
        rollback,
      }),
    ).rejects.toBe(error);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("does not stage work after its ownership was superseded", async () => {
    const stage = vi.fn();
    const rollback = vi.fn();

    await expect(
      stageDraftNavigation({
        isCurrent: () => false,
        stage,
        navigate: vi.fn(async () => undefined),
        isDestinationActive: () => true,
        finalize: vi.fn(),
        rollback,
      }),
    ).resolves.toBe(false);
    expect(stage).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back staged work when ownership changes during navigation", async () => {
    let current = true;
    const finalize = vi.fn();
    const rollback = vi.fn();

    await expect(
      stageDraftNavigation({
        isCurrent: () => current,
        stage: vi.fn(),
        navigate: async () => {
          current = false;
        },
        isDestinationActive: () => true,
        finalize,
        rollback,
      }),
    ).resolves.toBe(false);
    expect(finalize).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("suppresses a stale navigation failure after ownership changes", async () => {
    let current = true;
    const rollback = vi.fn();

    await expect(
      stageDraftNavigation({
        isCurrent: () => current,
        stage: vi.fn(),
        navigate: async () => {
          current = false;
          throw new Error("superseded navigation");
        },
        isDestinationActive: () => false,
        finalize: vi.fn(),
        rollback,
      }),
    ).resolves.toBe(false);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("coalesces identical requests without blocking a distinct later request", async () => {
    let finishFirst!: (value: string) => void;
    const firstRun = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const secondRun = vi.fn(async () => "second");
    const slotKey = draftNavigationSlotKey();

    const first = runDraftNavigationOnce(slotKey, "project-default", firstRun);
    const duplicateFirst = runDraftNavigationOnce(slotKey, "project-default", secondRun);
    const second = runDraftNavigationOnce(slotKey, "exact-worktree", secondRun);
    await Promise.resolve();
    expect(secondRun).toHaveBeenCalledOnce();
    await expect(second).resolves.toBe("second");
    finishFirst("first");

    await expect(first).resolves.toBe("first");
    await expect(duplicateFirst).resolves.toBe("first");
    expect(firstRun).toHaveBeenCalledOnce();
    expect(secondRun).toHaveBeenCalledOnce();

    await expect(runDraftNavigationOnce(slotKey, "exact-worktree", secondRun)).resolves.toBe(
      "second",
    );
    expect(secondRun).toHaveBeenCalledTimes(2);
  });

  it("lets a later project-default request progress during exact-workspace preparation", async () => {
    let finishExact!: (value: string) => void;
    const exactRun = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishExact = resolve;
        }),
    );
    const defaultRun = vi.fn(async () => "default");
    const slotKey = draftNavigationSlotKey();

    const exact = runDraftNavigationOnce(slotKey, "exact-worktree", exactRun);
    const projectDefault = runDraftNavigationOnce(slotKey, "project-default", defaultRun);
    await Promise.resolve();
    expect(defaultRun).toHaveBeenCalledOnce();
    await expect(projectDefault).resolves.toBe("default");
    finishExact("exact");

    await expect(exact).resolves.toBe("exact");
    expect(exactRun).toHaveBeenCalledOnce();
    expect(defaultRun).toHaveBeenCalledOnce();
  });

  it("keeps later navigation behind an explicit blocking preparation", async () => {
    let releasePreparation!: () => void;
    const firstOwnership: Array<{ readonly isCurrent: () => boolean }> = [];
    const laterRun = vi.fn(async (ownership: { readonly isCurrent: () => boolean }) =>
      ownership.isCurrent() ? "latest" : "superseded",
    );
    const slotKey = draftNavigationSlotKey();

    const preparation = runDraftNavigationOnce(
      slotKey,
      "mutating-pr-preparation",
      async (ownership) => {
        firstOwnership.push(ownership);
        await new Promise<void>((resolve) => {
          releasePreparation = resolve;
        });
        return ownership.isCurrent() ? "stale-commit" : "superseded";
      },
      { blocksFollowingOperations: true },
    );
    await Promise.resolve();
    expect(firstOwnership[0]?.isCurrent()).toBe(true);

    const later = runDraftNavigationOnce(slotKey, "project-default", laterRun);
    await Promise.resolve();
    expect(firstOwnership[0]?.isCurrent()).toBe(false);
    expect(laterRun).not.toHaveBeenCalled();

    releasePreparation();
    await expect(preparation).resolves.toBe("superseded");
    await expect(later).resolves.toBe("latest");
    expect(laterRun).toHaveBeenCalledOnce();
  });

  it("supersedes an awaited owner as soon as a distinct later intent arrives", async () => {
    let releaseFirst!: () => void;
    const firstOwnership: Array<{ readonly isCurrent: () => boolean }> = [];
    let secondWasCurrent = false;
    const slotKey = draftNavigationSlotKey();

    const first = runDraftNavigationOnce(slotKey, "exact-worktree", async (ownership) => {
      firstOwnership.push(ownership);
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return ownership.isCurrent() ? "stale-commit" : "superseded";
    });
    await Promise.resolve();
    expect(firstOwnership[0]?.isCurrent()).toBe(true);

    const second = runDraftNavigationOnce(slotKey, "project-default", async (ownership) => {
      secondWasCurrent = ownership.isCurrent();
      return ownership.isCurrent() ? "latest" : "superseded";
    });
    expect(firstOwnership[0]?.isCurrent()).toBe(false);
    releaseFirst();

    await expect(first).resolves.toBe("superseded");
    await expect(second).resolves.toBe("latest");
    expect(secondWasCurrent).toBe(true);
  });

  it("supersedes delayed work across projects and chat or terminal entry points", async () => {
    let releaseProjectChat!: () => void;
    let projectChatWasCurrentAfterRelease = true;
    const navigationSurface = draftNavigationSlotKey();

    const projectChat = runDraftNavigationOnce(
      navigationSurface,
      "project-a-chat-exact",
      async (ownership) => {
        await new Promise<void>((resolve) => {
          releaseProjectChat = resolve;
        });
        projectChatWasCurrentAfterRelease = ownership.isCurrent();
        return ownership.isCurrent() ? "stale-navigation" : "superseded";
      },
    );
    await Promise.resolve();

    const otherProjectTerminal = runDraftNavigationOnce(
      navigationSurface,
      "project-b-terminal-default",
      async (ownership) => (ownership.isCurrent() ? "latest-navigation" : "superseded"),
    );
    await expect(otherProjectTerminal).resolves.toBe("latest-navigation");
    releaseProjectChat();

    await expect(projectChat).resolves.toBe("superseded");
    expect(projectChatWasCurrentAfterRelease).toBe(false);
  });

  it("preserves default-exact-default ordering instead of rejoining the first request", async () => {
    let finishFirstDefault!: (value: string) => void;
    const calls: string[] = [];
    const firstDefaultRun = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          calls.push("default:first");
          finishFirstDefault = resolve;
        }),
    );
    const exactRun = vi.fn(async () => {
      calls.push("exact");
      return "exact";
    });
    const lastDefaultRun = vi.fn(async () => {
      calls.push("default:last");
      return "default:last";
    });
    const slotKey = draftNavigationSlotKey();

    const firstDefault = runDraftNavigationOnce(slotKey, "project-default", firstDefaultRun);
    const exact = runDraftNavigationOnce(slotKey, "exact-worktree", exactRun);
    const lastDefault = runDraftNavigationOnce(slotKey, "project-default", lastDefaultRun);
    await Promise.resolve();
    expect(calls).toEqual(["default:first", "exact", "default:last"]);
    finishFirstDefault("default:first");

    await expect(firstDefault).resolves.toBe("default:first");
    await expect(exact).resolves.toBe("exact");
    await expect(lastDefault).resolves.toBe("default:last");
    expect(calls).toEqual(["default:first", "exact", "default:last"]);
    expect(firstDefaultRun).toHaveBeenCalledOnce();
    expect(exactRun).toHaveBeenCalledOnce();
    expect(lastDefaultRun).toHaveBeenCalledOnce();
  });
});
