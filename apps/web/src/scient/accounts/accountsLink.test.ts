import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { accountsSearch, savedPasswordsLink } from "./accountsLink";

it("opens the page's saved passwords from a key's Edit in Accounts, by its exact origin", () => {
  const link = savedPasswordsLink(
    EnvironmentId.make("lab"),
    "https://tss2.ada.huji.ac.il:8443/a?b",
  );
  expect(link).toEqual({
    to: "/settings/accounts",
    search: { machine: "lab", show: "passwords", site: "https://tss2.ada.huji.ac.il:8443" },
  });
  expect(accountsSearch(link.search)).toEqual({
    show: "passwords",
    site: "https://tss2.ada.huji.ac.il:8443",
  });
  expect(accountsSearch({ show: "other", site: "" })).toEqual({});
});
