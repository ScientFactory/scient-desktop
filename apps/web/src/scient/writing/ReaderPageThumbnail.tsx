import { forwardRef, type ReactNode } from "react";
import "./readerPageThumbnail.css";

/** Shared page navigation; each reader owns the preview inside it. */
export const ReaderPageThumbnail = forwardRef<
  HTMLButtonElement,
  {
    readonly pageNumber: number;
    readonly active: boolean;
    readonly children: ReactNode;
    readonly onSelect: (page: number) => void;
  }
>(function ReaderPageThumbnail({ pageNumber, active, children, onSelect }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className="scient-reader-page-thumbnail"
      data-active={active || undefined}
      aria-label={`Go to page ${pageNumber}`}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(pageNumber)}
    >
      <span className="scient-reader-page-thumbnail-preview">{children}</span>
      <span>{pageNumber}</span>
    </button>
  );
});
