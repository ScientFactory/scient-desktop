import type { ComponentProps, ReactNode } from "react";

type ScientInlineColorCodeProps = {
  readonly children: ReactNode;
  readonly codeProps: ComponentProps<"code">;
  readonly color: string;
};

/** Renders an inline code token with a small, exact-value color swatch. */
export function ScientInlineColorCode({ children, codeProps, color }: ScientInlineColorCodeProps) {
  return (
    <span
      data-scient-inline-color-code="true"
      className="inline-flex max-w-full items-center gap-[0.3em] whitespace-nowrap align-baseline"
    >
      <code {...codeProps}>{children}</code>
      <span
        aria-hidden="true"
        data-scient-inline-color-swatch="true"
        className="inline-block size-[0.8em] shrink-0 rounded-[0.2em] border border-current/20"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}
