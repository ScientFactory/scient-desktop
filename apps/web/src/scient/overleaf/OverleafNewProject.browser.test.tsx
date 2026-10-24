import { act, render } from "../../../test/render";
import "../../index.css";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ScientOverleafSyncResult } from "@t3tools/contracts";
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
const project = vi.hoisted(() => ({ createProjectForOverleaf: vi.fn() }));
vi.mock("./createProjectForOverleaf", () => project);
const openNewThread = vi.hoisted(() => vi.fn());
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => openNewThread }));

const { OverleafNewProjectDialogHost, overleafAddProjectItem } =
  await import("./OverleafNewProject");
const { resetOverleafStoreForTests } = await import("./overleafStore");

const environmentId = EnvironmentId.make("local");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("p1"));
const ID = "0123456789abcdef01234567";
const ROOT = "/home/me/Projects/Thesis";

const summary = {
  connectionId: "c1",
  checkoutRoot: ROOT,
  folder: "paper",
  projectId: ID,
  branch: "master" as const,
  state: "active" as const,
  completedSyncCount: 0,
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
};

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
  for (const mock of [...Object.values(client), project.createProjectForOverleaf, openNewThread]) {
    mock.mockReset();
  }
  client.readOverleafToken.mockResolvedValue({ saved: tokenSaved });
  client.saveOverleafToken.mockResolvedValue({ saved: true });
  client.listOverleafConnections.mockResolvedValue({ connections: [] });
  client.syncOverleaf.mockResolvedValue(firstSync);
  project.createProjectForOverleaf.mockResolvedValue({
    projectRef,
    cwd: ROOT,
    created: true,
    ready: true,
  });
  openNewThread.mockResolvedValue(null);
}

/** Chooses Add project ▸ Overleaf project, as the palette does. */
async function chooseOverleafProject() {
  const item = overleafAddProjectItem({
    environmentId,
    location: "~/Projects/",
    isPrimary: true,
  });
  expect(item.title).toBe("Overleaf project");
  expect(item.value).toBe("action:add-project:local:overleaf");
  // The palette closes when the entry runs: the dialog stands on its own.
  expect(item.keepOpen).toBeUndefined();
  await act(() => item.run());
}

describe("Add project ▸ Overleaf project", () => {
  it("makes the Scient project, then brings the paper in as a subfolder and syncs it", async () => {
    reset(false);
    client.connectOverleaf.mockResolvedValue({ _tag: "done", connection: summary });
    await using _screen = await render(<OverleafNewProjectDialogHost />);
    await chooseOverleafProject();

    await expect.element(page.getByRole("dialog", { name: "Add Overleaf project" })).toBeVisible();
    // Where Add project browses from; the paper's folder is named as "Bring it in as a new folder" names it.
    await expect.element(page.getByLabelText("Location")).toHaveValue("~/Projects/");
    await expect.element(page.getByLabelText("Paper folder")).toHaveValue("paper");
    // Linking a whole folder makes no sense for a project that doesn't exist yet.
    await expect
      .element(page.getByRole("radio", { name: "Bring it in as a new folder" }))
      .not.toBeInTheDocument();

    await page.getByLabelText("Overleaf project").fill(`https://www.overleaf.com/project/${ID}`);
    await page.getByLabelText("Project name").fill("Thesis");
    await page.getByLabelText("Overleaf Git token").fill("olp_secret");
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    await expect.element(page.getByText("2 files came in")).toBeVisible();
    await expect.element(page.getByText("Linked Thesis/paper.")).toBeVisible();
    expect(project.createProjectForOverleaf).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      root: "~/Projects/Thesis",
    });
    // The paper goes in a subfolder of the new project, never at its top.
    expect(client.connectOverleaf).toHaveBeenCalledExactlyOnceWith(environmentId, {
      workspaceRoot: ROOT,
      folder: "paper",
      create: true,
      project: ID,
      requestId: "request-1",
    });
    expect(client.syncOverleaf).toHaveBeenCalledExactlyOnceWith(environmentId, {
      workspaceRoot: ROOT,
      connectionId: "c1",
      requestId: "request-1",
    });
    // A token Overleaf would refuse is saved before anything is made.
    expect(client.saveOverleafToken.mock.invocationCallOrder[0]).toBeLessThan(
      project.createProjectForOverleaf.mock.invocationCallOrder[0]!,
    );
    expect(project.createProjectForOverleaf.mock.invocationCallOrder[0]).toBeLessThan(
      client.connectOverleaf.mock.invocationCallOrder[0]!,
    );

    await page.getByRole("button", { name: "Done" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    // Done lands in the new project.
    expect(openNewThread).toHaveBeenCalledExactlyOnceWith(projectRef);
  });

  it("says plainly when the link is refused after the project is made, and keeps the project", async () => {
    reset(true);
    project.createProjectForOverleaf.mockRejectedValueOnce(new Error("Permission denied"));
    client.connectOverleaf
      .mockResolvedValueOnce({ _tag: "refused", reason: "project-not-found" })
      .mockResolvedValueOnce({ _tag: "done", connection: summary });
    await using _screen = await render(<OverleafNewProjectDialogHost />);
    await chooseOverleafProject();

    await page.getByLabelText("Overleaf project").fill(ID);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.element(page.getByText("Name the project.")).toBeVisible();
    expect(project.createProjectForOverleaf).not.toHaveBeenCalled();

    // Making the project fails: nothing was made, and Overleaf isn't asked.
    await page.getByLabelText("Project name").fill("Thesis");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect
      .element(page.getByText("The project wasn't made: Permission denied"))
      .toBeVisible();
    expect(client.connectOverleaf).not.toHaveBeenCalled();

    // Made, then refused: the message says the project stays and the link is still to make.
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "The project is made, but Overleaf isn't linked yet. Overleaf has no such project.",
      );
    await expect.element(page.getByLabelText("Project name")).toBeDisabled();
    await expect.element(page.getByLabelText("Location")).toBeDisabled();

    // Trying again links into the same project; it is never made twice.
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.element(page.getByText("Linked Thesis/paper.")).toBeVisible();
    expect(project.createProjectForOverleaf).toHaveBeenCalledTimes(2);
    expect(client.connectOverleaf).toHaveBeenCalledTimes(2);
    expect(client.connectOverleaf).toHaveBeenLastCalledWith(
      environmentId,
      expect.objectContaining({ workspaceRoot: ROOT, folder: "paper", create: true }),
    );
  });

  it("lands in a made project even when the person gives up on the link", async () => {
    reset(true);
    client.connectOverleaf.mockResolvedValue({ _tag: "refused", reason: "access-denied" });
    await using _screen = await render(<OverleafNewProjectDialogHost />);
    await chooseOverleafProject();

    await page.getByLabelText("Overleaf project").fill(ID);
    await page.getByLabelText("Project name").fill("Thesis");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.element(page.getByText(/Overleaf refused the token/u)).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(openNewThread).toHaveBeenCalledExactlyOnceWith(projectRef);
    expect(client.syncOverleaf).not.toHaveBeenCalled();
  });
});
