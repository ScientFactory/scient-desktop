import { render } from "../../../test/render";
import "../../index.css";

import { EnvironmentId, type ScientOverleafSyncResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

const client = vi.hoisted(() => ({
  readOverleafToken: vi.fn(),
  saveOverleafToken: vi.fn(),
  connectOverleaf: vi.fn(),
  syncOverleaf: vi.fn(),
  listOverleafConnections: vi.fn(),
  readOverleafStatus: vi.fn(),
  previewOverleaf: vi.fn(),
  removeOverleafToken: vi.fn(),
  listOverleafKeptCopies: vi.fn(),
  restoreOverleafKeptCopy: vi.fn(),
  disconnectOverleaf: vi.fn(),
  cancelOverleafSync: vi.fn(),
  listOverleafUndoableSends: vi.fn(),
  undoOverleafSend: vi.fn(),
}));
vi.mock("./client", () => ({ ...client, overleafRequestId: () => "request-1" }));

// The folders of the workspace the picker suggests.
const folders = vi.hoisted(() => ({
  entries: [] as Array<{ path: string; kind: "directory" }>,
}));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: ({ query }: { query: string | null }) => {
    const searched = (query ?? "").trim().toLowerCase();
    return {
      entries: folders.entries.filter(
        (entry) => searched === "" || entry.path.toLowerCase().includes(searched),
      ),
      error: null,
      isPending: false,
      searchedQuery: searched,
      truncated: false,
      refresh: vi.fn(),
    };
  },
}));

const toasts = vi.hoisted(() => ({ add: vi.fn(), close: vi.fn() }));
vi.mock("~/components/ui/toast", () => ({ toastManager: toasts }));

const { ConnectOverleafDialog } = await import("./ConnectOverleafDialog");
const { readOverleafWorkspace, resetOverleafStoreForTests, setOverleafFileDecision } =
  await import("./overleafStore");

const environmentId = EnvironmentId.make("local");
const ID = "0123456789abcdef01234567";

const summary = (folder: string) => ({
  connectionId: "c1",
  checkoutRoot: "/work/project",
  folder,
  projectId: ID,
  branch: "master" as const,
  state: "active" as const,
  completedSyncCount: 0,
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
});

const firstSync: ScientOverleafSyncResult = {
  _tag: "synced",
  settled: null,
  review: {
    reviewId: "r1",
    digest: "d1",
    remoteTree: "a".repeat(40),
    upToDate: false,
    needsDecision: false,
    incoming: [
      { kind: "added", path: "main.tex" },
      { kind: "added", path: "refs.bib" },
    ],
    outgoing: [],
    conflicts: [],
    warnings: [{ kind: "first-sync" }],
    unresolvedMarkers: [],
    heldWithMarked: [],
    released: [],
    collisions: [],
    selectedAdditions: [],
    additions: [],
    localOnly: [],
  },
  outcome: "complete",
  interrupted: 0,
  markerPaths: [],
  publication: { _tag: "none" },
  retried: false,
  activity: [],
  linkedElsewhere: false,
};

function reset(tokenSaved: boolean) {
  resetOverleafStoreForTests();
  toasts.add.mockReset();
  for (const mock of Object.values(client)) mock.mockReset();
  client.readOverleafToken.mockResolvedValue({ saved: tokenSaved });
  client.saveOverleafToken.mockResolvedValue({ saved: true });
  client.listOverleafConnections.mockResolvedValue({ connections: [] });
  client.syncOverleaf.mockResolvedValue(firstSync);
  folders.entries = [
    { path: "papers", kind: "directory" },
    { path: "thesis", kind: "directory" },
    { path: "archive/2024", kind: "directory" },
  ];
}

describe("ConnectOverleafDialog", () => {
  it("brings a project in as a new folder inside the selected one, saving the token first", async () => {
    reset(false);
    client.connectOverleaf.mockResolvedValue({
      _tag: "done",
      connection: summary("archive/2024/paper"),
    });
    const onClose = vi.fn();
    await using _screen = await render(
      <ConnectOverleafDialog
        environmentId={environmentId}
        cwd="/work/project"
        folder="papers"
        onClose={onClose}
      />,
    );

    // No token saved: the field and the link to Overleaf's token page are there.
    await expect.element(page.getByLabelText("Overleaf Git token")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Create a token on Overleaf" }))
      .toHaveAttribute("href", "https://www.overleaf.com/user/settings#git-integration");
    // New folder is the default. Its name starts empty ("paper" is only the
    // placeholder), and the full path shows once it is named.
    await expect.element(page.getByLabelText("Folder name")).toHaveValue("");
    await expect
      .element(page.getByLabelText("Folder name"))
      .toHaveAttribute("placeholder", "paper");
    await expect.element(page.getByText("Goes in")).not.toBeInTheDocument();
    await page.getByLabelText("Folder name").fill("paper");
    await expect.element(page.getByText("/work/project/papers/paper")).toBeVisible();
    // Another folder of this workspace can hold it instead.
    await page.getByLabelText("Inside").fill("archive");
    await page.getByRole("option", { name: "archive/2024" }).click();
    await expect.element(page.getByText("/work/project/archive/2024/paper")).toBeVisible();

    await page.getByLabelText("Overleaf project").fill(`https://www.overleaf.com/project/${ID}`);
    await page.getByLabelText("Overleaf Git token").fill("olp_secret");
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "2 files came in" }),
    );
    expect(client.saveOverleafToken).toHaveBeenCalledExactlyOnceWith(environmentId, "olp_secret");
    expect(client.connectOverleaf).toHaveBeenCalledExactlyOnceWith(environmentId, {
      workspaceRoot: "/work/project",
      folder: "archive/2024/paper",
      create: true,
      project: ID,
      requestId: "request-1",
    });
    // The first sync runs on the new link straight away.
    expect(client.syncOverleaf).toHaveBeenCalledExactlyOnceWith(environmentId, {
      workspaceRoot: "/work/project",
      connectionId: "c1",
      requestId: "request-1",
    });
    expect(client.saveOverleafToken.mock.invocationCallOrder[0]).toBeLessThan(
      client.connectOverleaf.mock.invocationCallOrder[0]!,
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("links the selected folder as it is, without asking for a saved token again", async () => {
    reset(true);
    // A link reconnected from an archive keeps its ID; what this window remembered is stale.
    setOverleafFileDecision(environmentId, "c1", "notes.md", "send");
    // The first sync doesn't apply, so nothing else clears it.
    client.syncOverleaf.mockResolvedValue({
      _tag: "refused",
      refusal: { reason: "unreachable" },
      retried: false,
      settled: null,
    });
    client.connectOverleaf.mockResolvedValue({ _tag: "done", connection: summary("thesis") });
    await using _screen = await render(
      <ConnectOverleafDialog
        environmentId={environmentId}
        cwd="/work/project"
        folder="thesis"
        onClose={() => {}}
      />,
    );
    await expect.element(page.getByLabelText("Overleaf project")).toBeVisible();
    await expect.element(page.getByLabelText("Overleaf Git token")).not.toBeInTheDocument();

    await page.getByRole("radio", { name: "Link thesis" }).click();
    await expect.element(page.getByText("/work/project/thesis")).toBeVisible();
    await page.getByLabelText("Overleaf project").fill(ID);
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    await expect.element(page.getByText("Linked thesis.")).toBeVisible();
    expect(readOverleafWorkspace(environmentId, "/work/project").fileDecisions.has("c1")).toBe(
      false,
    );
    expect(client.saveOverleafToken).not.toHaveBeenCalled();
    expect(client.connectOverleaf).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      expect.objectContaining({ folder: "thesis", create: false, project: ID }),
    );
  });

  it.each(["project-not-found", "git-failed", "unreachable"])(
    "keeps the connect form actionable after %s and allows a corrected link to connect",
    async (reason) => {
      reset(true);
      client.connectOverleaf.mockResolvedValueOnce({ _tag: "refused", reason });
      const onClose = vi.fn();
      await using _screen = await render(
        <ConnectOverleafDialog
          environmentId={environmentId}
          cwd="/work/project"
          folder="papers"
          onClose={onClose}
        />,
      );
      await page.getByLabelText("Overleaf project").fill(ID);
      await page.getByLabelText("Folder name").fill("paper");
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      const error = page.getByRole("alert");
      await expect.element(error).toBeVisible();
      await expect.element(page.getByText(/sync again/iu)).not.toBeInTheDocument();
      if (reason === "project-not-found")
        await expect
          .element(error)
          .toHaveTextContent(
            "Overleaf has no project with this link that your account can open. Check the link, and that the project is shared with you.",
          );
      else
        await expect
          .element(error)
          .toHaveTextContent(
            reason === "git-failed"
              ? "Git failed while talking to Overleaf. Try connecting again."
              : "Overleaf couldn't be reached. Check the connection. Try connecting again.",
          );
      expect(client.syncOverleaf).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      const corrected = "fedcba9876543210fedcba98";
      await page.getByLabelText("Overleaf project").fill(corrected);
      client.connectOverleaf.mockResolvedValueOnce({
        _tag: "done",
        connection: summary("papers/paper"),
      });
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect.poll(() => onClose.mock.calls.length).toBe(1);
      expect(client.connectOverleaf).toHaveBeenLastCalledWith(
        environmentId,
        expect.objectContaining({ project: corrected }),
      );
    },
  );

  it("refuses a link that isn't Overleaf's, and shows the server's reason on the form", async () => {
    reset(true);
    client.connectOverleaf.mockResolvedValue({ _tag: "refused", reason: "folder-not-empty" });
    await using _screen = await render(
      <ConnectOverleafDialog
        environmentId={environmentId}
        cwd="/work/project"
        folder=""
        onClose={() => {}}
      />,
    );
    await page.getByLabelText("Overleaf project").fill("https://example.com/project/1");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect
      .element(page.getByText("Paste the project's link from Overleaf, or its ID."))
      .toBeVisible();
    expect(client.connectOverleaf).not.toHaveBeenCalled();

    await page.getByLabelText("Overleaf project").fill(ID);
    await page.getByLabelText("Folder name").fill("paper");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect
      .element(page.getByText(/A folder with that name already has files/u))
      .toBeVisible();
    // At the project's top, the new folder goes straight under it.
    expect(client.connectOverleaf).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({ folder: "paper", create: true }),
    );
    expect(client.syncOverleaf).not.toHaveBeenCalled();
  });
});
