import { RegistryContext } from "@effect/atom-react";
import type {
  PullRequestFilterOptions,
  PullRequestFilterOptionsInput,
  PullRequestListFilters,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_PR_LIST_CONTROLS } from "./pullRequestList";
import type { PullRequestListControls } from "./pullRequestList";

type SearchResult = AsyncResult.AsyncResult<PullRequestFilterOptions, Error>;
type SearchItem = { readonly onSearchTextChange?: (text: string) => void };
const harness = vi.hoisted(() => ({
  replies: new Map<string, SearchResult>(),
  requests: [] as Array<{
    readonly environmentId: string;
    readonly input: PullRequestFilterOptionsInput;
  }>,
  initialControls: null as PullRequestListControls | null,
  controls: null as PullRequestListControls | null,
  searchItem: null as SearchItem | null,
}));

vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  FlatList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
  }: {
    readonly data: readonly string[];
    readonly renderItem: (item: { item: string; index: number }) => ReactNode;
    readonly ListHeaderComponent?: ReactNode;
    readonly ListEmptyComponent?: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.length
        ? data.map((item, index) => <div key={item}>{renderItem({ item, index })}</div>)
        : ListEmptyComponent}
    </div>
  ),
}));
vi.mock("../../components/ui/SelectionRow", () => ({
  SelectionRow: ({
    title,
    selected,
    disabled,
    onPress,
  }: {
    readonly title: string;
    readonly selected: boolean;
    readonly disabled?: boolean;
    readonly onPress: () => void;
  }) => (
    <button aria-label={title} aria-pressed={selected} disabled={disabled} onClick={onPress}>
      {title}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    readonly children?: ReactNode;
    readonly accessibilityRole?: "alert";
  }) => <p role={accessibilityRole}>{children}</p>,
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <span>Loading</span>,
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({ title, detail }: { readonly title: string; readonly detail: string }) => (
    <p role="alert">
      {title}: {detail}
    </p>
  ),
}));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/SearchField", () => ({ SearchField: () => null }));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../components/ui/Toolbar", () => ({ Toolbar: () => null }));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: true }));
vi.mock("../../native/use-native-mail-search-toolbar", () => ({
  useNativeMailSearchToolbar: () => true,
}));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: ({
    options,
  }: {
    readonly options: { readonly unstable_headerToolbarItems?: () => readonly SearchItem[] };
  }) => {
    harness.searchItem = options.unstable_headerToolbarItems?.()[0] ?? null;
    return null;
  },
}));
// Debounce timing is independent of result completeness and input admission.
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("../../state/pull-requests", () => {
  return {
    composerPullRequests: {
      filterOptions: (target: {
        readonly environmentId: string;
        readonly input: PullRequestFilterOptionsInput;
      }) => {
        harness.requests.push(target);
        const result = harness.replies.get(target.environmentId);
        if (!result) throw new Error(`Missing search fixture for ${target.environmentId}`);
        return Atom.make(result);
      },
    },
  };
});
vi.mock("./usePullRequestListControls", () => {
  return {
    usePullRequestListControls: () => {
      if (!harness.initialControls) throw new Error("Missing controls fixture");
      const [controls, setControls] = useState(harness.initialControls);
      harness.controls = controls;
      return {
        controlsFor: () => controls,
        setControls: (_environmentId: string | null, next: PullRequestListControls) =>
          setControls(next),
      };
    },
  };
});

import { PullRequestFilterSearchScreen } from "./PullRequestFilterSearchScreen";

function setup(
  replies: ReadonlyArray<readonly [string, SearchResult]>,
  labels?: PullRequestListFilters["labels"],
) {
  harness.replies = new Map(replies);
  harness.requests = [];
  harness.initialControls = {
    ...DEFAULT_PR_LIST_CONTROLS,
    filters: labels ? { labels } : {},
  };
  harness.controls = null;
  harness.searchItem = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <PullRequestFilterSearchScreen
          route={{
            params: {
              kind: "labels",
              environmentId: null,
              environmentIds: replies.map(([environmentId]) => environmentId),
              suggestions: Array.from({ length: 11 }, (_, index) => `label-${index}`),
            },
          }}
        />
      </RegistryContext.Provider>,
    ),
  );
  return {
    container,
    row: (label: string) => {
      const row = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      if (!row) throw new Error(`Missing picker row ${label}`);
      return row;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

const healthy = (overrides: Partial<PullRequestFilterOptions> = {}) =>
  AsyncResult.success<PullRequestFilterOptions, Error>({
    labels: [{ name: "release", color: null }],
    authors: [],
    truncated: false,
    ...overrides,
  });

describe("hosted pull-request picker admission", () => {
  it.each([
    [
      "failed environment",
      [
        ["healthy", healthy()],
        [
          "failed",
          AsyncResult.failure<PullRequestFilterOptions, Error>(
            Cause.fail(new Error("Host unavailable")),
          ),
        ],
      ],
    ],
    ["capped search", [["healthy", healthy({ truncated: true })]]],
    [
      "failed repository",
      [["healthy", healthy({ partialFailure: "A repository could not be searched" })]],
    ],
  ] as const)("keeps healthy choices actionable while exposing a %s", (_reason, replies) => {
    using screen = setup(replies);
    expect(screen.row("release").disabled).toBe(false);
    expect(screen.container.querySelector('[role="alert"]')).not.toBeNull();
    act(() => screen.row("release").click());
    expect(harness.controls?.filters.labels).toEqual([["release"]]);
  });

  it("rejects an oversized native search instead of silently querying its prefix", () => {
    using screen = setup([["healthy", healthy()]]);
    harness.requests = [];
    const oversized = "x".repeat(101);
    act(() => harness.searchItem!.onSearchTextChange!(oversized));
    expect(harness.requests).toEqual([]);
    expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain("100");
  });

  it("disables an eleventh label but reopens admission after a deselection", () => {
    const labels = Array.from({ length: 10 }, (_, index) => `label-${index}`);
    using screen = setup(
      [["healthy", healthy()]],
      labels.map((label) => [label]),
    );
    expect(screen.row("label-10").disabled).toBe(true);
    expect(screen.row("label-0").disabled).toBe(false);
    act(() => screen.row("label-0").click());
    expect(screen.row("label-10").disabled).toBe(false);
    act(() => screen.row("label-10").click());
    expect(harness.controls?.filters.labels?.flat()).toEqual([...labels.slice(1), "label-10"]);
  });

  it("counts label groups and keeps an OR group's alternatives through each edit", () => {
    const singletons = Array.from({ length: 8 }, (_, index) => [`label-${index}`]);
    // One OR pair and eight single labels: nine groups holding ten names.
    using screen = setup([["healthy", healthy()]], [["size:S", "size:XS"], ...singletons]);
    expect(screen.row("label-8").disabled).toBe(false);
    act(() => screen.row("label-8").click());
    expect(harness.controls?.filters.labels).toEqual([
      ["size:S", "size:XS"],
      ...singletons,
      ["label-8"],
    ]);
    expect(screen.row("label-9").disabled).toBe(true);
    act(() => screen.row("size:XS").click());
    expect(harness.controls?.filters.labels).toEqual([["size:S"], ...singletons, ["label-8"]]);
    expect(screen.row("label-9").disabled).toBe(true);
    act(() => screen.row("size:S").click());
    expect(screen.row("label-9").disabled).toBe(false);
    act(() => screen.row("label-9").click());
    expect(harness.controls?.filters.labels).toEqual([...singletons, ["label-8"], ["label-9"]]);
  });
});
