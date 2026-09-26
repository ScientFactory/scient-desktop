import { useEffect, useRef, useState } from "react";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "~/components/ui/dialog";

export interface LatexInsertAction {
  id: string;
  label: string;
  description: string;
  group: string;
  run: () => void;
}

export function LatexInsertDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: readonly LatexInsertAction[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, props.open]);
  useEffect(() => {
    if (props.open) {
      setQuery("");
      setActive(0);
    }
  }, [props.open]);
  const choices = props.actions.filter((action) =>
    `${action.label} ${action.description} ${action.group}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const run = (action: LatexInsertAction) => {
    props.onOpenChange(false);
    requestAnimationFrame(action.run);
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="scient-writing-dialog" initialFocus={input}>
        <DialogTitle>Insert into document</DialogTitle>
        <DialogDescription>
          Choose what you want to add. Type / on an empty paragraph to open this menu.
        </DialogDescription>
        <input
          ref={input}
          className="scient-writing-search"
          aria-label="Search insert actions"
          placeholder="Equation, question, table, figure…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) =>
                Math.max(
                  0,
                  Math.min(choices.length - 1, value + (event.key === "ArrowDown" ? 1 : -1)),
                ),
              );
            }
            if (event.key === "Enter" && choices[active]) {
              event.preventDefault();
              run(choices[active]!);
            }
          }}
        />
        <div ref={list} className="scient-writing-choices">
          {choices.map((action, index) => (
            <button
              key={action.id}
              type="button"
              data-active={index === active || undefined}
              onMouseEnter={() => setActive(index)}
              onClick={() => run(action)}
            >
              <span>
                <strong>{action.label}</strong>
                <small>{action.description}</small>
              </span>
              <span className="scient-writing-choice-group">{action.group}</span>
            </button>
          ))}
          {choices.length === 0 ? <p>No matching actions.</p> : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
