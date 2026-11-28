import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

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
      onCopy={() => undefined}
      onEditRow={() => undefined}
      onRemove={() => undefined}
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

it("drops a reveal that answers after the popover closed", async () => {
  const answer = Promise.withResolvers<string>();
  await using _screen = await render(
    <SignInKey
      site="idp.example.edu"
      rows={[{ accountId: "new", username: "a@example.edu" }]}
      filledId="new"
      busy={false}
      onFill={() => undefined}
      onReveal={() => answer.promise}
      onCopy={() => undefined}
      onEditRow={() => undefined}
      onRemove={() => undefined}
      onEdit={() => undefined}
    />,
    { router: false },
  );
  const key = page.getByRole("button", { name: "Filled with a@example.edu" });
  await key.click();
  await page.getByRole("button", { name: "Show password" }).click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("Filled with", { exact: true })).not.toBeInTheDocument();
  answer.resolve("synthetic-late-pass");
  await answer.promise;

  await key.click();
  await expect.element(page.getByText("••••••••")).toBeVisible();
  expect(document.body.textContent).not.toContain("synthetic-late-pass");
});

it("gives each login its own menu, orders them by when they last worked, and says how each did", async () => {
  const onReveal = vi.fn(async (accountId: string) => `synthetic-${accountId}`);
  const onCopy = vi.fn();
  const onEditRow = vi.fn();
  const onRemove = vi.fn();
  const onEdit = vi.fn();
  await using _screen = await render(
    <SignInKey
      site="tss2.ada.huji.ac.il"
      rows={[
        {
          accountId: "old",
          username: "yaacovc",
          workedAt: "2026-11-06T00:00:00.000Z",
        },
        { accountId: "refused", username: "cc\\corcosy", refused: true },
        {
          accountId: "new",
          username: "cc\\yaacovc",
          workedAt: "2026-11-24T00:00:00.000Z",
        },
      ]}
      filledId={undefined}
      busy={false}
      onFill={() => undefined}
      onReveal={onReveal}
      onCopy={onCopy}
      onEditRow={onEditRow}
      onRemove={onRemove}
      onEdit={onEdit}
    />,
    { router: false },
  );
  await page.getByRole("button", { name: "Saved sign-ins for tss2.ada.huji.ac.il" }).click();
  const fills = page.getByRole("button", { name: /^Fill / }).elements();
  // Most recently worked first; the refused one last.
  expect(fills.map((element) => element.getAttribute("aria-label"))).toEqual([
    "Fill cc\\yaacovc",
    "Fill yaacovc",
    "Fill cc\\corcosy",
  ]);
  await expect.element(page.getByText("Refused")).toBeVisible();
  await expect.element(page.getByText(/^Worked /).first()).toBeVisible();
  // Show, in place under its login.
  await page.getByRole("button", { name: "More for yaacovc" }).click();
  await page.getByRole("menuitem", { name: "Show password" }).click();
  await expect.element(page.getByText("synthetic-old")).toBeVisible();
  expect(onReveal).toHaveBeenCalledWith("old");
  await page.getByRole("button", { name: "More for cc\\corcosy" }).click();
  await page.getByRole("menuitem", { name: "Copy password" }).click();
  expect(onCopy).toHaveBeenCalledWith("refused");
  await page.getByRole("button", { name: "More for cc\\corcosy" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  expect(onEditRow).toHaveBeenCalledWith("refused");
  await page.getByRole("button", { name: "More for cc\\corcosy" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  expect(onRemove).toHaveBeenCalledWith("refused");
  await page.getByRole("button", { name: "Edit in Accounts" }).click();
  expect(onEdit).toHaveBeenCalledOnce();
});
