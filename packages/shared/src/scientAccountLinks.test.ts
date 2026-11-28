import { expect, it } from "vite-plus/test";
import { accountLinkHref, formatAccountLink, parseAccountLinkHref } from "./scientAccountLinks.ts";

it("links one Accounts row on one computer, and reads only such a link back", () => {
  const href = accountLinkHref("env/one", "acc_openrouter2");
  expect(parseAccountLinkHref(href)).toEqual({
    environmentId: "env/one",
    accountId: "acc_openrouter2",
  });
  expect(formatAccountLink("env", "acc_openrouter2", "Test [key] 2")).toBe(
    "[Test key 2](scient-account://env/acc_openrouter2)",
  );
  expect(parseAccountLinkHref("scient-account://env/not-an-account")).toBeNull();
  expect(parseAccountLinkHref("scient-account://env/acc_openrouter2/more")).toBeNull();
  expect(parseAccountLinkHref("https://example.com/acc_openrouter2")).toBeNull();
});
