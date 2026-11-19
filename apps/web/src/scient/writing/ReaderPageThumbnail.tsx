import { useGT } from "gt-react";
import { forwardRef, type ReactNode, type ButtonHTMLAttributes } from "react";
import "./readerPageThumbnail.css";

/** Shared page navigation; each reader owns the preview inside it. */
export const ReaderPageThumbnail = forwardRef<
  HTMLButtonElement,
  {
    readonly pageNumber: number;
    readonly active: boolean;
    readonly children: ReactNode;
    readonly onSelect: (page: number) => void;
  } & Pick<ButtonHTMLAttributes<HTMLButtonElement>, "draggable" | "onDragStart" | "onDragEnd">
>(function ReaderPageThumbnail({ pageNumber, active, children, onSelect, ...buttonProps }, ref) {
  const gt = useGT();
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      className="scient-reader-page-thumbnail"
      data-active={active || undefined}
      aria-label={gt("Go to page {pageNumber}", { pageNumber })}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(pageNumber)}
    >
      <span className="scient-reader-page-thumbnail-preview">{children}</span>
      <span>{pageNumber}</span>
    </button>
  );
});
