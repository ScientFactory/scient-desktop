import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { accountLinkHref } from "@t3tools/shared/scientAccountLinks";
import { render } from "../../../test/render";
import { AccountRowLink } from "./AccountRowLink";

it("opens the saved row in Accounts on its computer", async () => {
  await using _screen = await render(
    <AccountRowLink href={accountLinkHref("synthetic-computer", "acc_openrouter2")}>
      Test key 2
    </AccountRowLink>,
  );
  await expect
    .element(page.getByRole("link", { name: "Test key 2" }))
    .toHaveAttribute(
      "href",
      "/settings/accounts?machine=synthetic-computer&account=acc_openrouter2",
    );
});
