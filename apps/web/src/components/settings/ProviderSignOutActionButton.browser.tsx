import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ProviderSignOutActionButton } from "./ProviderSignOutActionButton";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ProviderSignOutActionButton", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is keyboard accessible and reports the account-level action truthfully", async () => {
    const onRequestSignOut = vi.fn().mockResolvedValue(undefined);
    await render(
      <ProviderSignOutActionButton provider="codex" onRequestSignOut={onRequestSignOut} />,
    );

    const button = page.getByRole("button", { name: "Sign out of Codex" });
    await userEvent.tab();
    await expect.element(button).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onRequestSignOut).toHaveBeenCalledOnce();
  });

  it("locks synchronously before awaiting confirmation or the server", async () => {
    const pending = deferred();
    const onRequestSignOut = vi.fn(() => pending.promise);
    await render(
      <ProviderSignOutActionButton provider="claudeAgent" onRequestSignOut={onRequestSignOut} />,
    );

    const element = page
      .getByRole("button", { name: "Sign out of Claude" })
      .element() as HTMLButtonElement;
    element.click();
    element.click();
    expect(onRequestSignOut).toHaveBeenCalledOnce();
    await expect
      .element(page.getByRole("button", { name: "Signing out of Claude" }))
      .toBeDisabled();

    pending.resolve();
    await expect.element(page.getByRole("button", { name: "Sign out of Claude" })).toBeEnabled();
  });

  it("does not invoke sign-out while another provider operation disables it", async () => {
    const onRequestSignOut = vi.fn().mockResolvedValue(undefined);
    await render(
      <ProviderSignOutActionButton
        provider="cursor"
        disabled
        onRequestSignOut={onRequestSignOut}
      />,
    );

    const button = page.getByRole("button", { name: "Sign out of Cursor" });
    await expect.element(button).toBeDisabled();
    expect(onRequestSignOut).not.toHaveBeenCalled();
  });
});
