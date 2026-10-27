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
  listOverleafUndoableSends: vi.fn(),
  undoOverleafSend: vi.fn(),
}));
vi.mock("./client", () => ({ ...client, overleafRequestId: () => "request-1" }));
const project = vi.hoisted(() => ({ createProjectForOverleaf: vi.fn() }));
vi.mock("./createProjectForOverleaf", () => project);
const openNewThread = vi.hoisted(() => vi.fn());
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => openNewThread }));
const projection = vi.hoisted(() => ({ waitForProjectProjection: vi.fn() }));
vi.mock("~/lib/projectProjection", () => projection);
const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("~/components/ui/toast", async (original) => ({
  ...(await original<typeof import("~/components/ui/toast")>()),
  toastManager: { add: toastAdd, close: vi.fn(), update: vi.fn() },
}));

const { OverleafNewProjectDialogHost, insertOverleafAddProjectItem, overleafAddProjectItem } =
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
  for (const mock of [
    ...Object.values(client),
    project.createProjectForOverleaf,
    openNewThread,
    projection.waitForProjectProjection,
    toastAdd,
  ]) {
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
  projection.waitForProjectProjection.mockResolvedValue(true);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Fills the form and connects; the token field only when asked. */
async function fillAndConnect(token?: string) {
  await page.getByLabelText("Overleaf project").fill(ID);
  await page.getByLabelText("Project name").fill("Thesis");
  await page.getByRole("button", { name: "Change…" }).click();
  await page.getByLabelText("Paper folder").fill("paper");
  if (token !== undefined) await page.getByLabelText("Overleaf Git token").fill(token);
  await page.getByRole("button", { name: "Add", exact: true }).click();
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
  it("sits right after GitHub in the sources, or after Git URL without GitHub", () => {
    const env = EnvironmentId.make("local");
    const values = (sources: Array<{ readonly value: string }>) =>
      sources.map((item) => item.value.replace(`action:add-project:${env}:`, ""));
    const input = { environmentId: env, location: "~/", isPrimary: false };
    const withGithub = ["new", "browse", "url", "github", "gitlab:not-ready"].map((source) => ({
      value: `action:add-project:${env}:${source}`,
    }));
    insertOverleafAddProjectItem(withGithub, input);
    expect(values(withGithub)).toEqual([
      "new",
      "browse",
      "url",
      "github",
      "overleaf",
      "gitlab:not-ready",
    ]);
    const withoutGithub = ["browse", "url", "gitlab"].map((source) => ({
      value: `action:add-project:${env}:${source}`,
    }));
    insertOverleafAddProjectItem(withoutGithub, input);
    expect(values(withoutGithub)).toEqual(["browse", "url", "overleaf", "gitlab"]);
  });

  it("makes the Scient project, then brings the paper in as a subfolder and syncs it", async () => {
    reset(false);
    client.connectOverleaf.mockResolvedValue({ _tag: "done", connection: summary });
    await using _screen = await render(<OverleafNewProjectDialogHost />);
    await chooseOverleafProject();

    await expect.element(page.getByRole("dialog", { name: "Add Overleaf project" })).toBeVisible();
    await expect.element(page.getByLabelText("Paper folder")).toBeVisible();
    await expect.element(page.getByLabelText("Paper folder")).toHaveValue("");
    await expect.element(page.getByText("Goes in")).not.toBeInTheDocument();
    await page.getByLabelText("Project name").fill("Thesis");
    await expect.element(page.getByLabelText("Paper folder")).toHaveValue("Thesis");
    await expect.element(page.getByText("~/Projects/Thesis/Thesis", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Change…" }).click();
    await expect.element(page.getByLabelText("Location")).toHaveValue("~/Projects/");
    // An explicitly edited folder name survives later changes to the project name.
    await page.getByLabelText("Paper folder").fill("paper");
    await page.getByLabelText("Project name").fill("Renamed");
    await expect.element(page.getByLabelText("Paper folder")).toHaveValue("paper");
    await page.getByLabelText("Project name").fill("Thesis");
    await expect.element(page.getByText("~/Projects/Thesis/paper")).toBeVisible();
    // Linking a whole folder makes no sense for a project that doesn't exist yet.
    await expect
      .element(page.getByRole("radio", { name: "Bring it in as a new folder" }))
      .not.toBeInTheDocument();

    await page.getByLabelText("Overleaf project").fill(`https://www.overleaf.com/project/${ID}`);
    await page.getByLabelText("Project name").fill("Thesis");
    await page.getByLabelText("Overleaf Git token").fill("olp_secret");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "2 files came in" }),
    );
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

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    // The successful first sync lands in the new project without another click.
    expect(openNewThread).toHaveBeenCalledExactlyOnceWith(projectRef);
  });

  it("submits on the first Add with an editable folder derived from the project name", async () => {
    reset(true);
    client.connectOverleaf.mockResolvedValue({
      _tag: "done",
      connection: { ...summary, folder: "My thesis" },
    });
    await using _screen = await render(<OverleafNewProjectDialogHost />);
    await chooseOverleafProject();
    await expect.element(page.getByLabelText("Paper folder")).toBeVisible();
    await page.getByLabelText("Overleaf project").fill(ID);
    await page.getByLabelText("Project name").fill("My thesis");
    await expect.element(page.getByLabelText("Paper folder")).toHaveValue("My thesis");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await vi.waitFor(() => expect(client.syncOverleaf).toHaveBeenCalledOnce());
    expect(client.connectOverleaf).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({ folder: "My thesis", create: true }),
    );
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
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
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.element(page.getByText("Name the project.")).toBeVisible();
    expect(project.createProjectForOverleaf).not.toHaveBeenCalled();

    // Making the project fails: nothing was made, and Overleaf isn't asked.
    await page.getByLabelText("Project name").fill("Thesis");
    await page.getByRole("button", { name: "Change…" }).click();
    await page.getByLabelText("Paper folder").fill("paper");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect
      .element(page.getByText("The project wasn't made: Permission denied"))
      .toBeVisible();
    expect(client.connectOverleaf).not.toHaveBeenCalled();

    // Made, then refused: the message says the project stays and the link is still to make.
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "The project is made, but Overleaf isn't linked yet. Overleaf has no project with this link that your account can open. Check the link, and that the project is shared with you.",
      );
    await expect.element(page.getByLabelText("Project name")).toBeDisabled();
    await expect.element(page.getByLabelText("Location")).toBeDisabled();

    // Trying again links into the same project; it is never made twice.
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
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
    await page.getByRole("button", { name: "Change…" }).click();
    await page.getByLabelText("Paper folder").fill("paper");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.element(page.getByText(/Overleaf refused access/u)).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(openNewThread).toHaveBeenCalledExactlyOnceWith(projectRef);
    expect(client.syncOverleaf).not.toHaveBeenCalled();
  });

  it("success opens a project that reached the sidebar late, and says where it is when it hasn't", async () => {
    reset(true);
    client.connectOverleaf.mockResolvedValue({ _tag: "done", connection: summary });
    // The project's 5 s wait for the sidebar ran out while it was made.
    project.createProjectForOverleaf.mockResolvedValue({
      projectRef,
      cwd: ROOT,
      created: true,
      ready: false,
    });
    const late = deferred<boolean>();
    projection.waitForProjectProjection.mockReturnValueOnce(late.promise);
    await using _screen = await render(<OverleafNewProjectDialogHost />);
    await chooseOverleafProject();
    await fillAndConnect();
    // Success waits for the project again, and opens it once it is there.
    await vi.waitFor(() =>
      expect(projection.waitForProjectProjection).toHaveBeenCalledExactlyOnceWith(projectRef),
    );
    expect(openNewThread).not.toHaveBeenCalled();
    late.resolve(true);
    await vi.waitFor(() => expect(openNewThread).toHaveBeenCalledExactlyOnceWith(projectRef));
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "2 files came in" }),
    );

    // Still not there: it says so, and where the project is, instead of doing nothing.
    projection.waitForProjectProjection.mockResolvedValueOnce(false);
    await chooseOverleafProject();
    await fillAndConnect();
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "The project is made but not in the sidebar yet",
          description: expect.stringContaining(ROOT),
        }),
      ),
    );
    expect(openNewThread).toHaveBeenCalledOnce();
  });

  it("waits for the token's status, and makes nothing until a needed token is saved", async () => {
    reset(false);
    const tokenStatus = deferred<{ saved: boolean }>();
    client.readOverleafToken.mockReturnValue(tokenStatus.promise);
    client.saveOverleafToken.mockResolvedValueOnce({ saved: false });
    client.connectOverleaf.mockResolvedValue({ _tag: "done", connection: summary });
    await using _screen = await render(<OverleafNewProjectDialogHost />);
    await chooseOverleafProject();

    // While the token's status is unknown, Connect can't make the project.
    await page.getByLabelText("Overleaf project").fill(ID);
    await page.getByLabelText("Project name").fill("Thesis");
    await expect.element(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
    tokenStatus.resolve({ saved: false });
    await expect.element(page.getByLabelText("Overleaf Git token")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add", exact: true })).toBeEnabled();

    // A token the server didn't save stops before anything is made.
    await page.getByRole("button", { name: "Change…" }).click();
    await page.getByLabelText("Paper folder").fill("paper");
    await page.getByLabelText("Overleaf Git token").fill("olp_secret");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.element(page.getByText("The token wasn't saved. Try again.")).toBeVisible();
    expect(project.createProjectForOverleaf).not.toHaveBeenCalled();
    expect(client.connectOverleaf).not.toHaveBeenCalled();

    await page.getByLabelText("Overleaf Git token").fill("olp_secret");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(client.saveOverleafToken).toHaveBeenCalledTimes(2);
    expect(client.saveOverleafToken.mock.invocationCallOrder[1]).toBeLessThan(
      project.createProjectForOverleaf.mock.invocationCallOrder[0]!,
    );
  });
});
