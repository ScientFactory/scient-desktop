import { useId, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { MIN_VISUAL_ZOOM as MIN_ZOOM, MAX_VISUAL_ZOOM as MAX_ZOOM } from "./useLatexPinchZoom";

const ZOOM_LEVELS = [0.25, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export function LatexVisualZoomControls({
  zoom,
  fit,
  onZoom,
  onFit,
}: {
  zoom: number;
  fit: boolean;
  onZoom: (zoom: number) => void;
  onFit: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const presetsId = useId();
  const percentage = Math.round(zoom * 10000) / 100;
  const step = (direction: -1 | 1) => {
    setDraft(null);
    const levels = direction === 1 ? ZOOM_LEVELS : ZOOM_LEVELS.toReversed();
    const next = levels.find((level) =>
      direction === 1 ? level > zoom + 0.001 : level < zoom - 0.001,
    );
    if (next !== undefined) onZoom(next);
  };
  return (
    <div className="scient-latex-zoom-controls" role="group" aria-label="Visual document zoom">
      <ScientTooltip content="Zoom out">
        <button
          type="button"
          className="scient-latex-zoom-step"
          aria-label="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => step(-1)}
        >
          <Minus aria-hidden="true" />
        </button>
      </ScientTooltip>
      <label className="scient-latex-zoom-value" title="Enter a zoom percentage (25–400%)">
        <input
          aria-label="Document zoom percentage"
          type="text"
          inputMode="decimal"
          list={presetsId}
          value={draft ?? String(percentage)}
          onFocus={(event) => {
            cancelled.current = false;
            event.currentTarget.select();
          }}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={(event) => {
            if (!cancelled.current && draft !== null) {
              const text = event.currentTarget.value.trim().replace(/%$/u, "").trim();
              const value = /^\d+(?:[.,]\d+)?$/u.test(text) ? Number(text.replace(",", ".")) : NaN;
              if (Number.isFinite(value) && value > 0)
                onZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value / 100)));
            }
            setDraft(null);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              cancelled.current = true;
              event.currentTarget.blur();
            }
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <span aria-hidden="true">%</span>
      </label>
      <datalist id={presetsId}>
        {ZOOM_LEVELS.map((level) => (
          <option key={level} value={Math.round(level * 100)} />
        ))}
      </datalist>
      <ScientTooltip content="Zoom in">
        <button
          type="button"
          className="scient-latex-zoom-step"
          aria-label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => step(1)}
        >
          <Plus aria-hidden="true" />
        </button>
      </ScientTooltip>
      <ScientTooltip content="Fit the page to the available width">
        <button
          className="scient-latex-zoom-fit"
          type="button"
          aria-label="Fit width"
          aria-pressed={fit}
          onClick={() => {
            setDraft(null);
            onFit();
          }}
        >
          <Maximize2 aria-hidden="true" />
        </button>
      </ScientTooltip>
    </div>
  );
}
