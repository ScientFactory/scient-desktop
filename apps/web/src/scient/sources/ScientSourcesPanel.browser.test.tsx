import { act, render } from "../../../test/render";
import "../../index.css";

import type {
  EnvironmentId,
  ScientSourcesOverviewResult,
  ScientSourceDetailResult,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { ScientSourcesPanel } from "./ScientSourcesPanel";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  detail: vi.fn(),
  personalNote: vi.fn(),
  organize: vi.fn(),
  addByIdentifier: vi.fn(),
  fileImport: vi.fn(),
  recentChanges: vi.fn(),
  menu: vi.fn(),
  canChange: true,
  accountCommand: vi.fn(async () => undefined),
  toast: vi.fn(),
}));
vi.mock("./client", async (original) => ({
  ...(await original<typeof import("./client")>()),
  readScientSources: mocks.read,
  readScientSource: mocks.detail,
  updateScientSourcePersonalNote: mocks.personalNote,
  organizeScientSources: mocks.organize,
  addScientSourcesByIdentifier: mocks.addByIdentifier,
  importScientSourcesFile: mocks.fileImport,
  readScientSourceRecentChanges: mocks.recentChanges,
}));
vi.mock("../../localApi", async (original) => ({
  ...(await original<typeof import("../../localApi")>()),
  readLocalApi: () => ({ contextMenu: { show: mocks.menu } }),
}));
vi.mock("./sourcesCommands", async (original) => ({
  ...(await original<typeof import("./sourcesCommands")>()),
  useCanChangeLibrary: () => mocks.canChange,
  useCanRunSourcesCommand: () => mocks.canChange,
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "environment-1",
  useEnvironment: (environmentId: string) => ({
    label: environmentId === "environment-1" ? "This Mac" : "lab-server",
  }),
}));
vi.mock("../accounts/useAccounts", () => ({
  useAccounts: () => ({ data: null }),
  useAccountCommand: () => mocks.accountCommand,
}));
vi.mock("../accounts/University", () => ({ UniversityCrest: () => null }));
vi.mock("../accounts/PaperRequests", () => ({ PaperQueueBand: () => null }));
vi.mock("./useManagedBibliography", () => ({ useManagedBibliography: () => ({ status: null }) }));
vi.mock("./useLibraryMoveStatus", () => ({ useLibraryMoveStatus: () => ({ line: null }) }));
vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn() },
  anchoredToastManager: { add: vi.fn(), close: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("./ZoteroSync", () => ({ useZoteroSync: () => ({}), ZoteroRefreshDialog: () => null }));
vi.mock("./SourceReference", () => ({ SourceReference: () => null }));
vi.mock("./SourceFullTextResults", () => ({
  SourceFullTextResults: (props: { readonly query: string }) =>
    props.query ? <p>In the PDFs: {props.query}</p> : null,
}));
vi.mock("../../hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));

function setup(canChange = true, extra = false) {
  mocks.canChange = canChange;
  mocks.read.mockReset();
  mocks.detail.mockReset();
  mocks.personalNote.mockReset();
  mocks.organize.mockReset();
  mocks.menu.mockReset();
  mocks.toast.mockReset();
  let pinned = false;
  mocks.read.mockImplementation(
    async (_environment, _root, scope) =>
      ({
        projectState: "initialized",
        issues: [],
        recordDiagnostics: [],
        activeOperation: null,
        scopes: {
          listed: scope === "library" ? "library" : "project",
          project: pinned ? 1 : 0,
          library: extra ? 2 : 1,
        },
        records:
          scope === "library" || pinned
            ? [
                {
                  sourceId: "paper",
                  revision: 1,
                  type: "article",
                  title: "Existing study",
                  creators: [],
                  issuedYear: 2024,
                  identifiers: [],
                  containerTitle: null,
                  url: null,
                  externalReferences: [],
                  attachments: [],
                  importedAt: "2026-11-01T00:00:00.000Z",
                  pinned,
                  ...(pinned ? { citationKey: "Study2024" } : {}),
                },
                ...(extra && scope === "library"
                  ? [
                      {
                        sourceId: "other",
                        revision: 1,
                        type: "article" as const,
                        title: "Other study",
                        creators: [],
                        issuedYear: 2024,
                        identifiers: [],
                        containerTitle: null,
                        url: null,
                        externalReferences: [],
                        attachments: [],
                        importedAt: "2026-11-01T00:00:00.000Z",
                        pinned: false,
                      },
                    ]
                  : []),
              ]
            : [],
      }) satisfies ScientSourcesOverviewResult,
  );
  mocks.organize.mockImplementation(async (_environment, { change }) => {
    if (change.action !== "change-pins") throw new Error("Unexpected mutation");
    pinned = change.changes[0].action === "pin";
    return { outcome: "changed", pinChanges: [{ outcome: pinned ? "pinned" : "unpinned" }] };
  });
  mocks.menu.mockImplementation(async (items) => {
    const action = items.find(
      (item: { id: string; disabled?: boolean }) =>
        item.id === (pinned ? "remove-from-project" : "add-to-project"),
    );
    if (!action || action.disabled) throw new Error("Project action unavailable");
    return action.id;
  });
}

// Routing is disabled because these scope and recovery flows stay within the Library panel.
describe("Sources project scope", () => {
  it("reuses a Library paper from an empty project, including after its last source is removed", async () => {
    setup();
    await using screen = await render(
      <ScientSourcesPanel
        environmentId={"environment-1" as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        projectTitle="Test project"
        root="/project"
        onOpenPdf={() => {}}
      />,
      { router: false },
    );
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await expect
        .element(screen.getByRole("heading", { name: "No sources in this project" }))
        .toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Choose from Library" }));
      await expect.element(screen.getByRole("button", { name: /Existing study/u })).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "More source actions" }));
      await userEvent.click(screen.getByRole("button", { name: "This project", exact: true }));
      await expect.element(screen.getByRole("button", { name: /Existing study/u })).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "More source actions" }));
    }
    await expect.element(screen.getByRole("button", { name: "Choose from Library" })).toBeVisible();
  });

  it("offers Add to project on the result of a source added to the Library only", async () => {
    setup();
    mocks.addByIdentifier.mockReset();
    mocks.addByIdentifier.mockResolvedValue({
      results: [
        {
          input: "10.1000/abc.123",
          identifier: { scheme: "doi", value: "10.1000/abc.123" },
          outcome: "imported",
          sourceId: "source_new",
          title: "Measured outcomes",
          verification: "verified",
          message: null,
        },
      ],
    });
    await using screen = await render(
      <ScientSourcesPanel
        environmentId={"environment-1" as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        projectTitle="Test project"
        root="/project"
        onOpenPdf={() => {}}
      />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Choose from Library" }));
    await expect.element(screen.getByRole("button", { name: /Existing study/u })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Import sources" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Add by identifier" }));
    await page.getByRole("textbox", { name: "Identifiers to add" }).fill("10.1000/abc.123");
    await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));

    // The result slot says where it went and offers to add it here.
    const added = screen.getByRole("status").filter({ hasText: "Added 1 source" });
    await expect
      .element(added.getByText("Added 1 source. It is in your Library, not in this project."))
      .toBeVisible();
    expect(mocks.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Added 1 source" }),
    );
    expect(mocks.addByIdentifier).toHaveBeenCalledWith(
      "environment-1",
      expect.objectContaining({ pin: false }),
    );
    await userEvent.click(added.getByRole("button", { name: "Add to project" }));
    await vi.waitFor(() =>
      expect(mocks.organize).toHaveBeenCalledWith(
        "environment-1",
        expect.objectContaining({
          change: { action: "change-pins", changes: [{ action: "pin", sourceId: "source_new" }] },
        }),
      ),
    );
  });

  it("names the computer under the title only when the Library is another computer's", async () => {
    setup();
    const panel = (environmentId: string) => (
      <ScientSourcesPanel
        environmentId={environmentId as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        projectTitle="Test project"
        root="/project"
        onOpenPdf={() => {}}
      />
    );
    await using screen = await render(panel("environment-2"), { router: false });
    await expect.element(screen.getByText("On lab-server")).toBeVisible();

    await screen.rerender(panel("environment-1"));
    await expect
      .element(screen.getByRole("heading", { name: "No sources in this project" }))
      .toBeVisible();
    await expect.element(screen.getByText(/^On /u)).not.toBeInTheDocument();
  });

  it("opens Recent changes from the Library's menu and shows an import's sources", async () => {
    setup(true, true);
    mocks.recentChanges.mockReset();
    mocks.recentChanges.mockImplementation(async (_environment, input) =>
      input.sourcesOfImport
        ? { changes: [], more: false, importSourceIds: ["other"] }
        : {
            changes: [
              {
                kind: "import",
                id: "operation-1",
                at: "2026-11-14T09:00:00.000Z",
                by: "agent",
                intake: "zotero",
                outcome: "completed",
                imported: 1,
                available: 1,
                failed: 0,
              },
            ],
            more: false,
          },
    );
    await using screen = await render(
      <ScientSourcesPanel
        environmentId={"environment-1" as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        projectTitle="Test project"
        root="/project"
        onOpenPdf={() => {}}
      />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "More Library actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Recent changes" }));
    await expect.element(page.getByText("Imported 1 source from Zotero")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: /^Show sources/u }));

    // The whole Library, narrowed to what that import brought.
    await expect.element(screen.getByText("Sources from this import")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /Other study/u })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /Existing study/u }))
      .not.toBeInTheDocument();
  });

  it("shows only papers retained by package Undo, then clears that view", async () => {
    setup(true, true);
    mocks.organize.mockImplementation(async (_environment, { change }) => {
      if (change.action === "list-packages")
        return {
          outcome: "listed",
          packages: [
            {
              relativePath: "handoff",
              exportedAt: "2026-11-01T00:00:00.000Z",
            },
          ],
        };
      return {
        outcome: change.action === "undo-import" ? "undone" : "imported",
        packageReport: {
          sources: 1,
          pdfs: 0,
          annotations: 0,
          pins: 0,
          reviews: 0,
          collections: 0,
          unavailable: 0,
          importId: "import-1",
          retainedSourceIds: ["paper"],
        },
      };
    });
    await using screen = await render(
      <ScientSourcesPanel
        environmentId={"environment-1" as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        projectTitle="Test project"
        root="/project"
        onOpenPdf={() => {}}
      />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Import sources" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Import a package", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: /handoff/u }));
    await vi.waitFor(() =>
      expect(mocks.toast.mock.calls.some(([toast]) => toast.actionProps?.children === "Undo")).toBe(
        true,
      ),
    );
    await act(async () =>
      mocks.toast.mock.calls
        .find(([toast]) => toast.actionProps?.children === "Undo")![0]
        .actionProps.onClick(),
    );
    await vi.waitFor(() =>
      expect(
        mocks.toast.mock.calls.some(([toast]) => toast.actionProps?.children === "Show them"),
      ).toBe(true),
    );
    const retained = mocks.toast.mock.calls.find(
      ([toast]) => toast.actionProps?.children === "Show them",
    )![0];
    expect(retained.description).toContain("1 paper stays");
    await act(async () => retained.actionProps.onClick());
    await expect.element(screen.getByRole("button", { name: /Existing study/u })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /Other study/u }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all", exact: true }));
    await expect.element(screen.getByRole("button", { name: /Other study/u })).toBeVisible();
  });

  it("shows the papers the weekly check found a notice on, and Dismiss ends the line", async () => {
    setup(true, true);
    const read = mocks.read.getMockImplementation()!;
    let dismissed = false;
    mocks.read.mockImplementation(async (...asked) => ({
      ...(await read(...asked)),
      ...(dismissed
        ? {}
        : { noticeChanges: [{ sourceId: "other", kind: "retraction", change: "added" }] }),
    }));
    mocks.organize.mockImplementation(async (_environment, { change }) => {
      if (change.action !== "dismiss-notice-changes") throw new Error("Unexpected mutation");
      dismissed = true;
      return { outcome: "dismissed" };
    });
    await using screen = await render(
      <ScientSourcesPanel
        environmentId={"environment-1" as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        projectTitle="Test project"
        root="/project"
        onOpenPdf={() => {}}
      />,
      { router: false },
    );
    // The weekly check's line waits in Activity; Show narrows the list and closes the dialog.
    await userEvent.click(screen.getByRole("button", { name: /^Activity/u }));
    const line = page.getByText("The weekly check found: 1 paper was retracted.");
    await expect.element(line).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Show", exact: true }));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

    // The whole Library, narrowed to the paper with the notice.
    await expect.element(screen.getByRole("button", { name: /Other study/u })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /Existing study/u }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Activity/u }));
    await userEvent.click(page.getByRole("button", { name: "Dismiss", exact: true }));
    await expect.element(line).not.toBeInTheDocument();
    expect(mocks.organize).toHaveBeenCalledWith("environment-1", {
      root: "/project",
      change: { action: "dismiss-notice-changes" },
    });
  });

  it("lets a read-only empty project browse the Library", async () => {
    setup(false);
    await using screen = await render(
      <ScientSourcesPanel
        environmentId={"environment-1" as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        projectTitle="Test project"
        root="/project"
        onOpenPdf={() => {}}
      />,
      { router: false },
    );
    await expect
      .element(screen.getByRole("button", { name: "This project", exact: true }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "My Library", exact: true }));
    await expect.element(screen.getByRole("button", { name: /Existing study/u })).toBeVisible();
    expect(mocks.organize).not.toHaveBeenCalled();
  });

  it("does not show Import as busy while the list is read again", async () => {
    setup();
    const read = mocks.read.getMockImplementation()!;
    const gate = Promise.withResolvers<void>();
    mocks.read.mockImplementation(async (environment, root, scope) => {
      if (scope === "library") await gate.promise;
      return read(environment, root, scope);
    });
    await using screen = await render(
      <ScientSourcesPanel
        environmentId={"environment-1" as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        projectTitle="Test project"
        root="/project"
        onOpenPdf={() => {}}
      />,
      { router: false },
    );
    await expect
      .element(screen.getByRole("heading", { name: "No sources in this project" }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "My Library", exact: true }));
    await vi.waitFor(() =>
      expect(mocks.read).toHaveBeenCalledWith("environment-1", "/project", "library", undefined),
    );
    await expect.element(screen.getByRole("button", { name: "Import sources" })).toBeEnabled();
    gate.resolve();
    await expect.element(screen.getByRole("button", { name: /Existing study/u })).toBeVisible();
  });

  it("keeps the newest import's result when an earlier import ends after it", async () => {
    setup();
    const report = {
      format: "bibtex",
      entryCount: 1,
      importCount: 0,
      alreadyInLibrary: 1,
      remaining: 0,
      unreadableCount: 0,
      unreadable: [],
      notKept: [],
    };
    const first = Promise.withResolvers<unknown>();
    mocks.fileImport.mockReset();
    mocks.fileImport
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => ({ operation: null, report }));
    await using screen = await render(
      <ScientSourcesPanel
        environmentId={"environment-1" as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        projectTitle="Test project"
        root="/project"
        onOpenPdf={() => {}}
      />,
      { router: false },
    );
    const empty = screen.getByRole("heading", { name: "No sources in this project" });
    await expect.element(empty).toBeVisible();
    const drop = (name: string) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(["@article{a, title={A}}"], name));
      empty
        .element()
        .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    };
    drop("first.bib");
    await vi.waitFor(() => expect(mocks.fileImport).toHaveBeenCalledTimes(1));
    drop("second.bib");
    const result = screen.getByRole("status").filter({ hasText: "second.bib" });
    await expect.element(result).toBeVisible();

    await act(async () => {
      first.resolve({ operation: null, report });
      // The earlier import's answer runs through its own continuations first.
      const settled = Promise.withResolvers<void>();
      setTimeout(settled.resolve, 0);
      await settled.promise;
    });
    await expect.element(result).toBeVisible();
    await expect.element(screen.getByText(/first\.bib/u)).not.toBeInTheDocument();
  });

  it("shows full-text results under cards, also when the view cannot be saved", async () => {
    setup(true, true);
    await using screen = await render(
      <ScientSourcesPanel
        environmentId={"environment-1" as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        projectTitle="Test project"
        root="/project"
        onOpenPdf={() => {}}
      />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Choose from Library" }));
    await expect.element(screen.getByRole("button", { name: /Other study/u })).toBeVisible();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage is blocked");
    });
    try {
      await userEvent.click(screen.getByRole("button", { name: "Show as cards" }));
      await expect.element(screen.getByRole("button", { name: "Show as a list" })).toBeVisible();
    } finally {
      setItem.mockRestore();
    }
    await screen.getByRole("searchbox", { name: "Search Library" }).fill("zebra");
    await expect.element(screen.getByText("In the PDFs: zebra")).toBeVisible();
  });
});

it.each([false, true])(
  "saves My note across a deferred metadata revision (left editor: %s)",
  async (leave) => {
    setup();
    const initial: ScientSourceDetailResult = {
      formatVersion: 1,
      projectId: "project",
      sourceId: "paper",
      revision: 1,
      type: "article",
      title: "Existing study",
      creators: [],
      issuedRaw: null,
      issuedYear: 2024,
      identifiers: [],
      abstract: null,
      containerTitle: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: null,
      tags: [],
      externalReferences: [],
      attachments: [],
      fieldProvenance: [],
      importedAt: "2026-11-01T00:00:00.000Z",
      note: null,
      projectNote: null,
      personalNote: null,
      pinned: false,
    };
    let stored = initial;
    mocks.detail.mockImplementation(async () => stored);
    const gate = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    mocks.personalNote.mockImplementation(async (_environment, request) => {
      await gate.promise;
      const outcome = request.expectedNote === stored.personalNote ? "updated" : "stale";
      if (outcome === "updated")
        stored = { ...stored, revision: stored.revision + 1, personalNote: request.note };
      finished.resolve();
      return { outcome, record: stored };
    });
    await using screen = await render(
      <ScientSourcesPanel
        environmentId={"environment-1" as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        projectTitle="Test project"
        root="/project"
        onOpenPdf={() => {}}
      />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Choose from Library" }));
    await userEvent.click(screen.getByRole("button", { name: /Existing study/u }));
    await userEvent.click(page.getByRole("textbox", { name: "My note" }));
    await userEvent.keyboard("My draft");
    await userEvent.tab();
    await vi.waitFor(() => expect(mocks.personalNote).toHaveBeenCalledTimes(1));
    stored = { ...stored, revision: 2, title: "Corrected title" };
    if (leave) await userEvent.click(screen.getByRole("button", { name: /Back/u }));
    gate.resolve();
    await finished.promise;
    expect(stored).toMatchObject({
      revision: 3,
      title: "Corrected title",
      personalNote: "My draft",
    });
    if (!leave) {
      // The editor took the saved note as its own: the next edit is saved against it.
      await userEvent.click(page.getByRole("button", { name: "Edit my note" }));
      await userEvent.keyboard(", again");
      await userEvent.tab();
      await vi.waitFor(() => expect(mocks.personalNote).toHaveBeenCalledTimes(2));
      expect(mocks.personalNote.mock.calls[1]?.[1]).toMatchObject({
        expectedRevision: 3,
        expectedNote: "My draft",
        note: "My draft, again",
      });
      await mocks.personalNote.mock.results[1]?.value;
      expect(stored.personalNote).toBe("My draft, again");
      await expect.element(page.getByText("Saved elsewhere")).not.toBeInTheDocument();
    } else {
      expect(mocks.personalNote).toHaveBeenCalledTimes(1);
    }
  },
);
