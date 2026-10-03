import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LatexObjectMathField } from "./LatexObjectMathField";
import { LatexSelect } from "./LatexSelect";
import { LatexTextField } from "./LatexTextField";
import { parseLatexTikz, patchLatexTikz } from "./latexTikz";
import { latexTableMathCell } from "./latexVisualDocument";

type DrawingProps = {
  source: string;
  disabled: boolean;
  draftKey?: string | undefined;
  onChange: (value: string) => boolean;
};
const pt = 96 / 72.27;

/** SVG owns geometry; existing fields own labels, source acceptance, and undo. */
export function LatexTikzArtwork(
  props: DrawingProps & {
    onUndo: (redo: boolean) => boolean;
    onExit: (direction: -1 | 1) => void;
  },
) {
  const drawing = useMemo(() => parseLatexTikz(props.source), [props.source]);
  const id = useId().replace(/[^a-zA-Z0-9_-]/gu, "");
  const root = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Record<number, { width: number; height: number }>>({});
  useLayoutEffect(() => {
    const labels = root.current?.querySelectorAll<HTMLElement>("[data-tikz-label]");
    if (!labels?.length) return;
    const measure = () => {
      const next: typeof sizes = {};
      labels.forEach((label) => {
        next[Number(label.dataset.tikzLabel)] = {
          width: label.offsetWidth,
          height: label.offsetHeight,
        };
      });
      setSizes((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    const observer = new ResizeObserver(measure);
    labels.forEach((label) => observer.observe(label));
    measure();
    return () => observer.disconnect();
  }, [drawing]);
  if (!drawing) return null;
  const unit = (96 / 2.54) * drawing.scale;
  const positions = drawing.shapes.map((shape) =>
    shape.points.map((point) => ({
      x: Number(point.x.value) * unit,
      y: -Number(point.y.value) * unit,
    })),
  );
  const labels = drawing.shapes.map((shape, index) => {
    const anchor = positions[index]!.at(-1)!;
    const size = sizes[index] ?? { width: 24, height: 24 };
    const placement = shape.label?.placement;
    return {
      x:
        anchor.x +
        (placement === "right" ? 4 : placement === "left" ? -size.width - 4 : -size.width / 2),
      y:
        anchor.y +
        (placement === "below" ? 4 : placement === "above" ? -size.height - 4 : -size.height / 2),
      ...size,
    };
  });
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  positions.forEach((points, index) => {
    const margin = Math.max(4, drawing.shapes[index]!.radius * pt * drawing.scale);
    points.forEach(({ x, y }) => {
      left = Math.min(left, x - margin);
      right = Math.max(right, x + margin);
      top = Math.min(top, y - margin);
      bottom = Math.max(bottom, y + margin);
    });
    if (drawing.shapes[index]!.label) {
      const label = labels[index]!;
      left = Math.min(left, label.x);
      right = Math.max(right, label.x + label.width);
      top = Math.min(top, label.y);
      bottom = Math.max(bottom, label.y + label.height);
    }
  });
  return (
    <div
      ref={root}
      className="scient-latex-tikz"
      style={{ width: right - left, height: bottom - top }}
    >
      <svg
        width={right - left}
        height={bottom - top}
        viewBox={`${left} ${top} ${right - left} ${bottom - top}`}
        role="img"
        aria-label="Drawing; edit coordinates in Figure tools"
      >
        <defs>
          {drawing.shapes.map((shape, index) =>
            shape.arrow ? (
              <marker
                key={index}
                id={`${id}-${index}`}
                markerWidth="6"
                markerHeight="6"
                refX="5"
                refY="3"
                orient="auto-start-reverse"
                markerUnits="userSpaceOnUse"
              >
                <path
                  d="M 0 0 L 5 3 L 0 6"
                  fill="none"
                  stroke={shape.color}
                  strokeWidth={shape.width * pt}
                />
              </marker>
            ) : null,
          )}
        </defs>
        {drawing.shapes.map((shape, index) =>
          shape.kind === "point" ? (
            <circle
              key={index}
              cx={positions[index]![0]!.x}
              cy={positions[index]![0]!.y}
              r={shape.radius * pt * drawing.scale}
              fill={shape.color}
            />
          ) : (
            <polyline
              key={index}
              points={positions[index]!.map((point) => `${point.x},${point.y}`).join(" ")}
              fill="none"
              stroke={shape.color}
              strokeWidth={shape.width * pt}
              markerStart={shape.arrow.startsWith("<") ? `url(#${id}-${index})` : undefined}
              markerEnd={shape.arrow.endsWith(">") ? `url(#${id}-${index})` : undefined}
            />
          ),
        )}
      </svg>
      {drawing.shapes.map((shape, index) => {
        const label = shape.label;
        if (!label) return null;
        const change = (value: string) => {
          const next = patchLatexTikz(props.source, label, value);
          return next !== null && props.onChange(next);
        };
        return (
          <span
            key={index}
            data-tikz-label={index}
            className="scient-latex-tikz-label"
            style={{ left: labels[index]!.x - left, top: labels[index]!.y - top }}
          >
            {latexTableMathCell(label.value) ? (
              <LatexObjectMathField
                value={label.value}
                label={`Drawing label ${index + 1}`}
                disabled={props.disabled}
                draftKey={props.draftKey && `${props.draftKey}:label:${index}`}
                onChange={change}
                onFocus={() => {}}
                onUndo={props.onUndo}
                onExit={props.onExit}
              />
            ) : (
              <LatexTextField
                aria-label={`Drawing label ${index + 1}`}
                rows={1}
                value={label.value}
                disabled={props.disabled}
                draftKey={props.draftKey && `${props.draftKey}:label:${index}`}
                onValueChange={change}
              />
            )}
          </span>
        );
      })}
    </div>
  );
}

/** Shown in the existing figure footer, never over the printed drawing. */
export function LatexTikzControls(props: DrawingProps & { panel: number }) {
  const drawing = useMemo(() => parseLatexTikz(props.source), [props.source]);
  const [shapeIndex, setShapeIndex] = useState(0);
  const [pointIndex, setPointIndex] = useState(0);
  if (!drawing) return null;
  const shapeAt = Math.min(shapeIndex, drawing.shapes.length - 1);
  const shape = drawing.shapes[shapeAt]!;
  const pointAt = Math.min(pointIndex, shape.points.length - 1);
  const point = shape.points[pointAt]!;
  const fields = [
    { name: "X", range: point.x, key: `${shapeAt}:${pointAt}:x` },
    { name: "Y", range: point.y, key: `${shapeAt}:${pointAt}:y` },
    ...(drawing.scaleRange ? [{ name: "Scale", range: drawing.scaleRange, key: "scale" }] : []),
  ];
  return (
    <details className="scient-latex-context-menu">
      <summary>Drawing {props.panel + 1}</summary>
      <div className="scient-latex-context-menu-panel">
        <label>
          Element
          <LatexSelect
            aria-label="Drawing element"
            value={shapeAt}
            disabled={props.disabled}
            options={drawing.shapes.map((shape, index) => ({
              value: String(index),
              label: `${shape.kind === "line" ? "Line" : "Point"} ${index + 1}`,
            }))}
            onValueChange={(value) => {
              setShapeIndex(Number(value));
              setPointIndex(0);
            }}
          />
        </label>
        {shape.points.length > 1 ? (
          <label>
            Vertex
            <LatexSelect
              aria-label="Line vertex"
              value={pointAt}
              disabled={props.disabled}
              options={shape.points.map((_, index) => ({
                value: String(index),
                label: String(index + 1),
              }))}
              onValueChange={(value) => setPointIndex(Number(value))}
            />
          </label>
        ) : null}
        {fields.map(({ name, range, key }) => (
          <label key={key}>
            {name}
            <LatexTextField
              aria-label={`Drawing ${name}`}
              rows={1}
              value={range.value}
              disabled={props.disabled}
              draftKey={props.draftKey && `${props.draftKey}:${key}`}
              onValueChange={(value) => {
                const next = patchLatexTikz(props.source, range, value);
                if (next !== null) props.onChange(next);
              }}
            />
          </label>
        ))}
      </div>
    </details>
  );
}
