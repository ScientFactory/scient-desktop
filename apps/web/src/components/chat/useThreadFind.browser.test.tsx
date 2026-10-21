import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  type OrchestrationV2SearchThreadInput,
  type OrchestrationV2SearchThreadResult,
} from "@t3tools/contracts";
import { act, fakeTimers, render } from "../../../test/render";
import { useThreadFind } from "./useThreadFind";
import { orchestrationEnvironment } from "~/state/orchestration";
import { requestThreadFindOpen } from "./threadFindActionBus";

const queries = vi.hoisted(() => ({
  results: new Map<string, OrchestrationV2SearchThreadResult>(),
  pending: false,
  refresh: vi.fn(),
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {
    threadFindProgressive: vi.fn(
      (input: { environmentId: EnvironmentId; input: OrchestrationV2SearchThreadInput }) => input,
    ),
    threadFind: vi.fn(
      (input: { environmentId: EnvironmentId; input: OrchestrationV2SearchThreadInput }) => input,
    ),
  },
}));
vi.mock("~/state/queries", () => ({ useDebouncedValue: <T,>(value: T) => value }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: { environmentId: EnvironmentId } | null) => ({
    data: atom === null ? null : (queries.results.get(atom.environmentId) ?? null),
    isPending: queries.pending,
    error: null,
    refresh: queries.refresh,
  }),
}));

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const a = EnvironmentId.make("environment:a");
const b = EnvironmentId.make("environment:b");
const threadId = ThreadId.make("shared-thread");
const runId = RunId.make("run:plan");
function Probe({
  _fixture,
  environmentId,
  enabled = true,
  progressive = false,
  content,
}: {
  environmentId: EnvironmentId;
  enabled?: boolean;
  progressive?: boolean;
  content?: Parameters<typeof useThreadFind>[0]["content"];
} & { _fixture: _Fixture }) {
  const state = useThreadFind({
    thread: { environmentId, threadId },
    enabled,
    progressive,
    content,
  });
  useLayoutEffect(() => {
    _fixture.publishFind(state);
  });
  return null;
}
function setup() {
  queries.results.clear();
  queries.pending = false;
  vi.clearAllMocks();
}

describe("V2 find state", () => {
  function messageResult(index: number, snapshotSequence = 9): OrchestrationV2SearchThreadResult {
    return {
      snapshotSequence,
      totalMatches: 10,
      activeIndex: index,
      match: { entryId: `message:${index + 2}`, runId, occurrence: 0 },
    };
  }

  it("reveals an early match and updates its count without requesting another jump", async () => {
    await using _fixture = _createFixture();

    setup();
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} progressive />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("needle"));
    const partial: OrchestrationV2SearchThreadResult = {
      complete: false,
      snapshotSequence: 9,
      totalMatches: 1,
      activeIndex: 0,
      match: { entryId: "early", runId, occurrence: 2 },
    };
    queries.pending = true;
    queries.results.set(a, partial);
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} progressive />);
    expect(_fixture.find.barProps.counting).toBe(true);
    expect(_fixture.find.barProps.status).toBeNull();
    expect(_fixture.find.timelineProps.activeFindMatch).toEqual(partial.match);
    const match = _fixture.find.timelineProps.activeFindMatch;
    const navigationId = _fixture.find.timelineProps.findNavigationId;
    const requests = vi.mocked(orchestrationEnvironment.threadFindProgressive).mock.calls.length;
    await act(async () => {
      _fixture.find.barProps.onNext();
      _fixture.find.barProps.onPrevious();
    });
    expect(orchestrationEnvironment.threadFindProgressive).toHaveBeenCalledTimes(requests);
    queries.results.set(a, { ...partial, complete: true, totalMatches: 123, activeIndex: 42 });
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} progressive />);
    expect(_fixture.find.barProps.counting).toBe(false);
    expect(_fixture.find.barProps.matchCount).toBe(123);
    expect(_fixture.find.barProps.activeIndex).toBe(42);
    expect(_fixture.find.timelineProps.activeFindMatch).toBe(match);
    expect(_fixture.find.timelineProps.findNavigationId).toBe(navigationId);
    expect(orchestrationEnvironment.threadFind).not.toHaveBeenCalled();
    queries.pending = false;
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} progressive />);
    await act(async () => _fixture.find.barProps.onNext());
    expect(orchestrationEnvironment.threadFindProgressive).toHaveBeenCalledTimes(requests + 1);
  });

  it("coalesces incoming pages until the progressive scan finishes", async () => {
    await using _fixture = _createFixture();

    setup();
    using _timers = fakeTimers();
    queries.pending = true;
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} progressive />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("needle"));
    queries.results.set(a, { ...messageResult(0), complete: false, totalMatches: 1 });
    const content = { visibleTurnItems: [], runs: [] };
    await screen.rerender(
      <Probe _fixture={_fixture} environmentId={a} progressive content={content} />,
    );
    const requests = vi.mocked(orchestrationEnvironment.threadFindProgressive).mock.calls.length;
    await act(async () => vi.advanceTimersByTime(300));
    expect(orchestrationEnvironment.threadFindProgressive).toHaveBeenCalledTimes(requests);
    expect(queries.refresh).not.toHaveBeenCalled();
    queries.results.set(a, messageResult(0));
    queries.pending = false;
    await screen.rerender(
      <Probe _fixture={_fixture} environmentId={a} progressive content={content} />,
    );
    expect(orchestrationEnvironment.threadFindProgressive).toHaveBeenCalledTimes(requests + 1);
    expect(orchestrationEnvironment.threadFindProgressive).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "needle",
        skills: [],
        start: { entryId: "message:2", occurrence: 0 },
      },
    });
    expect(_fixture.find.timelineProps.activeFindMatch?.entryId).toBe("message:2");
  });

  it("requests a fresh jump when the same search wraps to the same match from a new position", async () => {
    await using _fixture = _createFixture();

    setup();
    queries.results.set(a, messageResult(0));
    await using _screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    _fixture.find.timelineProps.findPositionReaderRef.current = () => ({
      entryId: "reading",
      occurrence: 0,
    });
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    const firstNavigationId = _fixture.find.timelineProps.findNavigationId;
    const firstMatch = _fixture.find.timelineProps.activeFindMatch;
    _fixture.find.timelineProps.findPositionReaderRef.current = () => ({
      entryId: "bottom",
      occurrence: 0,
    });
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    expect(_fixture.find.timelineProps.findNavigationId).toBeGreaterThan(firstNavigationId);
    expect(_fixture.find.timelineProps.activeFindMatch).toEqual(firstMatch);
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: { threadId, query: "COD4", skills: [], start: { entryId: "bottom", occurrence: 0 } },
    });
    const repeatedNavigationId = _fixture.find.timelineProps.findNavigationId;
    _fixture.find.timelineProps.findPositionReaderRef.current = () => ({
      entryId: "new-bottom",
      occurrence: 0,
    });
    await act(async () => requestThreadFindOpen());
    expect(_fixture.find.timelineProps.findNavigationId).toBeGreaterThan(repeatedNavigationId);
    expect(_fixture.find.timelineProps.activeFindMatch).toEqual(firstMatch);
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "new-bottom", occurrence: 0 },
      },
    });
  });

  it("cycles cached entries immediately, wraps, and accumulates clicks in one event", async () => {
    await using _fixture = _createFixture();

    setup();
    const initial = {
      ...messageResult(0),
      totalMatches: 5,
      match: { entryId: "first", runId, occurrence: 0 },
      navigation: [
        { entryId: "first", runId, startIndex: 0, count: 3 },
        { entryId: "second", runId, startIndex: 3, count: 2 },
      ],
    };
    queries.results.set(a, initial);
    await using _screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    const requests = vi.mocked(orchestrationEnvironment.threadFind).mock.calls.length;
    await act(async () => {
      _fixture.find.barProps.onNext();
      _fixture.find.barProps.onNext();
    });
    expect(_fixture.find.barProps.activeIndex).toBe(2);
    expect(_fixture.find.timelineProps.activeFindMatch).toEqual({
      entryId: "first",
      runId,
      occurrence: 2,
    });
    expect(_fixture.find.timelineProps.findNavigationId).toBe(3);
    await act(async () => _fixture.find.barProps.onNext());
    expect(_fixture.find.timelineProps.activeFindMatch).toEqual({
      entryId: "second",
      runId,
      occurrence: 0,
    });
    await act(async () => {
      _fixture.find.barProps.onNext();
      _fixture.find.barProps.onNext();
    });
    expect(_fixture.find.barProps.activeIndex).toBe(0);
    await act(async () => _fixture.find.barProps.onPrevious());
    expect(_fixture.find.barProps.activeIndex).toBe(4);
    expect(_fixture.find.timelineProps.activeFindMatch).toEqual({
      entryId: "second",
      runId,
      occurrence: 1,
    });
    expect(orchestrationEnvironment.threadFind).toHaveBeenCalledTimes(requests);
    expect(queries.refresh).not.toHaveBeenCalled();
  });

  it("does not let an older background response undo a cached step", async () => {
    await using _fixture = _createFixture();

    setup();
    const initial = {
      ...messageResult(0),
      match: { entryId: "first", runId, occurrence: 0 },
      navigation: [{ entryId: "first", runId, startIndex: 0, count: 3 }],
    };
    queries.results.set(a, initial);
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    const requests = vi.mocked(orchestrationEnvironment.threadFind).mock.calls.length;
    await act(async () => _fixture.find.barProps.onNext());
    queries.results.set(a, {
      ...initial,
      snapshotSequence: 10,
      totalMatches: 11,
      activeIndex: 1,
      navigation: [{ entryId: "first", runId, startIndex: 1, count: 3 }],
    });
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} />);
    expect(_fixture.find.timelineProps.activeFindMatch).toEqual({
      entryId: "first",
      runId,
      occurrence: 1,
    });
    expect(_fixture.find.barProps.activeIndex).toBe(2);
    expect(_fixture.find.barProps.matchCount).toBe(11);
    expect(_fixture.find.timelineProps.findNavigationId).toBe(2);
    await act(async () => _fixture.find.barProps.onNext());
    expect(_fixture.find.timelineProps.activeFindMatch?.occurrence).toBe(2);
    expect(_fixture.find.barProps.activeIndex).toBe(3);
    expect(orchestrationEnvironment.threadFind).toHaveBeenCalledTimes(requests);
  });

  it("fetches the next window from the locally selected match and retains it while pending", async () => {
    await using _fixture = _createFixture();

    setup();
    const initial = {
      ...messageResult(0),
      match: { entryId: "first", runId, occurrence: 0 },
      navigation: [{ entryId: "first", runId, startIndex: 0, count: 2 }],
    };
    queries.results.set(a, initial);
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    await act(async () => _fixture.find.barProps.onNext());
    expect(_fixture.find.timelineProps.activeFindMatch?.occurrence).toBe(1);
    queries.pending = true;
    queries.results.delete(a);
    await act(async () => {
      _fixture.find.barProps.onNext();
      _fixture.find.barProps.onNext();
    });
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "first", occurrence: 1 },
        offset: 2,
      },
    });
    expect(_fixture.find.barProps.activeIndex).toBe(1);
    expect(_fixture.find.timelineProps.findNavigationId).toBe(2);
    queries.pending = false;
    queries.results.set(a, messageResult(3));
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} />);
    expect(_fixture.find.barProps.activeIndex).toBe(3);
    expect(_fixture.find.timelineProps.findNavigationId).toBe(4);
  });

  it("refreshes around the cached selection when live matches are inserted before it", async () => {
    await using _fixture = _createFixture();

    setup();
    using _timers = fakeTimers();
    const initial = {
      ...messageResult(0),
      match: { entryId: "first", runId, occurrence: 0 },
      navigation: [
        { entryId: "first", runId, startIndex: 0, count: 1 },
        { entryId: "second", runId, startIndex: 1, count: 1 },
      ],
    };
    queries.results.set(a, initial);
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    await act(async () => _fixture.find.barProps.onNext());
    expect(_fixture.find.timelineProps.activeFindMatch?.entryId).toBe("second");
    const content = { runs: [], visibleTurnItems: [] };
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} content={content} />);
    await act(async () => vi.advanceTimersByTime(300));
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: { threadId, query: "COD4", skills: [], start: { entryId: "second", occurrence: 0 } },
    });
    queries.results.set(a, {
      ...initial,
      snapshotSequence: 10,
      totalMatches: 11,
      activeIndex: 2,
      match: { entryId: "second", runId, occurrence: 0 },
      navigation: [
        { entryId: "inserted", runId, startIndex: 1, count: 1 },
        { entryId: "second", runId, startIndex: 2, count: 1 },
      ],
    });
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} content={content} />);
    expect(_fixture.find.barProps.matchCount).toBe(11);
    expect(_fixture.find.barProps.activeIndex).toBe(2);
    expect(_fixture.find.timelineProps.activeFindMatch?.entryId).toBe("second");
    expect(_fixture.find.timelineProps.findNavigationId).toBe(2);
    await act(async () => _fixture.find.barProps.onPrevious());
    expect(_fixture.find.timelineProps.activeFindMatch?.entryId).toBe("inserted");
  });

  it("asks the server rather than using stale navigation counts during live updates", async () => {
    await using _fixture = _createFixture();

    setup();
    const initial = {
      ...messageResult(0),
      navigation: [{ entryId: "message:2", runId, startIndex: 0, count: 10 }],
    };
    queries.results.set(a, initial);
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    await screen.rerender(
      <Probe _fixture={_fixture} environmentId={a} content={{ runs: [], visibleTurnItems: [] }} />,
    );
    await act(async () => _fixture.find.barProps.onNext());
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:2", occurrence: 0 },
        offset: 1,
      },
    });
  });

  it("starts from the viewport and steps from the server-selected match", async () => {
    await using _fixture = _createFixture();

    setup();
    queries.results.set(a, messageResult(4));
    await using _screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    _fixture.find.timelineProps.findPositionReaderRef.current = () => ({
      entryId: "message:6",
      occurrence: 1,
    });
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 1 },
      },
    });
    expect(_fixture.find.barProps.activeIndex).toBe(4);
    queries.results.set(a, messageResult(5));
    await act(async () => _fixture.find.barProps.onNext());
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 0 },
        offset: 1,
      },
    });
    expect(_fixture.find.timelineProps.activeFindMatch?.entryId).toBe("message:7");
    queries.results.set(a, messageResult(4));
    await act(async () => _fixture.find.barProps.onPrevious());
    expect(_fixture.find.barProps.activeIndex).toBe(4);
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:7", occurrence: 0 },
        offset: -1,
      },
    });
  });

  it("accumulates rapid navigation against the same match until the response arrives", async () => {
    await using _fixture = _createFixture();

    setup();
    queries.results.set(a, messageResult(4));
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    queries.pending = true;
    queries.results.delete(a);
    await act(async () => _fixture.find.barProps.onNext());
    await act(async () => _fixture.find.barProps.onNext());
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 0 },
        offset: 2,
      },
    });
    expect(_fixture.find.timelineProps.findNavigationId).toBe(1);
    queries.pending = false;
    queries.results.set(a, messageResult(6));
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} />);
    expect(_fixture.find.timelineProps.findNavigationId).toBe(3);
    expect(_fixture.find.barProps.activeIndex).toBe(6);
  });

  it("refreshes continuous updates without shifting the current match or showing Searching", async () => {
    await using _fixture = _createFixture();

    setup();
    using _timers = fakeTimers();
    queries.results.set(a, messageResult(4));
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    for (let i = 0; i < 3; i++) {
      await screen.rerender(
        <Probe
          _fixture={_fixture}
          environmentId={a}
          content={{ visibleTurnItems: [], runs: [] }}
        />,
      );
      await act(async () => vi.advanceTimersByTime(100));
    }
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 0 },
      },
    });
    const updated = { ...messageResult(5, 10), totalMatches: 11, match: messageResult(4).match };
    queries.results.set(a, updated);
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} />);
    expect(_fixture.find.barProps.matchCount).toBe(11);
    expect(_fixture.find.barProps.activeIndex).toBe(5);
    expect(_fixture.find.timelineProps.activeFindMatch?.entryId).toBe("message:6");
    expect(_fixture.find.timelineProps.findNavigationId).toBe(1);
    expect(_fixture.find.barProps.status).toBeNull();
    await act(async () => _fixture.find.barProps.onNext());
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 0 },
        offset: 1,
      },
    });
  });

  it("keeps pending navigation when incoming content triggers a refresh", async () => {
    await using _fixture = _createFixture();

    setup();
    using _timers = fakeTimers();
    queries.results.set(a, messageResult(4));
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    queries.pending = true;
    queries.results.delete(a);
    await act(async () => _fixture.find.barProps.onNext());
    await screen.rerender(
      <Probe _fixture={_fixture} environmentId={a} content={{ visibleTurnItems: [], runs: [] }} />,
    );
    await act(async () => vi.advanceTimersByTime(300));
    expect(queries.refresh).toHaveBeenCalledTimes(1);
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 0 },
        offset: 1,
      },
    });
    queries.pending = false;
    queries.results.set(a, { ...messageResult(6, 10), totalMatches: 11 });
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} />);
    expect(_fixture.find.timelineProps.activeFindMatch?.entryId).toBe("message:8");
    expect(_fixture.find.timelineProps.findNavigationId).toBe(2);
    expect(_fixture.find.barProps.matchCount).toBe(11);
  });

  it("does not navigate the previous result while a new match is loading", async () => {
    await using _fixture = _createFixture();

    setup();
    queries.results.set(a, messageResult(0));
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    queries.pending = true;
    queries.results.delete(a);
    await act(async () => _fixture.find.barProps.onNext());
    expect(_fixture.find.timelineProps.activeFindMatch?.entryId).toBe("message:2");
    expect(_fixture.find.timelineProps.findNavigationId).toBe(1);
    expect(_fixture.find.barProps.status).toBeNull();
    expect(_fixture.find.barProps.activeIndex).toBe(0);
    expect(_fixture.find.barProps.matchCount).toBe(10);
    queries.pending = false;
    queries.results.set(a, messageResult(1));
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} />);
    expect(_fixture.find.timelineProps.activeFindMatch?.entryId).toBe("message:3");
    expect(_fixture.find.timelineProps.findNavigationId).toBe(2);
  });

  it("keeps the reading-position start when Enter is pressed before results arrive", async () => {
    await using _fixture = _createFixture();

    setup();
    queries.pending = true;
    await using _screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    _fixture.find.timelineProps.findPositionReaderRef.current = () => ({
      entryId: "message:6",
      occurrence: 1,
    });
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    await act(async () => _fixture.find.barProps.onNext());
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 1 },
      },
    });
  });

  it("shows Searching only when the query has no result yet", async () => {
    await using _fixture = _createFixture();

    setup();
    queries.pending = true;
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("COD4"));
    expect(_fixture.find.barProps.status).toBe("loading");
    queries.pending = false;
    queries.results.set(a, messageResult(0));
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} />);
    expect(_fixture.find.barProps.status).toBeNull();
    queries.pending = true;
    queries.results.delete(a);
    await act(async () => _fixture.find.barProps.onQueryChange("different query"));
    expect(_fixture.find.barProps.status).toBe("loading");
    expect(_fixture.find.barProps.matchCount).toBe(0);

    expect(_fixture.find.timelineProps.findQuery).toBe("");
    expect(_fixture.find.timelineProps.findExpanded).toBe(true);
    await act(async () => _fixture.find.barProps.onQueryChange(""));
    expect(_fixture.find.timelineProps.findExpanded).toBe(false);
  });

  it("keeps search unavailable when the server does not support it", async () => {
    await using _fixture = _createFixture();

    setup();
    await using _screen = await render(
      <Probe _fixture={_fixture} environmentId={a} enabled={false} />,
    );
    await act(async () => {
      _fixture.find.open();
      requestThreadFindOpen();
    });
    expect(_fixture.find.isOpen).toBe(false);
    expect(_fixture.find.timelineProps.activeFindMatch).toBeNull();
    expect(orchestrationEnvironment.threadFind).not.toHaveBeenCalled();
  });

  it("closes search when support disappears without restoring stale queries", async () => {
    await using _fixture = _createFixture();

    setup();
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => _fixture.find.open());
    await act(async () => _fixture.find.barProps.onQueryChange("needle"));
    expect(_fixture.find.isOpen).toBe(true);
    vi.mocked(orchestrationEnvironment.threadFind).mockClear();
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} enabled={false} />);
    expect(_fixture.find.isOpen).toBe(false);
    expect(_fixture.find.timelineProps.activeFindMatch).toBeNull();
    expect(_fixture.find.timelineProps.findQuery).toBe("");
    expect(orchestrationEnvironment.threadFind).not.toHaveBeenCalled();
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} />);
    expect(_fixture.find.isOpen).toBe(false);
    await act(async () => _fixture.find.open());
    expect(_fixture.find.barProps.query).toBe("");
  });

  it("preserves plan item ID and run ownership for navigation", async () => {
    await using _fixture = _createFixture();

    setup();
    queries.results.set(a, {
      snapshotSequence: 9,
      totalMatches: 1,
      activeIndex: 0,
      match: { entryId: "plan-item", runId, occurrence: 0 },
    });
    await using _screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => {
      _fixture.find.open();
    });
    await act(async () => {
      _fixture.find.barProps.onQueryChange("needle");
    });
    expect(_fixture.find.timelineProps.activeFindMatch).toEqual({
      entryId: "plan-item",
      runId,
      occurrence: 0,
    });
    await act(async () => {
      _fixture.find.close();
    });
    expect(_fixture.find.timelineProps.activeFindMatch).toBeNull();
    expect(_fixture.find.timelineProps.findQuery).toBe("");
  });

  it("drops results on environment changes even when the thread IDs are identical", async () => {
    await using _fixture = _createFixture();

    setup();
    queries.results.set(a, {
      snapshotSequence: 1,
      totalMatches: 3,
      activeIndex: 0,
      match: null,
    });
    queries.results.set(b, {
      snapshotSequence: 2,
      totalMatches: 0,
      activeIndex: 0,
      match: null,
    });
    await using screen = await render(<Probe _fixture={_fixture} environmentId={a} />);
    await act(async () => {
      _fixture.find.open();
    });
    await act(async () => {
      _fixture.find.barProps.onQueryChange("needle");
    });
    expect(_fixture.find.barProps.matchCount).toBe(3);
    await screen.rerender(<Probe _fixture={_fixture} environmentId={b} />);
    expect(_fixture.find.isOpen).toBe(false);
    expect(_fixture.find.timelineProps.activeFindMatch).toBeNull();
    await act(async () => {
      _fixture.find.open();
    });
    await act(async () => {
      _fixture.find.barProps.onQueryChange("needle");
    });
    expect(_fixture.find.barProps.matchCount).toBe(0);
    await screen.rerender(<Probe _fixture={_fixture} environmentId={a} />);
    expect(_fixture.find.isOpen).toBe(false);
  });
});

function _createFixture() {
  let _published_find = undefined! as ReturnType<typeof useThreadFind>;

  const stack = new AsyncDisposableStack();
  return {
    get find() {
      return _published_find;
    },
    publishFind(next: typeof _published_find) {
      _published_find = next;
    },
    stack,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
