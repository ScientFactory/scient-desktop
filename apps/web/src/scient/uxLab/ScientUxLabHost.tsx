import { useState } from "react";
import { FlaskConical, X } from "lucide-react";

import { Button } from "../../components/ui/button";
import {
  SCIENT_UX_LAB_ENABLED,
  readSourcesLabScenario,
  selectSourcesLabScenario,
  sourcesLabScenarios,
  type SourcesLabScenario,
} from "./state";

export function ScientUxLabHost() {
  const [open, setOpen] = useState(false);

  if (!SCIENT_UX_LAB_ENABLED) return null;

  const activeScenario = readSourcesLabScenario();

  return (
    <div className="fixed right-4 bottom-4 z-[100] flex flex-col items-end gap-2">
      {open ? (
        <section className="w-72 rounded-xl border border-border bg-background/95 p-3 text-foreground shadow-xl backdrop-blur">
          <header className="mb-3 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <FlaskConical className="size-4" aria-hidden="true" />
                Scient UX Lab
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Real app · synthetic external state
              </p>
            </div>
            <Button
              aria-label="Close UX Lab controls"
              className="size-7"
              onClick={() => setOpen(false)}
              size="icon"
              variant="ghost"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </header>

          <label
            className="block text-xs font-medium text-muted-foreground"
            htmlFor="ux-lab-journey"
          >
            Journey
          </label>
          <select
            className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            disabled
            id="ux-lab-journey"
            value="zotero-sources"
          >
            <option value="zotero-sources">Zotero sources</option>
          </select>

          <label
            className="mt-3 block text-xs font-medium text-muted-foreground"
            htmlFor="ux-lab-scenario"
          >
            Scenario
          </label>
          <select
            className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            id="ux-lab-scenario"
            onChange={(event) =>
              selectSourcesLabScenario(event.currentTarget.value as SourcesLabScenario)
            }
            value={activeScenario}
          >
            {sourcesLabScenarios.map((scenario) => (
              <option key={scenario.value} value={scenario.value}>
                {scenario.label}
              </option>
            ))}
          </select>
        </section>
      ) : null}

      <Button className="gap-2 shadow-lg" onClick={() => setOpen((value) => !value)} size="sm">
        <FlaskConical className="size-4" aria-hidden="true" />
        UX Lab
      </Button>
    </div>
  );
}
