import { act, render } from "../../../test/render";
import "../../index.css";

import type { EnvironmentId, ScientSourcesOrganizeRequest } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { LIBRARY_LABELS } from "./libraryLabels";
import { SnapshotRemovalDialog, useLibraryProjectActions } from "./useLibraryProjectActions";

type Actions = {
  readonly removeFromProject: (
    records: ReadonlyArray<{ readonly citationKey: string; readonly fromSnapshot: boolean }>,
  ) => Promise<boolean>;
  readonly confirmSnapshotRemoval: () => void;
  readonly cancelSnapshotRemoval: () => void;
};
type Context = { readonly environmentId: EnvironmentId; readonly root: string };

const mocks = vi.hoisted(() => ({ organizeScientSources: vi.fn(), toast: vi.fn() }));
vi.mock("./client", () => ({
  organizeScientSources: mocks.organizeScientSources,
  setScientSourcesReadingState: vi.fn(),
}));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

const contextA: Context = {
  environmentId: "environment-a" as EnvironmentId,
  root: "/project-a",
};
const contextB: Context = {
  environmentId: "environment-b" as EnvironmentId,
  root: "/project-b",
};
const snapshot = { citationKey: "shared2026", fromSnapshot: true };
const contextKey = (context: Context) => `${context.environmentId}\0${context.root}`;

function setup(
  options: {
    readonly beforeRemoval?: () => Promise<void>;
    readonly failure?: "refused" | "rejected";
  } = {},
) {
  mocks.organizeScientSources.mockReset();
  mocks.toast.mockReset();
  const projects = new Map<string, Set<string>>();
  const pins = (context: Context) => {
    const key = contextKey(context);
    const existing = projects.get(key);
    if (existing) return existing;
    const created = new Set([snapshot.citationKey, "first2026", "second2026"]);
    projects.set(key, created);
    return created;
  };
  mocks.organizeScientSources.mockImplementation(
    async (environmentId: EnvironmentId, input: ScientSourcesOrganizeRequest) => {
      if (input.change.action !== "change-pins") throw new Error("Expected a pin change.");
      await options.beforeRemoval?.();
      if (options.failure === "rejected") throw new Error("The Library is unavailable.");
      const project = pins({ environmentId, root: input.root });
      return {
        outcome: "updated",
        pinChanges: input.change.changes.map((change) => {
          if (change.action !== "unpin") throw new Error("Expected a removal.");
          if (options.failure === "refused") return { outcome: "refused" };
          return project.delete(change.citationKey)
            ? { outcome: "unpinned" }
            : { outcome: "not-pinned" };
        }),
      };
    },
  );
  return { pins };
}

function createProbe() {
  let actions: Actions | null = null;
  return {
    capture: (next: Actions) => {
      actions = next;
    },
    read: () => {
      if (!actions) throw new Error("The hook is not mounted.");
      return actions;
    },
  };
}

function Harness({
  context,
  capture,
}: {
  readonly context: Context;
  readonly capture: (actions: Actions) => void;
}) {
  const actions = useLibraryProjectActions({
    ...context,
    refreshOverview: async () => undefined,
    applyReadingState: () => undefined,
  });
  useLayoutEffect(() => capture(actions), [capture, actions]);
  return <SnapshotRemovalDialog actions={actions} />;
}

describe("snapshot removal interaction lifetime", () => {
  it.each([
    { name: "project", next: { ...contextA, root: contextB.root } },
    { name: "environment", next: { ...contextA, environmentId: contextB.environmentId } },
  ])("cancels removal when the $name changes with the same key", async ({ next }) => {
    const backend = setup();
    const originalPins = backend.pins(contextA);
    const nextPins = backend.pins(next);
    const probe = createProbe();
    await using screen = await render(<Harness context={contextA} capture={probe.capture} />);
    let original!: Promise<boolean>;
    await act(() => {
      original = probe.read().removeFromProject([snapshot]);
    });
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    const stale = probe.read();

    await screen.rerender(<Harness context={next} capture={probe.capture} />);
    await act(() => {
      probe.read().confirmSnapshotRemoval();
      stale.confirmSnapshotRemoval();
    });
    expect(originalPins.has(snapshot.citationKey)).toBe(true);
    expect(nextPins.has(snapshot.citationKey)).toBe(true);
    await expect(original).resolves.toBe(false);

    let current!: Promise<boolean>;
    await act(() => {
      current = probe.read().removeFromProject([snapshot]);
    });
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await act(() => {
      stale.confirmSnapshotRemoval();
      stale.cancelSnapshotRemoval();
    });
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(nextPins.has(snapshot.citationKey)).toBe(true);
    await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
    await expect(current).resolves.toBe(false);
    expect(nextPins.has(snapshot.citationKey)).toBe(true);
  });

  it("waits for same-context removal and ignores duplicate confirmation", async () => {
    const completion = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const backend = setup({
      beforeRemoval: () => {
        started.resolve();
        return completion.promise;
      },
    });
    const originalPins = backend.pins(contextA);
    const otherPins = backend.pins(contextB);
    const probe = createProbe();
    await using _screen = await render(<Harness context={contextA} capture={probe.capture} />);
    let removal!: Promise<boolean>;
    let result: boolean | undefined;
    await act(() => {
      removal = probe.read().removeFromProject([snapshot]);
      void removal.then((removed) => {
        result = removed;
      });
    });
    const confirmation = probe.read().confirmSnapshotRemoval;
    await userEvent.click(
      page.getByRole("button", { name: LIBRARY_LABELS.removeFromProject, exact: true }),
    );
    await started.promise;
    await act(() => {
      confirmation();
    });
    expect(result).toBeUndefined();
    expect(originalPins.has(snapshot.citationKey)).toBe(true);
    expect(mocks.organizeScientSources).toHaveBeenCalledTimes(1);

    await act(async () => {
      completion.resolve();
      await expect(removal).resolves.toBe(true);
    });
    expect(originalPins.has(snapshot.citationKey)).toBe(false);
    expect(otherPins.has(snapshot.citationKey)).toBe(true);
  });

  it("settles a replaced request and ignores its late confirmation and cancellation", async () => {
    const backend = setup();
    const pins = backend.pins(contextA);
    const probe = createProbe();
    await using _screen = await render(<Harness context={contextA} capture={probe.capture} />);
    let first!: Promise<boolean>;
    await act(() => {
      first = probe.read().removeFromProject([{ ...snapshot, citationKey: "first2026" }]);
    });
    const stale = probe.read();
    let second!: Promise<boolean>;
    await act(() => {
      second = probe.read().removeFromProject([{ ...snapshot, citationKey: "second2026" }]);
    });
    await expect(first).resolves.toBe(false);
    await act(() => {
      stale.confirmSnapshotRemoval();
      stale.cancelSnapshotRemoval();
    });
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(pins.has("first2026")).toBe(true);
    expect(pins.has("second2026")).toBe(true);
    await userEvent.click(
      page.getByRole("button", { name: LIBRARY_LABELS.removeFromProject, exact: true }),
    );
    await expect(second).resolves.toBe(true);
    expect(pins.has("first2026")).toBe(true);
    expect(pins.has("second2026")).toBe(false);
  });

  it("settles on unmount and ignores a confirmation retained by the old dialog", async () => {
    const backend = setup();
    const pins = backend.pins(contextA);
    const probe = createProbe();
    await using screen = await render(<Harness context={contextA} capture={probe.capture} />);
    let removal!: Promise<boolean>;
    await act(() => {
      removal = probe.read().removeFromProject([snapshot]);
    });
    const confirm = probe.read().confirmSnapshotRemoval;
    await screen.unmount();
    await expect(removal).resolves.toBe(false);
    await act(() => confirm());
    expect(pins.has(snapshot.citationKey)).toBe(true);
  });

  it("settles an accepted removal on context departure without retargeting its in-flight request", async () => {
    const completion = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const backend = setup({
      beforeRemoval: () => {
        started.resolve();
        return completion.promise;
      },
    });
    const originalPins = backend.pins(contextA);
    const nextPins = backend.pins(contextB);
    const probe = createProbe();
    await using screen = await render(<Harness context={contextA} capture={probe.capture} />);
    let removal!: Promise<boolean>;
    await act(() => {
      removal = probe.read().removeFromProject([snapshot]);
    });
    await userEvent.click(
      page.getByRole("button", { name: LIBRARY_LABELS.removeFromProject, exact: true }),
    );
    await started.promise;
    await screen.rerender(<Harness context={contextB} capture={probe.capture} />);
    await expect(removal).resolves.toBe(false);
    completion.resolve();
    await vi.waitFor(() => expect(originalPins.has(snapshot.citationKey)).toBe(false));
    expect(nextPins.has(snapshot.citationKey)).toBe(true);
    await expect(removal).resolves.toBe(false);
  });

  it.each(["refused", "rejected"] as const)("keeps a %s removal unsuccessful", async (failure) => {
    const backend = setup({ failure });
    const pins = backend.pins(contextA);
    const probe = createProbe();
    await using _screen = await render(<Harness context={contextA} capture={probe.capture} />);
    let removal!: Promise<boolean>;
    await act(() => {
      removal = probe.read().removeFromProject([snapshot]);
    });
    await userEvent.click(
      page.getByRole("button", { name: LIBRARY_LABELS.removeFromProject, exact: true }),
    );
    await expect(removal).resolves.toBe(false);
    expect(pins.has(snapshot.citationKey)).toBe(true);
  });
});
