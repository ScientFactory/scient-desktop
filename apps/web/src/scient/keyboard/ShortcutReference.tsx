import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  commandLabel,
  shortcutToKeybindingInput,
  whenAstToExpression,
} from "~/components/settings/KeybindingsSettings.logic";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import katex from "katex";
import katexCss from "katex/dist/katex.min.css?inline";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import {
  authoringCommands,
  effectiveSurfaceBindings,
  getKeyboardPreferences,
  subscribeKeyboardPreferences,
} from "./preferences";
import { isMacKeyboard, labelKeys } from "./keys";
import { mathCommand } from "../math/input/catalog";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const sections = {
  latex: "Write",
  math: "Mathematics",
  table: "Tables in Write",
  markdown: "Markdown",
  pdf: "PDF reader",
} as const;

/** A snapshot of effective bindings, never a separately maintained shortcut list. */
const NO_APP_BINDINGS: ResolvedKeybindingsConfig = [];
export function ShortcutReference({
  appBindings = NO_APP_BINDINGS,
}: {
  appBindings?: ResolvedKeybindingsConfig;
}) {
  const snapshot = useSyncExternalStore(
    subscribeKeyboardPreferences,
    getKeyboardPreferences,
    getKeyboardPreferences,
  );
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const html = useMemo(() => {
    const mac = isMacKeyboard();
    const bindings = effectiveSurfaceBindings(snapshot.preferences, mac);
    const commands = authoringCommands(snapshot.preferences, mac);
    const groups = Object.entries(sections)
      .map(([scope, label]) => {
        const rows = commands
          .filter((command) => command.scope === scope)
          .flatMap((command) => {
            const keys = bindings
              .filter((binding) => binding.command === command.id)
              .map((binding) => labelKeys(binding.keys, mac));
            if (!all && !keys.length) return [];
            const math = mathCommand(command.id);
            const custom = snapshot.preferences.customMath?.find(
              (entry) => entry.id === command.id,
            );
            let preview = "";
            if (math || custom) {
              try {
                preview = katex.renderToString(
                  custom
                    ? custom.latex
                        .replaceAll("${selection}", "\\square")
                        .replaceAll("${cursor}", "\\square")
                    : math!.template.replaceAll("@", "\\square").replaceAll("|", "\\square"),
                  { throwOnError: true, trust: false },
                );
              } catch {
                /* The action name remains readable for unsupported previews. */
              }
            }
            return [
              `<tr><td>${escape(command.label)}${preview ? `<div class="formula">${preview}</div>` : ""}</td><td>${keys.length ? keys.map((key) => `<div class="keys">${escape(key)}</div>`).join("") : "<span class=muted>Unassigned</span>"}</td></tr>`,
            ];
          })
          .join("");
        return rows
          ? `<section><h2>${label}</h2><table><thead><tr><th>Action</th><th>Shortcut</th></tr></thead><tbody>${rows}</tbody></table></section>`
          : "";
      })
      .join("");
    const general = appBindings.length
      ? `<section><h2>Application shortcuts</h2><table><thead><tr><th>Action and context</th><th>Shortcut</th></tr></thead><tbody>${appBindings.map((binding) => `<tr><td>${escape(commandLabel(binding.command))}<div class="muted">${escape(whenAstToExpression(binding.whenAst))}</div></td><td class="keys">${escape(labelKeys(shortcutToKeybindingInput(binding.shortcut), mac))}</td></tr>`).join("")}</tbody></table></section>`
      : "";
    return `<!doctype html><html><head><meta charset="utf-8"><base href="${escape(document.baseURI)}"><title>Scient shortcut reference</title><style>${katexCss}</style><style>
      @page{size:A4;margin:16mm}*{box-sizing:border-box}body{font:12px/1.5 system-ui,sans-serif;color:#171717;background:white;max-width:850px;margin:24px auto;padding:0 24px}h1{font-size:25px;margin-bottom:4px}h2{font-size:17px;margin:24px 0 8px;break-after:avoid}p{color:#555}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{text-align:left;vertical-align:top;padding:7px 9px;border-bottom:1px solid #ddd}th{background:#f2f3f5}thead{display:table-header-group}tr{break-inside:avoid}td:first-child{width:56%}.keys{font-family:ui-monospace,monospace;white-space:normal}.formula{margin-top:5px;font-size:13px}.muted{color:#777}@media print{body{max-width:none;margin:0;padding:0}h2{break-after:avoid}}
      </style></head><body><h1>Scient shortcut reference</h1><p>${escape(new Date().toLocaleDateString())} · ${mac ? "Mac" : "Windows / Linux"} · ${snapshot.preferences.mathPreset === "lyx" ? "LyX-style math" : "Minimal math"}</p><p>Successive keys are shown with arrows. Release the prefix keys before the next key. Escape cancels a sequence. Commands apply to the focused editor; table commands apply in table cells. Custom bindings replace defaults.</p>${groups}${general}<h2>Native editing</h2><p>Arrow keys move the caret; Shift extends a selection. Tab moves through math placeholders. Undo, redo, clipboard, and text selection remain owned by the editor. Operating-system shortcuts can take precedence.</p></body></html>`;
  }, [snapshot, all, appBindings]);
  return (
    <>
      <Button
        size="xs"
        variant="ghost-muted"
        onClick={() => {
          setReady(false);
          setOpen(true);
        }}
      >
        PDF reference
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-4xl" data-keybinding-capture="">
          <DialogTitle>My shortcut reference</DialogTitle>
          <div className="flex items-center justify-between gap-3 py-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={all}
                onChange={(event) => {
                  setReady(false);
                  setAll(event.target.checked);
                }}
              />{" "}
              Include unassigned actions
            </label>
            <Button
              size="sm"
              disabled={!ready}
              onClick={() => {
                try {
                  frame.current?.contentWindow?.focus();
                  frame.current?.contentWindow?.print();
                } catch {
                  setError("The print dialog could not open. Try again from the desktop app.");
                }
              }}
            >
              Print / save as PDF
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Choose Save as PDF or Microsoft Print to PDF in the print dialog. Generated locally from
            your current shortcuts.
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <iframe
            ref={frame}
            title="Shortcut reference preview"
            sandbox="allow-same-origin allow-modals"
            srcDoc={html}
            className="h-[65vh] w-full rounded border bg-white"
            onLoad={() => {
              const current = frame.current;
              void current?.contentDocument?.fonts.ready.then(() => {
                if (frame.current === current) setReady(true);
              });
            }}
          />
        </DialogPopup>
      </Dialog>
    </>
  );
}
