import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { advanceTestClock } from "../../../test/testClock";
import "../../index.css";

import {
  EnvironmentId,
  type ScientSourceJournalIconResult,
  type ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { SourceJournalIcon } from "./SourceJournalIcon";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
type JournalIcon = NonNullable<ScientSourceJournalIconResult["icon"]> & { url: string };
const environmentId = EnvironmentId.make("journal-icon-test");
const record: SourceRecord = {
  sourceId: "source-test",
  revision: 1,
  type: "article",
  title: "An article",
  creators: [],
  issuedYear: 2026,
  identifiers: [{ scheme: "doi", value: "10.1000/example" }],
  containerTitle: "Unbundled Journal",
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
    journalTitle: "Unbundled Journal",
  };
}

it("decodes bundled artwork offline without asking the environment", async () => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const resolveIcon = vi.fn(async () => {
    throw new Error("offline");
  });
  // These leaf icons have no routing behavior.
  await using screen = await render(
    <SourceJournalIcon
      environmentId={environmentId}
      root="/project"
      record={{ ...record, containerTitle: "Nature", identifiers: [], url: null }}
      resolveIcon={resolveIcon}
    />,
    { router: false },
  );
  const images = [...screen.container.querySelectorAll("img")];
  expect(images).toHaveLength(1);
  await vi.waitFor(() =>
    expect(images.every((image) => image.complete && image.naturalWidth > 0)).toBe(true),
  );
  expect(screen.container.querySelector('[data-testid="source-generic-icon"]')).toBeNull();
  expect(resolveIcon).not.toHaveBeenCalled();
});

it("replaces a PubMed platform fallback with the journal artwork discovered through its DOI", async () => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const pending = Promise.withResolvers<JournalIcon>();
  const resolveIcon = vi.fn(() => pending.promise);
  // This leaf icon has no routing behavior.
  await using screen = await render(
    <SourceJournalIcon
      environmentId={environmentId}
      root="/project"
      record={{ ...record, url: "https://pubmed.ncbi.nlm.nih.gov/12345678/" }}
      resolveIcon={resolveIcon}
    />,
    { router: false },
  );
  const fallbackUrl = screen.container.querySelector("img")?.getAttribute("src");
  expect(fallbackUrl).toMatch(/pubmed/);
  await vi.waitFor(() => expect(resolveIcon).toHaveBeenCalledTimes(1));
  await act(() => pending.resolve(icon()));
  await vi.waitFor(() =>
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(firstUrl),
  );
});

it("retains discovered artwork through unrelated record revisions and article title edits", async () => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const resolveIcon = vi.fn(async () => icon());
  // These leaf icons have no routing behavior.
  await using screen = await render(
    <SourceJournalIcon
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
    <SourceJournalIcon
      environmentId={environmentId}
      root="/project"
      record={{ ...record, revision: 2, title: "Corrected article title" }}
      resolveIcon={resolveIcon}
    />,
  );
  expect(screen.container.querySelector("img")).toBe(image);
  expect(resolveIcon).toHaveBeenCalledTimes(1);
});

it("shares pending discovery across journal rows and reuses the result after remounting", async () => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const pending = Promise.withResolvers<JournalIcon>();
  const resolveIcon = vi.fn(() => pending.promise);
  // These leaf icons have no routing behavior.
  await using screen = await render(
    <>
      <SourceJournalIcon
        environmentId={environmentId}
        root="/project"
        record={record}
        resolveIcon={resolveIcon}
      />
      <SourceJournalIcon
        environmentId={environmentId}
        root="/project"
        record={{
          ...record,
          sourceId: "second",
          url: "https://journal.example/another-article",
          identifiers: [],
        }}
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
    <SourceJournalIcon
      environmentId={environmentId}
      root="/project"
      record={{ ...record, sourceId: "third" }}
      resolveIcon={resolveIcon}
    />,
  );
  expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(firstUrl);
  expect(resolveIcon).toHaveBeenCalledTimes(1);
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
  // These leaf icons have no routing behavior.
  await using screen = await render(
    <SourceJournalIcon
      environmentId={environmentId}
      root="/project"
      record={record}
      resolveIcon={resolveIcon}
    />,
    { router: false },
  );
  const otherJournal = { ...record, sourceId: "other-source", containerTitle: "Another Journal" };
  await screen.rerender(
    <SourceJournalIcon
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
    <SourceJournalIcon
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
    <SourceJournalIcon
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
    <SourceJournalIcon
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

it("isolates injected resolvers even for an otherwise identical journal", async () => {
  using _observer = stubGlobal("IntersectionObserver", undefined);
  const firstResolver = vi.fn(async () => icon());
  const pending = Promise.withResolvers<JournalIcon>();
  const secondResolver = vi.fn(() => pending.promise);
  // These leaf icons have no routing behavior.
  await using screen = await render(
    <SourceJournalIcon
      environmentId={environmentId}
      root="/project"
      record={record}
      resolveIcon={firstResolver}
    />,
    { router: false },
  );
  await vi.waitFor(() => expect(screen.container.querySelector("img")).not.toBeNull());
  await screen.rerender(
    <SourceJournalIcon
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

it("waits for viewport admission and leaves articles without a journal on their generic icon", async () => {
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
  // These leaf icons have no routing behavior.
  await using screen = await render(
    <>
      <SourceJournalIcon
        environmentId={environmentId}
        root="/project"
        record={record}
        resolveIcon={resolveIcon}
      />
      <SourceJournalIcon
        environmentId={environmentId}
        root="/project"
        record={{ ...record, sourceId: "no-journal", containerTitle: null }}
        resolveIcon={resolveIcon}
      />
    </>,
    { router: false },
  );
  expect(resolveIcon).not.toHaveBeenCalled();
  expect(screen.container.querySelectorAll('[data-testid="source-generic-icon"]')).toHaveLength(2);
  expect(admit).toBeDefined();
  await act(() => admit!());
  await vi.waitFor(() => expect(screen.container.querySelectorAll("img")).toHaveLength(1));
  expect(screen.container.querySelectorAll('[data-testid="source-generic-icon"]')).toHaveLength(1);
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
  // These leaf icons have no routing behavior. The clock outlives the mounted screen.
  const screen = await render(
    <SourceJournalIcon
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
  // These leaf icons have no routing behavior. The clock outlives the mounted screen.
  const screen = await render(
    <SourceJournalIcon
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
  expect(screen.container.querySelector('[data-testid="source-generic-icon"]')).not.toBeNull();
  await screen.rerender(null);
  await advanceTestClock(signal, 60_001);
  await screen.rerender(
    <SourceJournalIcon
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
