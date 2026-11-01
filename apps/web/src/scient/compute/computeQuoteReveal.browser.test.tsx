import "../../index.css";

import { EnvironmentId, ThreadId, type ComputeCitation } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import {
  cancelComputeQuoteReveal,
  finishComputeQuoteReveal,
  requestComputeQuoteReveal,
  showComputeQuote,
  usePendingComputeQuote,
} from "./computeQuoteReveal";

const citation: ComputeCitation = {
  kind: "compute",
  version: 1,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  cwd: "/project",
  place: { _tag: "run", sessionId: "session", executionId: "run", path: null },
  text: "the quoted line",
  start: 0,
  end: 15,
  prefix: "",
  suffix: "",
};

function mountRun(text: string) {
  CSS.highlights.clear();
  const scroller = document.createElement("div");
  scroller.style.cssText = "height:100px;overflow:auto";
  const source = document.createElement("article");
  source.style.cssText = "padding-top:900px";
  source.textContent = text;
  scroller.append(source);
  document.body.append(scroller);
  return { scroller, source, [Symbol.dispose]: () => scroller.remove() };
}

const highlighted = () =>
  [...(CSS.highlights.get("t3-assistant-citation") ?? [])].map((range) => range.toString());

describe("showComputeQuote", () => {
  it("brings the quote into view and marks exactly it", () => {
    using run = mountRun("before the quoted line after");
    showComputeQuote({ ...run, citation });
    expect(run.scroller.scrollTop).toBeGreaterThan(0);
    expect(highlighted()).toEqual(["the quoted line"]);
  });

  it("keeps the mark when the text is redrawn under it", async () => {
    using run = mountRun("before the quoted line after");
    showComputeQuote({ ...run, citation });
    run.source.replaceChildren(
      Object.assign(document.createElement("span"), { textContent: "before " }),
      Object.assign(document.createElement("span"), { textContent: "the quoted line" }),
      " after",
    );
    await vi.waitFor(() => expect(highlighted()).toEqual(["the quoted line"]));
    cancelComputeQuoteReveal();
  });

  it("waits for a quote that lands after its place", async () => {
    using run = mountRun("output still loading");
    showComputeQuote({ ...run, citation });
    expect(highlighted()).toEqual([]);
    run.source.append(" the quoted line");
    await vi.waitFor(() => expect(highlighted()).toEqual(["the quoted line"]));
  });

  it("marks the whole place when the quote never comes", async () => {
    using run = mountRun("other output entirely");
    showComputeQuote({ ...run, citation });
    await vi.waitFor(() => expect(highlighted()).toEqual(["other output entirely"]), {
      timeout: 3_000,
    });
  });

  it("still finds a quote that lands after its place was marked", async () => {
    using run = mountRun("output still loading");
    showComputeQuote({ ...run, citation });
    await vi.waitFor(() => expect(highlighted()).toEqual(["output still loading"]), {
      timeout: 3_000,
    });
    const scrolled = run.scroller.scrollTop;
    run.source.append(" the quoted line");
    await vi.waitFor(() => expect(highlighted()).toEqual(["the quoted line"]));
    expect(run.scroller.scrollTop).toBe(scrolled);
    cancelComputeQuoteReveal();
  });

  it("stops waiting when the reveal is cancelled", async () => {
    using run = mountRun("output still loading");
    showComputeQuote({ ...run, citation });
    cancelComputeQuoteReveal();
    run.source.append(" the quoted line");
    await Promise.resolve();
    expect(highlighted()).toEqual([]);
  });
});

function Pending(props: {
  readonly threadId: string;
  readonly onSeen: (text: string | null) => void;
}) {
  const seen = usePendingComputeQuote(
    { environmentId: citation.environmentId, threadId: ThreadId.make(props.threadId) },
    (pending) => pending.text,
  );
  props.onSeen(seen);
  return null;
}

function Latest(props: { readonly onSeen: (pending: ComputeCitation | null) => void }) {
  props.onSeen(usePendingComputeQuote(citation, (pending) => pending));
  return null;
}

describe("a pending reveal", () => {
  it("belongs to its own conversation", async () => {
    const here = vi.fn();
    const elsewhere = vi.fn();
    requestComputeQuoteReveal(citation);
    await using _screen = await render(
      <>
        <Pending threadId="thread" onSeen={here} />
        <Pending threadId="other" onSeen={elsewhere} />
      </>,
      { router: false },
    );
    expect(here).toHaveBeenLastCalledWith("the quoted line");
    expect(elsewhere).toHaveBeenLastCalledWith(null);
    cancelComputeQuoteReveal();
  });

  it("is cleared only by the request it belongs to", async () => {
    const seen = vi.fn<(pending: ComputeCitation | null) => void>();
    const latest = () => seen.mock.lastCall?.[0] ?? null;
    await using _screen = await render(<Latest onSeen={seen} />, { router: false });
    await act(async () => requestComputeQuoteReveal(citation));
    const first = latest()!;
    await act(async () => requestComputeQuoteReveal(citation));
    const second = latest()!;
    expect(second).not.toBe(first);
    await act(async () => finishComputeQuoteReveal(first));
    expect(latest()).toBe(second);
    await act(async () => finishComputeQuoteReveal(second));
    expect(latest()).toBeNull();
  });
});
