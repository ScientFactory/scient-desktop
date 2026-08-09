import { ExternalLink } from "lucide-react";

import type { PDFOutline, PDFOutlineItem } from "./pdfRuntime";

function OutlineItem(props: {
  readonly depth: number;
  readonly item: PDFOutlineItem;
  readonly onDestination: (destination: string | Array<unknown>) => void;
  readonly onExternalUrl: (url: string) => void;
}) {
  const label = props.item.title.trim() || "Untitled section";
  const content = (
    <span className="scient-pdf-outline-label" style={{ paddingInlineStart: props.depth * 12 }}>
      <span className="truncate">{label}</span>
      {props.item.url ? <ExternalLink className="size-3 shrink-0" aria-hidden="true" /> : null}
    </span>
  );

  return (
    <li>
      {props.item.url ? (
        <button
          type="button"
          className="scient-pdf-outline-link"
          title={label}
          onClick={() => props.onExternalUrl(props.item.url!)}
        >
          {content}
        </button>
      ) : (
        <button
          type="button"
          className="scient-pdf-outline-link"
          disabled={props.item.dest === null}
          title={label}
          onClick={() => {
            if (props.item.dest !== null) props.onDestination(props.item.dest);
          }}
        >
          {content}
        </button>
      )}
      {props.item.items.length > 0 ? (
        <ul>
          {props.item.items.map((child: PDFOutlineItem) => (
            <OutlineItem
              key={`${child.title}:${child.url ?? ""}:${JSON.stringify(child.dest)}`}
              item={child}
              depth={props.depth + 1}
              onDestination={props.onDestination}
              onExternalUrl={props.onExternalUrl}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function PdfOutline(props: {
  readonly items: PDFOutline;
  readonly onDestination: (destination: string | Array<unknown>) => void;
  readonly onExternalUrl: (url: string) => void;
}) {
  if (props.items.length === 0) {
    return <p className="px-4 py-8 text-center text-xs text-muted-foreground">No outline</p>;
  }
  return (
    <ul className="scient-pdf-outline">
      {props.items.map((item: PDFOutlineItem) => (
        <OutlineItem
          key={`${item.title}:${item.url ?? ""}:${JSON.stringify(item.dest)}`}
          item={item}
          depth={0}
          onDestination={props.onDestination}
          onExternalUrl={props.onExternalUrl}
        />
      ))}
    </ul>
  );
}
