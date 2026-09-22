import { useId, useRef, useState, useSyncExternalStore } from "react";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { matchingMathCommands } from "./catalog";
import type { MathInputController } from "./controller";
import { MATRIX_ENVIRONMENTS, type MatrixEnvironment } from "./matrix";
import {
  commandKeys,
  getKeyboardPreferences,
  subscribeKeyboardPreferences,
} from "../../keyboard/preferences";
import { labelKeys } from "../../keyboard/keys";
import "./math-input.css";

export function MathInputTools({ controller }: { readonly controller: MathInputController }) {
  const panel = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [rows, setRows] = useState(2);
  const [columns, setColumns] = useState(2);
  const [environment, setEnvironment] = useState<MatrixEnvironment>("pmatrix");
  useSyncExternalStore(
    subscribeKeyboardPreferences,
    getKeyboardPreferences,
    getKeyboardPreferences,
  );
  const shortcutLabel = (id: string) =>
    commandKeys(id)
      .map((keys) => labelKeys(keys))
      .join(" / ");
  const [error, setError] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const symbols = useRef<HTMLSpanElement>(null);
  const matches = matchingMathCommands(panel.query);
  const run = (id: string) => {
    if (controller.execute(id)) controller.close();
    else setError("This command is unavailable at the current selection.");
  };
  return (
    <span className="scient-math-tools" data-scient-math-tools="true" contentEditable={false}>
      {panel.sequenceHint ? (
        <span role="status" className="text-xs text-muted-foreground">
          {panel.sequenceHint}
        </span>
      ) : null}
      <ScientTooltip
        content={
          "Math and symbols" +
          (shortcutLabel("math.palette") ? " (" + shortcutLabel("math.palette") + ")" : "")
        }
      >
        <button
          ref={trigger}
          type="button"
          aria-label="Insert math or symbol"
          aria-expanded={panel.open}
          aria-controls={panel.open ? panelId : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setError("");

            if (panel.open) controller.close();
            else controller.open();
          }}
        >
          Ω
        </button>
      </ScientTooltip>
      <Popover
        open={panel.open}
        onOpenChange={(open, details) => {
          if (!open)
            controller.close(details.reason !== "outside-press" && details.reason !== "focus-out");
        }}
      >
        {panel.open ? (
          <PopoverPopup
            anchor={trigger}
            align="start"
            className="scient-math-tools"
            viewportClassName="p-0"
            initialFocus={searchInput}
            finalFocus={false}
            data-keybinding-capture=""
            data-scient-math-tools="true"
            aria-label="Math and symbols"
          >
            <span
              id={panelId}
              className="scient-math-palette"
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  controller.close();
                }
              }}
            >
              <span className="scient-math-palette-heading">
                <strong>Math and symbols</strong>
                <button
                  type="button"
                  aria-label="Close math palette"
                  onClick={() => controller.close()}
                >
                  ×
                </button>
              </span>
              <span className="scient-math-palette-actions">
                <button type="button" onClick={() => run("math.inline")}>
                  Inline equation
                </button>
                <button type="button" onClick={() => run("math.display")}>
                  Display equation
                </button>
                <button type="button" onClick={() => run("math.fraction")}>
                  Fraction
                </button>
                <button type="button" onClick={() => run("math.sqrt")}>
                  √
                </button>
              </span>
              <input
                ref={searchInput}
                aria-label="Find a math symbol or command"
                placeholder="Search: alpha, fraction, arrow…"
                value={panel.query}
                onChange={(event) => controller.search(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter" && matches[0]) {
                    event.preventDefault();
                    run(matches[0].id);
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    symbols.current?.querySelector<HTMLButtonElement>("button")?.focus();
                  }
                }}
              />
              <span
                ref={symbols}
                className="scient-math-symbols"
                onKeyDown={(event) => {
                  if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(event.key))
                    return;
                  const buttons = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
                  ];
                  const index = buttons.indexOf(event.target as HTMLButtonElement);
                  if (index < 0) return;
                  event.preventDefault();
                  const next =
                    index +
                    (event.key === "ArrowRight"
                      ? 1
                      : event.key === "ArrowLeft"
                        ? -1
                        : event.key === "ArrowDown"
                          ? 3
                          : -3);
                  if (next < 0) searchInput.current?.focus();
                  else buttons[Math.min(next, buttons.length - 1)]?.focus();
                }}
              >
                {matches.map((command) => (
                  <ScientTooltip
                    key={command.id}
                    content={`${command.group}: ${command.label}${shortcutLabel(command.id) ? " · " + shortcutLabel(command.id) : ""}`}
                  >
                    <button type="button" onClick={() => run(command.id)}>
                      {command.label}
                    </button>
                  </ScientTooltip>
                ))}
              </span>
              <span className="scient-math-matrix-picker">
                <label>
                  Matrix{" "}
                  <select
                    aria-label="Matrix style"
                    value={environment}
                    onChange={(event) => setEnvironment(event.target.value as MatrixEnvironment)}
                  >
                    {MATRIX_ENVIRONMENTS.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Rows{" "}
                  <input
                    aria-label="Matrix rows"
                    type="number"
                    min={1}
                    max={20}
                    value={rows}
                    onChange={(event) => setRows(Number(event.target.value))}
                  />
                </label>
                <label>
                  Columns{" "}
                  <input
                    aria-label="Matrix columns"
                    type="number"
                    min={1}
                    max={20}
                    value={environment === "cases" || environment === "aligned" ? 2 : columns}
                    disabled={environment === "cases" || environment === "aligned"}
                    onChange={(event) => setColumns(Number(event.target.value))}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      controller.matrix(
                        environment,
                        rows,
                        environment === "cases" || environment === "aligned" ? 2 : columns,
                      )
                    )
                      controller.close();
                    else
                      setError(
                        "Use whole dimensions from 1 to 20 and place the caret in an editable equation or paragraph.",
                      );
                  }}
                >
                  Insert matrix
                </button>
              </span>
              <span className="scient-math-palette-actions">
                {(["addRow", "deleteRow", "addColumn", "deleteColumn"] as const).map((action) => (
                  <button
                    type="button"
                    key={action}
                    onClick={() => {
                      if (controller.execute(`math.matrix.${action}`)) controller.close();
                      else setError("Place the caret inside a supported matrix cell first.");
                    }}
                  >
                    {action.replace(/([A-Z])/gu, " $1")}
                  </button>
                ))}
              </span>
              <span className="text-xs">
                Customize in Settings → Keybindings → Document and math shortcuts.
              </span>
              {error || panel.notice ? <span role="status">{panel.notice || error}</span> : null}
            </span>
          </PopoverPopup>
        ) : null}
      </Popover>
    </span>
  );
}
