import { render } from "../../../test/render";
import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

const client = vi.hoisted(() => ({
  readOverleafToken: vi.fn(),
  saveOverleafToken: vi.fn(),
  removeOverleafToken: vi.fn(),
  connectOverleaf: vi.fn(),
  syncOverleaf: vi.fn(),
  previewOverleaf: vi.fn(),
  listOverleafConnections: vi.fn(),
  readOverleafStatus: vi.fn(),
  listOverleafKeptCopies: vi.fn(),
  restoreOverleafKeptCopy: vi.fn(),
  disconnectOverleaf: vi.fn(),
}));
vi.mock("./client", () => ({ ...client, overleafRequestId: () => "request-1" }));
const toasts = vi.hoisted(() => ({ add: vi.fn(() => "toast"), close: vi.fn() }));
vi.mock("~/components/ui/toast", () => ({ toastManager: toasts }));
// Only the Overleaf rows are under test, not the settings scope stores.
vi.mock("~/components/settings/settingsLayout", () => ({
  SettingsSection: (props: { title: ReactNode; children: ReactNode }) => (
    <section aria-label={typeof props.title === "string" ? props.title : undefined}>
      <h2>{props.title}</h2>
      {props.children}
    </section>
  ),
}));
const projects = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("~/state/entities", () => ({ useProjects: () => projects.list }));

const { OverleafProjectSettingsSection, OverleafSourceControlRow } =
  await import("./OverleafSettings");
const { resetOverleafStoreForTests } = await import("./overleafStore");

const environmentId = EnvironmentId.make("local");
const ID = "0123456789abcdef01234567";

const link = (connectionId: string, folder: string, root = "/work/project") => ({
  connectionId,
  checkoutRoot: root,
  folder,
  projectId: ID,
  branch: "master" as const,
  state: "active" as const,
  completedSyncCount: 0,
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
  linkedHere: true,
});

function reset(tokenSaved: boolean) {
  resetOverleafStoreForTests();
  for (const mock of Object.values(client)) mock.mockReset();
  toasts.add.mockClear();
  client.readOverleafToken.mockResolvedValue({ saved: tokenSaved });
  client.readOverleafStatus.mockRejectedValue(new Error("offline"));
  projects.list = [];
}

describe("Settings ▸ Source Control ▸ Overleaf", () => {
  it("saves and removes the token, and lists every project's linked folders", async () => {
    reset(false);
    projects.list = [
      { environmentId, id: "p1", title: "Thesis", workspaceRoot: "/work/thesis" },
      { environmentId, id: "p2", title: "Grant", workspaceRoot: "/work/grant" },
      {
        environmentId: EnvironmentId.make("remote"),
        id: "p3",
        title: "Elsewhere",
        workspaceRoot: "/r",
      },
    ];
    client.listOverleafConnections.mockImplementation(async (_environment, root: string) => ({
      connections: root === "/work/thesis" ? [link("c1", "paper", root)] : [],
    }));
    client.saveOverleafToken.mockResolvedValue({ saved: true });
    client.removeOverleafToken.mockResolvedValue({ saved: false });
    await using _screen = await render(<OverleafSourceControlRow environmentId={environmentId} />);

    await expect.element(page.getByText("No token")).toBeVisible();
    await page.getByRole("button", { name: "Toggle Overleaf details" }).click();
    await expect
      .element(page.getByRole("link", { name: "Create a token on Overleaf" }))
      .toBeVisible();
    await page.getByLabelText("Git token").fill("olp_secret");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.element(page.getByText("Token saved")).toBeVisible();
    expect(client.saveOverleafToken).toHaveBeenCalledExactlyOnceWith(environmentId, "olp_secret");

    // Each project of this environment is asked for its links; only Thesis has one.
    await expect.element(page.getByText("paper")).toBeVisible();
    expect(client.listOverleafConnections.mock.calls.map((call) => call[1]).toSorted()).toEqual([
      "/work/grant",
      "/work/thesis",
    ]);

    await page.getByRole("button", { name: "Remove" }).click();
    await expect.element(page.getByText("No token")).toBeVisible();
    expect(client.removeOverleafToken).toHaveBeenCalledOnce();
  });
});

describe("Project Settings ▸ Overleaf", () => {
  it("shows this project's links with Sync now, Open in Overleaf and Unlink", async () => {
    reset(true);
    let links = [link("c1", "paper"), link("c2", "slides")];
    client.listOverleafConnections.mockImplementation(async () => ({ connections: links }));
    client.disconnectOverleaf.mockImplementation(async () => {
      links = links.filter((entry) => entry.connectionId !== "c2");
      return { _tag: "done", connection: link("c2", "slides") };
    });
    await using _screen = await render(
      <OverleafProjectSettingsSection
        environmentId={environmentId}
        workspaceRoot="/work/project"
      />,
    );
    const slides = page.getByRole("listitem").filter({ hasText: "slides" });
    await expect.element(slides.getByRole("button", { name: "Sync now" })).toBeVisible();
    await expect.element(slides.getByRole("button", { name: "Open in Overleaf" })).toBeVisible();
    await expect.element(slides.getByText(/Not synced yet/u)).toBeVisible();
    await slides.getByRole("button", { name: "Unlink" }).click();

    await expect.element(page.getByText("slides")).not.toBeInTheDocument();
    expect(client.disconnectOverleaf).toHaveBeenCalledExactlyOnceWith(environmentId, {
      workspaceRoot: "/work/project",
      connectionId: "c2",
      requestId: "request-1",
    });
    await expect.element(page.getByText("paper")).toBeVisible();
  });

  it("links a typed folder, or brings a project in at the project's top", async () => {
    reset(true);
    client.listOverleafConnections.mockResolvedValue({ connections: [] });
    client.connectOverleaf.mockResolvedValue({ _tag: "refused", reason: "folder-missing" });
    await using _screen = await render(
      <OverleafProjectSettingsSection
        environmentId={environmentId}
        workspaceRoot="/work/project"
      />,
    );
    await expect.element(page.getByText("No folder is linked.")).toBeVisible();

    await page.getByRole("button", { name: "Link a folder…" }).click();
    await page.getByLabelText("Overleaf project").fill(ID);
    await page.getByLabelText("Folder to link").fill("chapters/thesis/");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect
      .element(page.getByText("The folder isn't there, or its disk isn't connected."))
      .toBeVisible();
    expect(client.connectOverleaf).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      expect.objectContaining({ folder: "chapters/thesis", create: false }),
    );
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Bring in an Overleaf project…" }).click();
    await expect.element(page.getByLabelText("Folder name")).toHaveValue("paper");
    await page.getByLabelText("Overleaf project").fill(ID);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.poll(() => client.connectOverleaf.mock.calls.length).toBe(2);
    expect(client.connectOverleaf.mock.calls[1]).toEqual([
      environmentId,
      expect.objectContaining({ folder: "paper", create: true }),
    ]);
  });
});
