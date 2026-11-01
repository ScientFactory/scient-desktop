import { ProjectId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";

import { expect, it, vi } from "vite-plus/test";

import { SourceControlProviderKind } from "@t3tools/contracts";

import "../index.css";

import { act, render, stubGlobal } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { makeThreadFixture } from "../test-fixtures";

const state = vi.hoisted(() => ({ queries: [] as string[] }));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProject: () => null,
  useServerConfigs: () => new Map(),
}));
vi.mock(import("../state/vcs"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const statuses = Atom.family((cwd: string) =>
    Atom.make(() => {
      state.queries.push(`vcs:${cwd}`);
      return AsyncResult.success({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "feature/test",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: {
          number: 42,
          title: "Observed worktree PR",
          url: "https://github.com/example/repo/pull/42",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      } satisfies VcsStatusResult);
    }),
  );
  const actual = await original();
  return {
    ...actual,
    vcsEnvironment: {
      ...actual.vcsEnvironment,
      status: (({ input }: { input: { cwd: string } }) => statuses(input.cwd)) as never,
    },
  };
});
// Replace only the linked summary query; its answers still land through the app's own handler.
vi.mock(import("@t3tools/client-runtime/state/pull-requests"), async (importOriginal) => {
  const original = await importOriginal();
  const Effect = await import("effect/Effect");
  const { Atom } = await import("effect/reactivity");
  const { ProjectId } = await import("@t3tools/contracts");
  type Family = typeof original.createLinkedPullRequestSummaryAtomFamily;
  type Target = Parameters<ReturnType<Family>>[0];
  const createLinkedPullRequestSummaryAtomFamily = ((
    _runtime: Parameters<Family>[0],
    _refreshes: Parameters<Family>[1],
    onAnswer: Parameters<Family>[2],
  ) => {
    const summaries = Atom.family((key: string) => {
      const target = JSON.parse(key) as Target;
      return Atom.make((get) =>
        Effect.gen(function* () {
          const { number } = target.input;
          state.queries.push(`pr:${number}`);
          const summary = {
            provider: SourceControlProviderKind.make("github"),
            projectId: ProjectId.make("project-test"),
            repository: "example/repo",
            number,
            title: "Observed linked PR",
            url: `https://github.com/example/repo/pull/${number}`,
            state: "open" as const,
            headBranch: "feature/test",
            baseBranch: "main",
            updatedAt: "2026-09-04T00:00:00.000Z",
          };
          if (onAnswer) yield* onAnswer(target, summary, get.registry);
          return summary;
        }),
      );
    });
    return (target: Target) => summaries(JSON.stringify(target));
  }) as unknown as Family;
  return { ...original, createLinkedPullRequestSummaryAtomFamily };
});
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators";

// The lease overscans 160px around a 20px viewport, a 340px band. With 45px rows the band
// covers exactly 8 rows at each scroll position below.
const ROW_HEIGHT = 45;
const SPACER = 1000;

// regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)
it("leases only visible palette results while retaining observed PR badges", async () => {
  // SCIENT-FORK:START — verify pooling while real browser intersections drive visibility.
  const NativeIntersectionObserver = globalThis.IntersectionObserver;
  const observers: IntersectionObserver[] = [];
  const observedRows = new Set<Element>();
  using _observer = stubGlobal(
    "IntersectionObserver",
    class extends NativeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback, options);
        observers.push(this);
      }
      override observe(target: Element) {
        observedRows.add(target);
        super.observe(target);
      }
    },
  );
  // SCIENT-FORK:END
  const threads = Array.from({ length: 128 }, (_, index) =>
    makeThreadFixture({
      id: ThreadId.make(`palette-thread-${index}`),
      branch: "feature/test",
      worktreePath: `/test/worktree-${index}`,
      linkedPullRequest:
        index % 2 === 0
          ? null
          : {
              projectId: ProjectId.make("project-test"),
              repository: "example/repo",
              number: index,
              url: `https://github.com/example/repo/pull/${index}`,
            },
    }),
  );
  state.queries.length = 0;
  const viewport = () =>
    screen.container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  const scrollTo = async (top: number, queries: number, badges: number) => {
    await act(() => {
      viewport().scrollTop = top;
    });
    await vi.waitFor(() => {
      expect(state.queries).toHaveLength(queries);
      expect(badgeCount()).toBe(badges);
    });
  };
  const badgeCount = () =>
    [...screen.container.querySelectorAll("[aria-label]")].filter((node) =>
      node.getAttribute("aria-label")!.startsWith("PR #"),
    ).length;
  await using screen = await render(
    <AppAtomRegistryProvider>
      <div data-slot="scroll-area-viewport" style={{ height: 20, overflowY: "auto" }}>
        <div style={{ height: SPACER }} />
        {threads.map((thread) => (
          <div key={thread.id} style={{ height: ROW_HEIGHT, overflow: "hidden" }}>
            <ThreadRowLeadingStatus thread={thread} />
            {thread.title}
          </div>
        ))}
      </div>
    </AppAtomRegistryProvider>,
  );
  await scrollTo(0, 0, 0);
  expect(state.queries).toEqual([]);
  expect(badgeCount()).toBe(0);
  expect(observers).toHaveLength(1);
  expect(observedRows.size).toBe(128);

  // Band [1000, 1340]: rows 0..7.
  await scrollTo(SPACER + 160, 8, 8);
  expect(state.queries).toHaveLength(8);
  expect(state.queries.filter((key) => key.startsWith("vcs:"))).toHaveLength(4);
  expect(state.queries.filter((key) => key.startsWith("pr:"))).toHaveLength(4);
  expect(badgeCount()).toBe(8);

  // Band [1370, 1710]: rows 8..15.
  await scrollTo(SPACER + 8 * ROW_HEIGHT + 10 + 160, 16, 16);
  expect(state.queries).toHaveLength(16);
  expect(badgeCount()).toBe(16);
});
