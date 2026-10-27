import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ManagedAccountRow } from "./AccountsPage";

it("links the read-only Overleaf token row to its token settings", async () => {
  await using _screen = await render(
    <ManagedAccountRow
      row={{
        kind: "overleaf",
        name: "Overleaf Git token — www.overleaf.com",
        href: "/settings/synced-folders",
      }}
    />,
  );
  await expect.element(page.getByText("Overleaf Git token — www.overleaf.com")).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Managed in Overleaf" }))
    .toHaveAttribute("href", "/settings/synced-folders");
  await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
  await expect.element(page.getByRole("button")).not.toBeInTheDocument();
});
