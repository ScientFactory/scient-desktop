import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({
  useUpdateEnvironmentSettings: () => vi.fn(),
}));

vi.mock("../ui/button", () => ({
  Button: ({
    children,
    size,
    ...props
  }: {
    readonly children?: ReactNode;
    readonly size?: string;
  }) => (
    <button data-size={size} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("../ui/dialog", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogPanel: Container,
    DialogPopup: Container,
    DialogTitle: Container,
  };
});

vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("../ui/label", () => ({
  Label: ({ children, ...props }: { readonly children?: ReactNode }) => (
    <label {...props}>{children}</label>
  ),
}));

vi.mock("../ui/tooltip", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    Tooltip: Container,
    TooltipPopup: Container,
    TooltipTrigger: ({ render }: { readonly render?: ReactNode }) => render,
  };
});

import { AddUsageAccountingSourceDialog } from "./AddUsageAccountingSourceDialog";

describe("AddUsageAccountingSourceDialog", () => {
  it("keeps setup concise and links directly to OpenRouter management keys", () => {
    const markup = renderToStaticMarkup(
      <AddUsageAccountingSourceDialog
        open
        onOpenChange={() => {}}
        environmentId={EnvironmentId.make("local")}
      />,
    );

    expect(markup).toContain("Add OpenRouter billing");
    expect(markup).toContain("Use a management key to import spend, tokens, and model usage.");
    expect(markup).toContain("Create a management key in OpenRouter");
    expect(markup).toContain("https://openrouter.ai/settings/management-keys");
    expect(markup).toContain("Add billing");
    expect(markup.match(/data-size="sm"/g)).toHaveLength(2);
    expect(markup.match(/text-\[15px\] sm:text-\[15px\]/g)).toHaveLength(2);
    expect(markup).not.toContain("Label (optional)");
    expect(markup).not.toContain("Connect OpenRouter accounting");
  });
});
