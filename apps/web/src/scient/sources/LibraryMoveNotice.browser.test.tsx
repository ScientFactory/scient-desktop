import { fakeTimers, render } from "../../../test/render";
import "../../index.css";

import type {
  EnvironmentId,
  ScientSourcesMoveStatus,
  ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { advanceTestClock } from "../../../test/testClock";
import { LibraryMoveNotice } from "./LibraryMoveNotice";
import { libraryWriteSettled } from "./libraryWrites";
import { SourcesHeaderMenu } from "./SourcesHeaderMenu";
import { useLibraryMoveStatus } from "./useLibraryMoveStatus";

const mocks = vi.hoisted(() => ({
  readLibraryMoveStatus: vi.fn(),
  organizeScientSources: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("./sourcesCommands", () => ({
  sourcesCommands: { organize: {} },
  runSourcesCommand: vi.fn(),
  useCanRunSourcesCommand: () => true,
  useCanChangeLibrary: () => true,
}));
// The header menu's own dialogs import these; none of them opens here.
vi.mock("./client", () => ({
  readLibraryMoveStatus: mocks.readLibraryMoveStatus,
  organizeScientSources: mocks.organizeScientSources,
  readCitationStyles: vi.fn(),
  setCitationStyle: vi.fn(),
  exportScientSources: vi.fn(),
  readScientSourceTrash: vi.fn(),
  restoreScientSource: vi.fn(),
  deleteScientSourcesPermanently: vi.fn(),
}));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

const environmentId = "environment-1" as EnvironmentId;

function overview(libraryBackend: boolean): ScientSourcesOverviewResult {
  return {
    projectState: "initialized",
    issues: [],
    recordDiagnostics: [],
    activeOperation: null,
    records: [],
    ...(libraryBackend ? { libraryBackend: true as const } : {}),
  };
}

function Harness(props: { readonly libraryBackend: boolean }) {
  const move = useLibraryMoveStatus({
    environmentId,
    root: "/project",
    overview: overview(props.libraryBackend),
    onStoreChanged: () => undefined,
  });
  return (
    <>
      <LibraryMoveNotice move={move} />
      <SourcesHeaderMenu
        environmentId={environmentId}
        root="/project"
        totalCount={0}
        exportScope={null}
        trashedCount={0}
        onTrashChanged={async () => undefined}
        missingPdfCount={0}
        onGetMissingPdfs={() => undefined}
        onOpenReviews={() => undefined}
        onOpenSource={() => undefined}
        {...(move.canMoveBack ? { onMoveBack: () => void move.moveBack() } : {})}
      />
    </>
  );
}

/** Answers each status read in turn, repeating the last; a Library change notifies the panel. */
function setup(statuses: ReadonlyArray<ScientSourcesMoveStatus>) {
  mocks.readLibraryMoveStatus.mockReset();
  mocks.organizeScientSources.mockReset();
  mocks.toast.mockReset();
  let read = 0;
  mocks.readLibraryMoveStatus.mockImplementation(async () => {
    const status = statuses[Math.min(read, statuses.length - 1)]!;
    read += 1;
    return status;
  });
  mocks.organizeScientSources.mockImplementation(async (id: EnvironmentId, input) => {
    libraryWriteSettled(id);
    return input.change.action === "move-back"
      ? { outcome: "not-moved" }
      : { outcome: "dismissed" };
  });
}

const summary = "Merged 3 duplicates. 1 kept different values: Review.";

describe("the Library's move line", () => {
  it("shows the summary in library mode and Dismiss removes it", async () => {
    setup([
      { state: "done", lines: [summary] },
      { state: "done", lines: [] },
    ]);
    await using screen = await render(<Harness libraryBackend />, { router: false });

    await expect.element(screen.getByText(summary, { exact: false })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await vi.waitFor(() =>
      expect(mocks.organizeScientSources).toHaveBeenCalledWith(environmentId, {
        root: "/project",
        change: { action: "dismiss-move-summary" },
      }),
    );
    await expect.element(screen.getByText(summary, { exact: false })).not.toBeInTheDocument();
  });

  it("sends no status request on the project backend", async () => {
    setup([{ state: "waiting" }]);
    await using _screen = await render(<Harness libraryBackend={false} />, { router: false });

    expect(mocks.readLibraryMoveStatus).not.toHaveBeenCalled();
  });

  it("asks again only while the move runs, and stops when it is done", async ({ signal }) => {
    await using resources = new AsyncDisposableStack();
    const clock = fakeTimers();
    resources.defer(() => clock[Symbol.dispose]());
    setup([
      { state: "moving", progress: { phase: "files", done: 1, total: 3 } },
      { state: "moving", progress: { phase: "files", done: 2, total: 3 } },
      { state: "done", lines: [] },
    ]);
    const screen = resources.use(await render(<Harness libraryBackend />, { router: false }));

    await expect
      .element(screen.getByText("Moving the Library out of this project: copying PDFs 1 of 3."))
      .toBeVisible();
    await advanceTestClock(signal, 1_000);
    await expect
      .element(screen.getByText("Moving the Library out of this project: copying PDFs 2 of 3."))
      .toBeVisible();
    await advanceTestClock(signal, 1_000);
    expect(mocks.readLibraryMoveStatus).toHaveBeenCalledTimes(3);
    await advanceTestClock(signal, 5_000);
    expect(mocks.readLibraryMoveStatus).toHaveBeenCalledTimes(3);
  });

  it("stops asking when the panel closes", async ({ signal }) => {
    await using resources = new AsyncDisposableStack();
    const clock = fakeTimers();
    resources.defer(() => clock[Symbol.dispose]());
    setup([{ state: "moving", progress: null }]);
    const screen = resources.use(await render(<Harness libraryBackend />, { router: false }));
    await expect.element(screen.getByText("Moving the Library out of this project.")).toBeVisible();

    await screen.unmount();
    const asked = mocks.readLibraryMoveStatus.mock.calls.length;
    await advanceTestClock(signal, 5_000);

    expect(mocks.readLibraryMoveStatus).toHaveBeenCalledTimes(asked);
  });

  it("moves back after confirmation and shows a repeat's answer as the result", async () => {
    setup([
      { state: "done", lines: [summary] },
      { state: "moved-back", restoredSources: 2, restoredPdfs: 1 },
    ]);
    await using screen = await render(<Harness libraryBackend />, { router: false });
    await expect.element(screen.getByText(summary, { exact: false })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "More Library actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Move back into this project" }));
    await userEvent.click(page.getByRole("button", { name: "Move back" }));

    await vi.waitFor(() =>
      expect(mocks.organizeScientSources).toHaveBeenCalledWith(environmentId, {
        root: "/project",
        change: { action: "move-back" },
      }),
    );
    await expect
      .element(screen.getByText("The Library is back in this project: 2 sources, 1 PDF."))
      .toBeVisible();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("asks again after a first read that failed", async ({ signal }) => {
    await using resources = new AsyncDisposableStack();
    const clock = fakeTimers();
    resources.defer(() => clock[Symbol.dispose]());
    setup([{ state: "moving", progress: null }]);
    mocks.readLibraryMoveStatus.mockRejectedValueOnce(new Error("offline"));
    const screen = resources.use(await render(<Harness libraryBackend />, { router: false }));
    await vi.waitFor(() => expect(mocks.readLibraryMoveStatus).toHaveBeenCalledTimes(1));

    // The failed answer lands during the first step, so the retry may be timed from its end.
    await advanceTestClock(signal, 5_000);
    await advanceTestClock(signal, 5_000);

    await expect.element(screen.getByText("Moving the Library out of this project.")).toBeVisible();
  });

  it("does not call a move back failed when its answer and the status are both lost", async () => {
    setup([
      { state: "done", lines: [summary] },
      { state: "moved-back", restoredSources: 2, restoredPdfs: 1 },
    ]);
    mocks.organizeScientSources.mockRejectedValueOnce(new Error("timed out"));
    await using screen = await render(<Harness libraryBackend />, { router: false });
    await expect.element(screen.getByText(summary, { exact: false })).toBeVisible();
    mocks.readLibraryMoveStatus.mockRejectedValueOnce(new Error("offline"));

    await userEvent.click(screen.getByRole("button", { name: "More Library actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Move back into this project" }));
    await userEvent.click(page.getByRole("button", { name: "Move back" }));

    await expect
      .element(screen.getByText("The Library is back in this project: 2 sources, 1 PDF."))
      .toBeVisible();
    expect(mocks.toast.mock.calls.map(([toast]) => toast.title)).toEqual([
      "Moving back could not be confirmed",
    ]);
  });
});
