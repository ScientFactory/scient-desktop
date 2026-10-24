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
}));
vi.mock("./client", () => ({ ...client, overleafRequestId: () => "request-1" }));

const { ConnectOverleafDialog } = await import("./ConnectOverleafDialog");
const { resetOverleafStoreForTests } = await import("./overleafStore");

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
    collisions: [],
    selectedAdditions: [],
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
  for (const mock of Object.values(client)) mock.mockReset();
  client.readOverleafToken.mockResolvedValue({ saved: tokenSaved });
  client.saveOverleafToken.mockResolvedValue({ saved: true });
  client.listOverleafConnections.mockResolvedValue({ connections: [] });
  client.syncOverleaf.mockResolvedValue(firstSync);
}

describe("ConnectOverleafDialog", () => {
  it("brings a project in as a new folder inside the selected one, saving the token first", async () => {
    reset(false);
    client.connectOverleaf.mockResolvedValue({
      _tag: "done",
      connection: summary("papers/paper"),
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
    // New folder is the default, named "paper" inside the selected folder.
    await expect.element(page.getByLabelText("Folder name")).toHaveValue("paper");

    await page.getByLabelText("Overleaf project").fill(`https://www.overleaf.com/project/${ID}`);
    await page.getByLabelText("Overleaf Git token").fill("olp_secret");
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    await expect.element(page.getByText("2 files came in")).toBeVisible();
    expect(client.saveOverleafToken).toHaveBeenCalledExactlyOnceWith(environmentId, "olp_secret");
    expect(client.connectOverleaf).toHaveBeenCalledExactlyOnceWith(environmentId, {
      workspaceRoot: "/work/project",
      folder: "papers/paper",
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
    await page.getByRole("button", { name: "Done" }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("links the selected folder as it is, without asking for a saved token again", async () => {
    reset(true);
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
    await page.getByLabelText("Overleaf project").fill(ID);
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    await expect.element(page.getByText("Linked thesis.")).toBeVisible();
    expect(client.saveOverleafToken).not.toHaveBeenCalled();
    expect(client.connectOverleaf).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      expect.objectContaining({ folder: "thesis", create: false, project: ID }),
    );
  });

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
