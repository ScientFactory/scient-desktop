import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { advanceTestClock } from "../../../test/testClock";
import "../../index.css";

import {
  EnvironmentId,
  type ScientSourceJournalIconResult,
  type ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { SourceJournalCover } from "./SourceJournalIcon";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
type JournalIcon = NonNullable<ScientSourceJournalIconResult["icon"]> & { url: string };
const environmentId = EnvironmentId.make("journal-cover-test");
const record: SourceRecord = {
  sourceId: "source-test",
  revision: 1,
  type: "article",
  title: "An article",
  creators: [],
  issuedYear: 2026,
  identifiers: [{ scheme: "doi", value: "10.1000/example" }],
  containerTitle: "Example Journal",
  publisher: "Example Publisher",
  url: "https://journal.example/article",
  externalReferences: [],
  attachments: [],
  importedAt: "2026-11-10T00:00:00.000Z",
};
const firstUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>')}`;
const secondUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="red"/></svg>')}`;
const CLOCK_NOW = Date.parse("2026-01-01T00:00:00.000Z");

function icon(url = firstUrl, expiresAt = Date.parse("2100-01-01T00:00:00.000Z")) {
  return {
    url,
    relativeUrl: "/api/assets/journal-test",
    expiresAt,
    journalTitle: "Example Journal",
  };
}

it("retains discovered artwork through unrelated record revisions and article title edits", async () => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const resolveIcon = vi.fn(async () => icon());
  // These covers have no routing behavior.
  await using screen = await render(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={record}
      resolveIcon={resolveIcon}
    />,
    { router: false },
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(firstUrl),
  );
  const image = screen.container.querySelector("img");
  await screen.rerender(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={{ ...record, revision: 2, title: "Corrected article title" }}
      resolveIcon={resolveIcon}
    />,
  );
  expect(screen.container.querySelector("img")).toBe(image);
  expect(resolveIcon).toHaveBeenCalledTimes(1);
});

it("shares pending discovery for duplicate source rows and reuses successful venue artwork for other papers", async () => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const pending = Promise.withResolvers<JournalIcon>();
  const resolveIcon = vi.fn(() => pending.promise);
  // These covers have no routing behavior.
  await using screen = await render(
    <>
      <SourceJournalCover
        environmentId={environmentId}
        root="/project"
        record={record}
        resolveIcon={resolveIcon}
      />
      <SourceJournalCover
        environmentId={environmentId}
        root="/project"
        record={record}
        resolveIcon={resolveIcon}
      />
    </>,
    { router: false },
  );
  await vi.waitFor(() => expect(resolveIcon).toHaveBeenCalledTimes(1));
  await act(() => pending.resolve(icon()));
  await vi.waitFor(() => expect(screen.container.querySelectorAll("img")).toHaveLength(2));
  await screen.rerender(null);
  await screen.rerender(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={{ ...record, sourceId: "third" }}
      resolveIcon={resolveIcon}
    />,
  );
  expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(firstUrl);
  expect(resolveIcon).toHaveBeenCalledTimes(1);
});

it.each(["missing", "failed"] as const)(
  "does not let a %s source lookup suppress another paper in the same venue",
  async (outcome) => {
    using _observer = stubGlobal("IntersectionObserver", undefined);
    const resolveIcon = vi
      .fn()
      .mockImplementationOnce(async () => {
        if (outcome === "failed") throw new Error("offline");
        return null;
      })
      .mockResolvedValue(icon());
    // These covers have no routing behavior.
    await using screen = await render(
      <SourceJournalCover
        environmentId={environmentId}
        root="/project"
        record={{ ...record, sourceId: "without-doi", identifiers: [], url: null }}
        resolveIcon={resolveIcon}
      />,
      { router: false },
    );
    await vi.waitFor(() => expect(resolveIcon).toHaveBeenCalledTimes(1));
    await screen.rerender(
      <SourceJournalCover
        environmentId={environmentId}
        root="/project"
        record={record}
        resolveIcon={resolveIcon}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(firstUrl),
    );
  },
);

it("retries a previously unresolvable source immediately when its DOI arrives", async () => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const resolveIcon = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(icon());
  // This cover has no routing behavior.
  await using screen = await render(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={{ ...record, identifiers: [], url: null }}
      resolveIcon={resolveIcon}
    />,
    { router: false },
  );
  await vi.waitFor(() => expect(resolveIcon).toHaveBeenCalledTimes(1));
  await screen.rerender(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={record}
      resolveIcon={resolveIcon}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(firstUrl),
  );
});

it("never transfers stale artwork or pending completions between journals, publishers, roots, or environments", async () => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const oldJournal = Promise.withResolvers<JournalIcon>();
  const newJournal = Promise.withResolvers<JournalIcon>();
  const newPublisher = Promise.withResolvers<JournalIcon>();
  const newEnvironment = Promise.withResolvers<JournalIcon>();
  const newRoot = Promise.withResolvers<JournalIcon>();
  const resolveIcon = vi
    .fn()
    .mockImplementationOnce(() => oldJournal.promise)
    .mockImplementationOnce(() => newJournal.promise)
    .mockImplementationOnce(() => newPublisher.promise)
    .mockImplementationOnce(() => newEnvironment.promise)
    .mockImplementationOnce(() => newRoot.promise);
  // These covers have no routing behavior.
  await using screen = await render(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={record}
      resolveIcon={resolveIcon}
    />,
    { router: false },
  );
  const otherJournal = { ...record, sourceId: "other-source", containerTitle: "Another Journal" };
  await screen.rerender(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={otherJournal}
      resolveIcon={resolveIcon}
    />,
  );
  await act(() => oldJournal.resolve(icon()));
  expect(screen.container.querySelector("img")).toBeNull();
  await act(() => newJournal.resolve(icon(secondUrl)));
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(secondUrl),
  );
  const changed = { ...otherJournal, publisher: "Unrelated Publisher" };
  await screen.rerender(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={changed}
      resolveIcon={resolveIcon}
    />,
  );
  expect(screen.container.querySelector("img")).toBeNull();
  await act(() => newPublisher.resolve(icon(secondUrl)));
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(secondUrl),
  );

  const otherEnvironment = EnvironmentId.make("other-journal-environment");
  await screen.rerender(
    <SourceJournalCover
      environmentId={otherEnvironment}
      root="/project"
      record={changed}
      resolveIcon={resolveIcon}
    />,
  );
  expect(screen.container.querySelector("img")).toBeNull();
  await act(() => newEnvironment.resolve(icon()));
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(firstUrl),
  );
  await screen.rerender(
    <SourceJournalCover
      environmentId={otherEnvironment}
      root="/other-project"
      record={changed}
      resolveIcon={resolveIcon}
    />,
  );
  expect(screen.container.querySelector("img")).toBeNull();
  await act(() => newRoot.resolve(icon(secondUrl)));
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(secondUrl),
  );
  expect(resolveIcon).toHaveBeenCalledTimes(5);
});

// regression: a corrected DOI can point at another journal's cover address
it("looks the cover up again when a corrected DOI names another journal", async () => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const resolveIcon = vi
    .fn()
    .mockResolvedValueOnce(icon(firstUrl))
    .mockResolvedValueOnce(icon(secondUrl));
  const springer = (doi: string) => ({
    ...record,
    sourceId: "corrected-doi",
    identifiers: [{ scheme: "doi", value: doi }],
  });
  // This cover has no routing behavior.
  await using screen = await render(
    <SourceJournalCover
      environmentId={environmentId}
      root="/doi-correction"
      record={springer("10.1186/s12913-020-1")}
      resolveIcon={resolveIcon}
    />,
    { router: false },
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(firstUrl),
  );
  await screen.rerender(
    <SourceJournalCover
      environmentId={environmentId}
      root="/doi-correction"
      record={springer("DOI: 10.1186/s12889-020-1")}
      resolveIcon={resolveIcon}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(secondUrl),
  );
  expect(resolveIcon).toHaveBeenCalledTimes(2);
});

it("isolates injected resolvers even for an otherwise identical journal", async () => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const firstResolver = vi.fn(async () => icon());
  const pending = Promise.withResolvers<JournalIcon>();
  const secondResolver = vi.fn(() => pending.promise);
  // These covers have no routing behavior.
  await using screen = await render(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={record}
      resolveIcon={firstResolver}
    />,
    { router: false },
  );
  await vi.waitFor(() => expect(screen.container.querySelector("img")).not.toBeNull());
  await screen.rerender(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={record}
      resolveIcon={secondResolver}
    />,
  );
  expect(screen.container.querySelector("img")).toBeNull();
  await act(() => pending.resolve(icon(secondUrl)));
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(secondUrl),
  );
});

it("waits for viewport admission and shows nothing for articles without a journal", async () => {
  let admit: (() => void) | undefined;
  using _observer = stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        admit = () =>
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      disconnect() {}
    },
  );
  const resolveIcon = vi.fn(async () => icon());
  // These covers have no routing behavior.
  await using screen = await render(
    <>
      <SourceJournalCover
        environmentId={environmentId}
        root="/project"
        record={record}
        resolveIcon={resolveIcon}
      />
      <SourceJournalCover
        environmentId={environmentId}
        root="/project"
        record={{ ...record, sourceId: "no-journal", containerTitle: null }}
        resolveIcon={resolveIcon}
      />
    </>,
    { router: false },
  );
  expect(resolveIcon).not.toHaveBeenCalled();
  expect(screen.container.querySelectorAll("img")).toHaveLength(0);
  expect(admit).toBeDefined();
  await act(() => admit!());
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('[data-testid="source-journal-cover"]')).toHaveLength(
      1,
    ),
  );
  expect(resolveIcon).toHaveBeenCalledTimes(1);
});

it("renews expiring signed artwork without clearing a displayed image on a transient failure", async ({
  signal,
}) => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const initial = Promise.withResolvers<JournalIcon>();
  const resolveIcon = vi
    .fn()
    .mockImplementationOnce(() => initial.promise)
    .mockRejectedValueOnce(new Error("temporarily offline"))
    .mockImplementation(async () => icon(secondUrl));
  await using fixture = new AsyncDisposableStack();
  // These covers have no routing behavior. The clock outlives the mounted screen.
  const screen = await render(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={record}
      resolveIcon={resolveIcon}
    />,
    { router: false },
  );
  fixture.use(fakeTimers({ now: CLOCK_NOW }));
  fixture.use(screen);
  await act(() => initial.resolve(icon(firstUrl, CLOCK_NOW + 60_000)));
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(firstUrl),
  );
  const image = screen.container.querySelector("img");
  await advanceTestClock(signal, 45_000);
  expect(resolveIcon).toHaveBeenCalledTimes(2);
  expect(screen.container.querySelector("img")).toBe(image);
  await advanceTestClock(signal, 30_000);
  expect(resolveIcon).toHaveBeenCalledTimes(3);
  expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(secondUrl);
});

it("does not reuse expired signed URLs on remount and recovers a failed image with a renewed URL", async ({
  signal,
}) => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const initial = Promise.withResolvers<JournalIcon>();
  const renewed = Promise.withResolvers<JournalIcon>();
  const resolveIcon = vi
    .fn()
    .mockImplementationOnce(() => initial.promise)
    .mockImplementationOnce(() => renewed.promise);
  await using fixture = new AsyncDisposableStack();
  // These covers have no routing behavior. The clock outlives the mounted screen.
  const screen = await render(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={record}
      resolveIcon={resolveIcon}
    />,
    { router: false },
  );
  fixture.use(fakeTimers({ now: CLOCK_NOW }));
  fixture.use(screen);
  await act(() => initial.resolve(icon(firstUrl, CLOCK_NOW + 60_000)));
  await vi.waitFor(() => expect(screen.container.querySelector("img")).not.toBeNull());
  await act(() => screen.container.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(screen.container.querySelector("img")).toBeNull();
  await screen.rerender(null);
  await advanceTestClock(signal, 60_001);
  await screen.rerender(
    <SourceJournalCover
      environmentId={environmentId}
      root="/project"
      record={record}
      resolveIcon={resolveIcon}
    />,
  );
  expect(screen.container.querySelector("img")).toBeNull();
  await act(() => renewed.resolve(icon(secondUrl)));
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(secondUrl),
  );
});
