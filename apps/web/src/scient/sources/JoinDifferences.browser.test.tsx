import "../../index.css";

import type { EnvironmentId, ScientSourcesJoinDifferences } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { JoinDifferencesDialog } from "./JoinDifferences";

const mocks = vi.hoisted(() => ({ read: vi.fn(), organize: vi.fn() }));
vi.mock("./client", () => ({
  readScientSourceRecentChanges: mocks.read,
  organizeScientSources: mocks.organize,
}));

const environmentId = "environment-1" as EnvironmentId;
const side = (
  overrides: Partial<NonNullable<ScientSourcesJoinDifferences["rows"][number]["here"]>>,
) => ({
  sourceId: "source_sleep",
  title: "Sleep and memory",
  by: "Lovelace 2026",
  fingerprint: "fingerprint-here",
  note: "",
  tags: [],
  read: false,
  starred: false,
  pdfs: [],
  ...overrides,
});
const listed: ScientSourcesJoinDifferences = {
  joinId: "join_1",
  from: "backup",
  backupCreatedAt: "2026-11-14T07:00:00.000Z",
  folder: "/Users/ada/Backups/Scient Library backup 2026-11-14 0700",
  available: true,
  total: 3,
  nextOffset: null,
  rows: [
    {
      otherSourceId: "source_sleep",
      relation: "same-id",
      parts: ["details", "note", "pdfs"],
      here: side({ note: "My own note." }),
      candidates: [],
      other: side({
        fingerprint: "fingerprint-other",
        title: "Sleep and memory consolidation",
        note: "Written on the laptop.",
        pdfs: [
          { sha256: "a".repeat(64), fileName: "sleep.pdf", available: true },
          { sha256: "b".repeat(64), fileName: "supplement.pdf", available: false },
        ],
      }),
      otherTitle: "Sleep and memory consolidation",
      details: [
        { field: "Title", here: "Sleep and memory", other: "Sleep and memory consolidation" },
      ],
    },
    {
      otherSourceId: "source_alike",
      relation: "possibly-same",
      parts: [],
      here: side({ sourceId: "source_mine", title: "Soil carbon budgets", fingerprint: "f-mine" }),
      candidates: [],
      other: side({
        sourceId: "source_alike",
        title: "Soil carbon budgets",
        fingerprint: "f-alike",
      }),
      otherTitle: "Soil carbon budgets",
      details: [],
    },
  ],
  removedHere: [{ otherSourceId: "source_gone", state: "deleted", title: "A paper deleted here" }],
};

function setup(answer: ScientSourcesJoinDifferences = listed) {
  mocks.read.mockReset().mockResolvedValue({ changes: [], more: false, joinDifferences: answer });
  mocks.organize.mockReset().mockResolvedValue({ outcome: "taken" });
  return { onChanged: vi.fn(async () => undefined), onClose: vi.fn() };
}

const dialog = (handlers: ReturnType<typeof setup>, canChange = true) => (
  <JoinDifferencesDialog
    environmentId={environmentId}
    root="/project"
    joinId="join_1"
    canChange={canChange}
    {...handlers}
  />
);

describe("the papers both Libraries have", () => {
  it("shows both sides of each paper and takes one thing with what the row showed", async () => {
    const handlers = setup();
    await using _screen = await render(dialog(handlers), { router: false });

    await expect.element(page.getByText("My own note.")).toBeVisible();
    expect(mocks.read).toHaveBeenCalledWith(environmentId, {
      root: "/project",
      differencesOfJoin: { joinId: "join_1", offset: 0 },
    });
    await expect.element(page.getByText("Lovelace 2026 · Saved in both Libraries")).toBeVisible();
    await expect.element(page.getByText("Written on the laptop.")).toBeVisible();
    await expect.element(page.getByText("Sleep and memory consolidation")).toBeVisible();
    // A PDF whose file is not in the backup folder is named, and cannot be attached.
    await expect
      .element(page.getByText("supplement.pdf (the file is not in that folder)"))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^Attach supplement\.pdf/u }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("A paper deleted here · deleted here")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Add to my note: Sleep and memory" }));
    await vi.waitFor(() => expect(mocks.organize).toHaveBeenCalledTimes(1));
    expect(mocks.organize).toHaveBeenCalledWith(environmentId, {
      root: "/project",
      change: {
        action: "take-from-library",
        joinId: "join_1",
        otherSourceId: "source_sleep",
        take: { kind: "note" },
        shown: { here: "fingerprint-here", other: "fingerprint-other" },
        operationId: expect.stringMatching(/^take_/u),
      },
    });
    // The paper changed: the panel's list and this list are read again.
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    expect(handlers.onChanged).toHaveBeenCalledTimes(1);

    await userEvent.click(page.getByRole("button", { name: "Attach sleep.pdf: Sleep and memory" }));
    await vi.waitFor(() =>
      expect(mocks.organize).toHaveBeenLastCalledWith(
        environmentId,
        expect.objectContaining({
          change: expect.objectContaining({ take: { kind: "pdf", sha256: "a".repeat(64) } }),
        }),
      ),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Add separately: Soil carbon budgets" }),
    );
    await vi.waitFor(() =>
      expect(mocks.organize).toHaveBeenLastCalledWith(
        environmentId,
        expect.objectContaining({
          change: expect.objectContaining({
            otherSourceId: "source_alike",
            take: { kind: "add-separately" },
            shown: { here: "f-mine", other: "f-alike" },
          }),
        }),
      ),
    );
  });

  it("says when nothing was done because a paper changed, and shows the list as it is now", async () => {
    const handlers = setup();
    mocks.organize.mockResolvedValue({ outcome: "take-changed" });
    await using _screen = await render(dialog(handlers), { router: false });
    await userEvent.click(page.getByRole("button", { name: "Add to my note: Sleep and memory" }));
    await expect
      .element(
        page.getByText(
          "One of the two papers changed since this list was shown, so nothing was done. The list is up to date now.",
        ),
      )
      .toBeVisible();
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("shows what was recorded, without actions, while the other Library's folder is away or to a reader", async () => {
    const away: ScientSourcesJoinDifferences = {
      ...listed,
      available: false,
      rows: listed.rows.map((row) => ({ ...row, other: null, details: [] })),
    };
    const handlers = setup(away);
    await using screen = await render(dialog(handlers), { router: false });
    await expect
      .element(page.getByText("The other Library's folder is not there now", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByText("The other Library has more: details, a note, PDFs."))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^Add to my note/u }))
      .not.toBeInTheDocument();
    await screen.unmount();

    // A session that may only read sees both sides and no actions.
    const reader = setup();
    await using _again = await render(dialog(reader, false), { router: false });
    await expect.element(page.getByText("Written on the laptop.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^Add to my note/u }))
      .not.toBeInTheDocument();
  });
});
