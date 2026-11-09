import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

import { render } from "../../../test/render";
import { SignInKey } from "./SignInKey";

it("shows the filled sign-in, reveals its password on request, and fills another instead", async () => {
  const onReveal = vi.fn(async () => "synthetic-pass-2025");
  const onFill = vi.fn();
  await using _screen = await render(
    <SignInKey
      site="idp.example.edu"
      rows={[
        { accountId: "new", username: "a@example.edu", profile: "Work" },
        { accountId: "old", username: "a@example.edu", profile: "Main" },
      ]}
      filledId="new"
      busy={false}
      onFill={onFill}
      onReveal={onReveal}
      onEdit={() => undefined}
    />,
    { router: false },
  );

  await page.getByRole("button", { name: "Filled with a@example.edu · Work" }).click();
  await expect.element(page.getByText("Filled with", { exact: true })).toBeVisible();
  await expect.element(page.getByText("••••••••")).toBeVisible();
  expect(document.body.textContent).not.toContain("synthetic-pass-2025");

  await page.getByRole("button", { name: "Show password" }).click();
  await expect.element(page.getByText("synthetic-pass-2025")).toBeVisible();
  expect(onReveal).toHaveBeenCalledWith("new");

  await page.getByRole("button", { name: "Hide password" }).click();
  await expect.element(page.getByText("••••••••")).toBeVisible();

  await page.getByRole("button", { name: "Fill a@example.edu · Main" }).click();
  expect(onFill).toHaveBeenCalledWith("old");
});
