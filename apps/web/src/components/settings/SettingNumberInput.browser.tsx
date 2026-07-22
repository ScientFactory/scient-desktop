// FILE: SettingNumberInput.browser.tsx
// Purpose: Browser regressions for manual settings number entry and commit-time normalization.
// Layer: Vitest browser tests

import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { normalizeChatFontSizePx, normalizeTerminalFontSizePx } from "../../appSettings";
import { SettingNumberInput } from "./SettingNumberInput";

describe("SettingNumberInput", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps partial base-font input editable and commits on Enter", async () => {
    const onCommit = vi.fn();
    await render(
      <SettingNumberInput
        type="number"
        value={15}
        min={11}
        max={18}
        step={1}
        normalizeValue={normalizeChatFontSizePx}
        onCommit={onCommit}
        aria-label="Base font size in pixels"
      />,
    );

    const input = page.getByRole("spinbutton", { name: "Base font size in pixels" });
    await input.fill("1");
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("1");
    expect(onCommit).not.toHaveBeenCalled();

    await input.fill("14");
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("14");
    await userEvent.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(14);
  });

  it("reverts an empty draft and clamps out-of-range terminal input on blur", async () => {
    const onCommit = vi.fn();
    await render(
      <SettingNumberInput
        type="number"
        value={12}
        min={10}
        max={22}
        step={1}
        normalizeValue={normalizeTerminalFontSizePx}
        onCommit={onCommit}
        aria-label="Terminal font size in pixels"
      />,
    );

    const input = page.getByRole("spinbutton", { name: "Terminal font size in pixels" });
    await input.fill("");
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("");
    document.querySelector<HTMLInputElement>("input")?.blur();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("12");
    });
    expect(onCommit).not.toHaveBeenCalled();

    await input.fill("99");
    document.querySelector<HTMLInputElement>("input")?.blur();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("22");
    });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(22);
  });
});
