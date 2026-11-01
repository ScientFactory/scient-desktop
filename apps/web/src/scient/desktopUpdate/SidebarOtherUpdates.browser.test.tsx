import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import type { OtherUpdateRow } from "./otherUpdates.logic";
import { SidebarOtherUpdates } from "./SidebarOtherUpdates";

const lab = vi.hoisted(() => ({
  rows: [] as OtherUpdateRow[],
  update: vi.fn(),
  retry: vi.fn(),
  forget: vi.fn(),
}));
vi.mock("./useOtherUpdates", () => ({
  useOtherUpdates: () => ({
    rows: lab.rows,
    circle: "failed",
    update: lab.update,
    retry: lab.retry,
    forget: lab.forget,
    stoppedThreads: () => 0,
    busy: () => false,
  }),
  confirmServerStops: () => ({ admitServer: () => true }),
}));
vi.mock("~/components/sidebar/updateEverythingRun", () => ({
  useUpdateEverythingRun: () => null,
}));

function setup() {
  lab.update.mockReset();
  lab.retry.mockReset();
  lab.forget.mockReset();
  const environmentId = EnvironmentId.make("remote-lab");
  lab.rows = [
    {
      item: {
        kind: "provider",
        key: "provider:remote-lab:codex",
        environmentId,
        instanceId: ProviderInstanceId.make("lab-codex"),
        driver: ProviderDriverKind.make("codex"),
        name: "Codex",
        machine: "Lab",
        fromVersion: "1",
        toVersion: "2",
      },
      state: { status: "idle" },
    },
    {
      item: {
        kind: "managed",
        key: "managed:remote-lab:cursor",
        environmentId,
        name: "Cursor",
        machine: "Lab",
        fromVersion: "1",
        toVersion: "2",
        target: {
          environmentId,
          environmentLabel: "Lab",
          instanceId: ProviderInstanceId.make("lab-cursor"),
          driver: ProviderDriverKind.make("cursor"),
          availableVersion: "2",
        },
      },
      state: { status: "failed", reason: "Download interrupted", retry: true },
    },
  ];
}

it("retains targeted provider Settings beside native update and retry actions", async () => {
  setup();
  const updateAll = vi.fn(async () => {});
  await using screen = await render(<SidebarOtherUpdates servers={[]} updateAll={updateAll} />);
  await screen.getByRole("button", { name: "Other update failed", exact: true }).click();
  const codex = page.getByRole("link", { name: "Open Codex settings on Lab", exact: true });
  const cursor = page.getByRole("link", { name: "Open Cursor settings on Lab", exact: true });
  await expect
    .element(codex)
    .toHaveAttribute("href", "/settings/providers?environmentId=remote-lab&instanceId=lab-codex");
  await expect
    .element(cursor)
    .toHaveAttribute("href", "/settings/providers?environmentId=remote-lab&instanceId=lab-cursor");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  expect(lab.update).toHaveBeenCalledExactlyOnceWith(lab.rows[0]!.item);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  expect(lab.retry).toHaveBeenCalledExactlyOnceWith(lab.rows[1]);
  await cursor.click();
  expect(screen.router?.state.location.href).toBe(
    "/settings/providers?environmentId=remote-lab&instanceId=lab-cursor",
  );
  expect(updateAll).not.toHaveBeenCalled();
});
