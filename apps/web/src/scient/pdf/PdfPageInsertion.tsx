import { useEffect, useRef, useState } from "react";
import { CirclePlus, FilePlus2, Files } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "~/components/ui/menu";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { Button } from "~/components/ui/button";
import { parsePdfPageRange, type PdfEditPage } from "./pdfPageEdits";
import type { PdfEditSession } from "./pdfEditSession";

export function PdfPageInsertion(props: {
  boundary: number;
  last?: boolean;
  session: PdfEditSession;
  disabled: boolean;
  ensureReady: () => Promise<boolean>;
}) {
  const anchor = useRef<HTMLButtonElement>(null),
    picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; pages: readonly PdfEditPage[] } | null>(null);
  const [range, setRange] = useState(""),
    [all, setAll] = useState(true);
  // A picked PDF not yet inserted. It is released when the picker is cancelled or
  // this gap control disappears (a virtualized thumbnail, the Outline tab).
  const picked = useRef<string | null>(null),
    mounted = useRef(false);
  const session = props.session;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (picked.current) session.releaseFile(picked.current);
      picked.current = null;
    };
  }, [session]);
  const cancel = () => {
    if (picked.current) props.session.releaseFile(picked.current);
    picked.current = null;
    setFile(null);
  };
  return (
    <div
      className="scient-pdf-page-insertion"
      data-first={props.boundary === 0 || undefined}
      data-last={props.last || undefined}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              ref={anchor}
              type="button"
              className="scient-pdf-page-plus"
              disabled={props.disabled}
              aria-label={
                props.boundary ? `Insert after page ${props.boundary}` : "Insert before first page"
              }
            />
          }
        >
          <CirclePlus aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuItem
            disabled={props.disabled}
            onClick={() => {
              void props.ensureReady().then((ready) => {
                if (ready) void props.session.blank(props.boundary);
              });
            }}
          >
            <FilePlus2 /> Blank page
          </DropdownMenuItem>
          <DropdownMenuItem disabled={props.disabled} onClick={() => picker.current?.click()}>
            <Files /> From PDF…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={picker}
        type="file"
        accept=".pdf,application/pdf"
        hidden
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!chosen) return;
          void props.ensureReady().then((ready) => {
            if (ready)
              return props.session.run(async () => {
                const pages = await props.session.loadFile(chosen);
                const sourceId = pages[0]?.sourceId ?? null;
                if (!mounted.current) {
                  if (sourceId) props.session.releaseFile(sourceId);
                  return;
                }
                if (picked.current) props.session.releaseFile(picked.current);
                picked.current = sourceId;
                setAll(true);
                setRange("");
                setFile({ name: chosen.name, pages });
              });
          });
        }}
      />
      <Popover
        open={file !== null}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <PopoverPopup anchor={anchor} side="right" align="start" width="sm" padding="comfortable">
          {file ? (
            <form
              className="scient-pdf-insert-form"
              onSubmit={(event) => {
                event.preventDefault();
                void props.session.run(async () => {
                  const pages = all
                    ? file.pages
                    : parsePdfPageRange(range, file.pages.length).map((n) => file.pages[n - 1]!);
                  picked.current = null;
                  setFile(null);
                  // Enqueue the change after the source-loading/validation transaction.
                  void props.session.insert(pages, props.boundary);
                });
              }}
            >
              <strong>From PDF</strong>
              <span className="scient-pdf-import-name">{file.name}</span>
              <div className="scient-pdf-import-scope">
                <label>
                  <input
                    type="radio"
                    name="pdf-pages"
                    checked={all}
                    onChange={() => setAll(true)}
                  />{" "}
                  All pages
                </label>
                <label>
                  <input
                    type="radio"
                    name="pdf-pages"
                    checked={!all}
                    onChange={() => setAll(false)}
                  />{" "}
                  Range
                </label>
              </div>
              {!all ? (
                <input
                  className="scient-pdf-import-range"
                  aria-label="Pages to insert"
                  placeholder="1, 3–5"
                  value={range}
                  onChange={(event) => setRange(event.target.value)}
                />
              ) : null}
              <div className="scient-pdf-insert-actions">
                <Button type="button" size="xs" variant="ghost" onClick={cancel}>
                  Cancel
                </Button>
                <Button type="submit" size="xs" variant="outline" disabled={props.disabled}>
                  Insert
                </Button>
              </div>
            </form>
          ) : null}
        </PopoverPopup>
      </Popover>
    </div>
  );
}
