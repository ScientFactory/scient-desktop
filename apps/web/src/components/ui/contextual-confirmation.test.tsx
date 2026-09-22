// @vitest-environment happy-dom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, disabled, onClick }: ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("~/components/ui/popover", () => ({
  Popover: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  PopoverDescription: ({ children }: { readonly children: ReactNode }) => <p>{children}</p>,
  PopoverPopup: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  PopoverTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
  PopoverTrigger: () => null,
}));

import { ContextualConfirmation } from "./contextual-confirmation";

describe("ContextualConfirmation", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("uses the quiet action slot for a second explicit choice", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    const onConfirm = vi.fn();
    await act(() =>
      root.render(
        <ContextualConfirmation
          open
          onOpenChange={onOpenChange}
          title="Choose runtime"
          description="Current Python is missing scientific packages."
          confirmLabel="Use managed"
          secondaryAction={{ label: "Use current", onSelect }}
          onConfirm={onConfirm}
        />,
      ),
    );

    const buttons = Array.from(document.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Use current", "Use managed"]);
    await act(() => buttons[0]!.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    await act(() => root.unmount());
  });
});
