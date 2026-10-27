import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  EnvironmentId,
  type CliPasswordSource,
  type CliPasswordStoreInput,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { CliPasswordPicker, CliPasswordStoreRow } from "./CliPasswordStores";

const state = vi.hoisted(() => ({ inputs: [] as CliPasswordStoreInput[] }));
vi.mock("./useAccounts", () => ({
  usePasswordStorePermission: () => true,
  useAccountCommand: () => async (input: CliPasswordStoreInput) => {
    state.inputs.push(input);
    return {
      ok: true,
      value: {
        status: {
          state:
            input.action === "disconnect"
              ? "not-connected"
              : input.action === "connect"
                ? "unlocked"
                : "locked",
          connection: "synthetic-connection",
          email: "synthetic@example.invalid",
        },
        items: [
          { itemId: "synthetic-item", name: "Synthetic login", fields: ["password", "custom:api"] },
        ],
      },
    };
  },
}));
function setup() {
  state.inputs = [];
}
const environmentId = EnvironmentId.make("synthetic");
it("clears the private unlock input after connecting and reflects disconnect", async () => {
  setup();
  await using screen = await render(
    <CliPasswordStoreRow
      store="bitwarden"
      environmentId={environmentId}
      canWrite
      status={undefined}
    />,
  );
  await screen.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("menuitem", { name: "Connect…" }).click();
  const privateInput = page.getByLabelText("Bitwarden master password");
  await privateInput.fill("synthetic-master");
  await screen.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.element(privateInput).toHaveValue("");
  await expect.element(screen.getByText("unlocked · synthetic@example.invalid")).toBeVisible();
  await screen.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("menuitem", { name: "Disconnect", exact: true }).click();
  await expect.element(screen.getByText("not-connected · synthetic@example.invalid")).toBeVisible();
  expect(state.inputs.find((input) => input.action === "connect")?.password).toBe(
    "synthetic-master",
  );
});
function PickerFixture() {
  const [source, setSource] = useState<CliPasswordSource>();
  return (
    <>
      <CliPasswordPicker store="bitwarden" environmentId={environmentId} onChange={setSource} />
      <output aria-label="Selected source">
        {source ? `${source.itemId}/${source.field}` : "No link"}
      </output>
    </>
  );
}
it("selects an item and custom field, clearing the old link when a new search starts", async () => {
  setup();
  await using screen = await render(<PickerFixture />);
  await page.getByLabelText("Bitwarden search").fill("Synthetic");
  await screen.getByRole("button", { name: "Search items" }).click();
  await page.getByLabelText("Bitwarden item").selectOptions("0");
  await page.getByLabelText("Bitwarden field").selectOptions("custom:api");
  await expect
    .element(screen.getByLabelText("Selected source"))
    .toHaveTextContent("synthetic-item/custom:api");
  await screen.getByRole("button", { name: "Search items" }).click();
  await expect.element(screen.getByLabelText("Selected source")).toHaveTextContent("No link");
});
