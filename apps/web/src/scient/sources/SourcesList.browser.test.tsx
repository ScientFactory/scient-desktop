import { render } from "../../../test/render";
import "../../index.css";

import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { removeSnapshotsLabel } from "./libraryLabels";
import { showSourceRowMenu } from "./sourceRowMenu";
import { SOURCE_ROW_ESTIMATED_SIZE, SourcesList } from "./SourcesList";
import { SnapshotRemovalDialog, useLibraryProjectActions } from "./useLibraryProjectActions";
import { useScientSources } from "./useScientSources";

const mocks = vi.hoisted(() => ({
  readScientSources: vi.fn(),
  setScientSourcesReadingState: vi.fn(),
  organizeScientSources: vi.fn(),
  showContextMenu: vi.fn(),
}));

vi.mock("./client", () => ({
  readScientSources: mocks.readScientSources,
  setScientSourcesReadingState: mocks.setScientSourcesReadingState,
  organizeScientSources: mocks.organizeScientSources,
  readScientSourceJournalIcon: vi.fn(async () => null),
  readScientSource: vi.fn(),
  advanceSourcesImport: vi.fn(),
  importScientSourcesFile: vi.fn(),
  beginLocalSourcesImport: vi.fn(),
  beginZoteroItemsImport: vi.fn(),
  beginZoteroScopeImport: vi.fn(),
  cancelSourcesImport: vi.fn(),
  discardLocalSourcePdfs: vi.fn(),
  preflightZoteroItems: vi.fn(),
  refreshScientSourceMetadata: vi.fn(),
  removeScientSource: vi.fn(),
  retrySourcesImport: vi.fn(),
  updateScientSourceNote: vi.fn(),
  readZoteroLibrary: vi.fn(),
  readZoteroCollections: vi.fn(),
  readZoteroStatus: vi.fn(),
  uploadLocalSourcePdf: vi.fn(),
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: mocks.showContextMenu } }),
}));

const environmentId = "environment-1" as EnvironmentId;
const SOURCE_COUNT = 3000;
const SNAPSHOT_INDEX = 2500;
type SourceRecord = ScientSourcesOverviewResult["records"][number];

function record(index: number, overrides: Partial<SourceRecord> = {}): SourceRecord {
  const id = String(index).padStart(4, "0");
  return {
    sourceId: `source-${id}`,
    revision: 1,
    type: "article",
    title: `Source ${id}`,
    creators: [],
    issuedYear: 2024,
    identifiers: [],
    containerTitle: null,
    url: null,
    externalReferences: [],
    attachments: [],
    importedAt: "2026-11-10T00:00:00.000Z",
    pinned: true,
    citationKey: `source${id}`,
    readingStatus: "unread",
    starred: false,
    ...overrides,
  };
}

/** A personal Library's "This project" view; one deep row is a pin's snapshot this Library lacks. */
function overview(retitled?: string): ScientSourcesOverviewResult {
  return {
    projectState: "initialized",
    issues: [],
    recordDiagnostics: [],
    activeOperation: null,
    scopes: { listed: "project", project: SOURCE_COUNT, library: SOURCE_COUNT },
    libraryBackend: true,
    records: Array.from({ length: SOURCE_COUNT }, (_, index) => {
      if (index === SNAPSHOT_INDEX) {
        const {
          readingStatus: _status,
          starred: _starred,
          ...snapshot
        } = record(index, {
          title: "Snapshot source",
          fromSnapshot: true,
        });
        return snapshot;
      }
      if (index === 1 && retitled) return record(index, { title: retitled });
      return record(index);
    }),
  };
}

// The panel's wiring of the list, the row menu and the Library actions, over the real hook.
function Harness() {
  const sources = useScientSources({ environmentId, root: "/project" });
  const actions = useLibraryProjectActions({
    environmentId,
    root: "/project",
    refreshOverview: sources.refreshOverview,
    applyReadingState: sources.applyReadingState,
  });
  const ignore = () => undefined;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: 600, width: 720 }}>
      <button type="button" onClick={() => void sources.refreshOverview()}>
        Read the overview again
      </button>
      <SourcesList
        records={sources.overview?.records ?? []}
        row={{
          environmentId,
          root: "/project",
          listed: sources.overview?.scopes?.listed,
          selection: new Set(),
          recentlyAddedSourceIds: new Set(),
          diagnosticsBySourceId: new Map(),
          onToggleSelected: ignore,
          onOpenDetails: ignore,
          onOpenPdf: ignore,
          onShowMenu: (shown, anchorPoint) =>
            void showSourceRowMenu({
              record: shown,
              anchorPoint,
              listed: sources.overview?.scopes?.listed,
              selected: false,
              busy: sources.busy,
              canChange: true,
              canSetReading: true,
              canChangeProject: true,
              isCurrent: () => true,
              onView: ignore,
              onEdit: ignore,
              onOpenPdf: ignore,
              onToggleSelected: ignore,
              onSetReadingStatus: ignore,
              onAddToProject: ignore,
              onRemoveFromProject: () => void actions.removeFromProject([shown]),
              onMoveToTrash: ignore,
            }),
          onToggleStar: (shown) =>
            actions.setReadingState([shown.sourceId], { starred: shown.starred !== true }, false),
        }}
      />
      <SnapshotRemovalDialog actions={actions} />
    </div>
  );
}

function setup() {
  mocks.readScientSources.mockReset();
  mocks.setScientSourcesReadingState.mockReset();
  mocks.organizeScientSources.mockReset();
  mocks.showContextMenu.mockReset();
}

function mountedRows(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[aria-label="More source actions"]')].map(
    (button) => button.closest<HTMLElement>(".group")!,
  );
}

function rowTitled(container: HTMLElement, title: string) {
  return mountedRows(container).find((row) => row.textContent?.includes(title)) ?? null;
}

function scrollerOf(element: HTMLElement): HTMLElement {
  let current = element.parentElement;
  while (current && !["auto", "scroll"].includes(getComputedStyle(current).overflowY)) {
    current = current.parentElement;
  }
  if (!current) throw new Error("The sources list has no scroll container.");
  return current;
}

describe("Sources list at Library size", () => {
  it("mounts only a window of 3,000 rows, each at the estimated height", async () => {
    setup();
    mocks.readScientSources.mockResolvedValue(overview());
    await using screen = await render(<Harness />, { router: false });

    await expect.element(screen.getByText("Source 0001")).toBeVisible();
    const rows = mountedRows(screen.container);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(60);
    expect(rowTitled(screen.container, "Source 2999")).toBeNull();

    // Row 1 is a Library row (star slot, unread dot); the snapshot row has neither, like a project row.
    const libraryRow = rowTitled(screen.container, "Source 0001")!;
    expect(libraryRow.parentElement!.getBoundingClientRect().height).toBe(
      SOURCE_ROW_ESTIMATED_SIZE,
    );
    const scroller = scrollerOf(libraryRow);
    scroller.scrollTop = SNAPSHOT_INDEX * SOURCE_ROW_ESTIMATED_SIZE - 120;
    await expect.element(screen.getByText("Snapshot source")).toBeVisible();
    const snapshotRow = rowTitled(screen.container, "Snapshot source")!;
    expect(snapshotRow.parentElement!.getBoundingClientRect().height).toBe(
      SOURCE_ROW_ESTIMATED_SIZE,
    );
    expect(mountedRows(screen.container).length).toBeLessThan(60);
  });

  it("keeps a row's star when an overview read before the change arrives after it", async () => {
    setup();
    mocks.readScientSources.mockResolvedValueOnce(overview());
    await using screen = await render(<Harness />, { router: false });
    await expect.element(screen.getByText("Source 0000")).toBeVisible();

    const olderAnswer = Promise.withResolvers<ScientSourcesOverviewResult>();
    mocks.readScientSources.mockReturnValueOnce(olderAnswer.promise);
    await userEvent.click(screen.getByRole("button", { name: "Read the overview again" }));
    mocks.setScientSourcesReadingState.mockResolvedValue({
      sources: [{ sourceId: "source-0000", outcome: "updated", starred: true }],
    });
    await userEvent.click(screen.getByRole("button", { name: "Star: Source 0000" }));
    await expect
      .element(screen.getByRole("button", { name: "Remove star: Source 0000" }))
      .toBeVisible();

    // The older answer still has the row unstarred; its other change shows that it landed.
    olderAnswer.resolve(overview("Source 0001 read again"));
    await expect.element(screen.getByText("Source 0001 read again")).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove star: Source 0000" }).query()).not.toBeNull();
  });

  it("asks before removing a snapshot reached by scrolling", async () => {
    setup();
    mocks.readScientSources.mockResolvedValue(overview());
    mocks.showContextMenu.mockResolvedValue("remove-from-project");
    await using screen = await render(<Harness />, { router: false });
    await expect.element(screen.getByText("Source 0000")).toBeVisible();

    const scroller = scrollerOf(rowTitled(screen.container, "Source 0000")!);
    scroller.scrollTop = SNAPSHOT_INDEX * SOURCE_ROW_ESTIMATED_SIZE - 120;
    await expect.element(screen.getByText("Snapshot source")).toBeVisible();
    const snapshotRow = rowTitled(screen.container, "Snapshot source")!;
    await userEvent.click(
      snapshotRow.querySelector<HTMLElement>('[aria-label="More source actions"]')!,
    );

    await expect.element(page.getByText(removeSnapshotsLabel(1))).toBeVisible();
    expect(mocks.showContextMenu).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "remove-from-project" })]),
      expect.anything(),
    );
    expect(mocks.organizeScientSources).not.toHaveBeenCalled();
  });
});
