import { act, render } from "../../../test/render";
import "../../index.css";

import type { EnvironmentId, ScientSourcesOverviewResult, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { ScientSourcesPanel } from "./ScientSourcesPanel";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  organize: vi.fn(),
  menu: vi.fn(),
  canChange: true,
  accountCommand: vi.fn(async () => undefined),
  toast: vi.fn(),
}));
vi.mock("./client", async (original) => ({
  ...(await original<typeof import("./client")>()),
  readScientSources: mocks.read,
  organizeScientSources: mocks.organize,
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
}));
vi.mock("../accounts/useAccounts", () => ({
  useAccounts: () => ({ data: null }),
  useAccountCommand: () => mocks.accountCommand,
}));
vi.mock("../accounts/University", () => ({
  UniversityRow: () => null,
  UniversityCrest: () => null,
}));
vi.mock("../accounts/PaperRequests", () => ({ PaperQueueBand: () => null }));
vi.mock("./useManagedBibliography", () => ({ useManagedBibliography: () => ({ status: null }) }));
vi.mock("./useLibraryMoveStatus", () => ({ useLibraryMoveStatus: () => ({ line: null }) }));
vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn() },
}));
vi.mock("./ZoteroSync", () => ({ useZoteroSync: () => ({}), ZoteroRefreshDialog: () => null }));
vi.mock("./SourceFullTextResults", () => ({ SourceFullTextResults: () => null }));
vi.mock("../../hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));

function setup(canChange = true, extra = false) {
  mocks.canChange = canChange;
  mocks.read.mockReset();
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
    await userEvent.click(screen.getByRole("button", { name: "More Library actions" }));
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
    await userEvent.click(screen.getByRole("button", { name: "All Library", exact: true }));
    await expect.element(screen.getByRole("button", { name: /Existing study/u })).toBeVisible();
    expect(mocks.organize).not.toHaveBeenCalled();
  });
});
