import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { FileSurfaceAction } from "~/components/files/fileSurfaceChrome";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import type { TiffAxisName, TiffPreviewInfo } from "./tiffPreview";
import { formatTiffValue, tiffAxisSteps, tiffRangeText, tiffRangeWidth } from "./tiffPreviewText";
import type { TiffPreviewState } from "./useTiffPreview";

function depth(info: TiffPreviewInfo) {
  if (info.format === "float") return `${info.bits}-bit float`;
  return info.format === "int" ? `${info.bits}-bit signed` : `${info.bits}-bit`;
}

const AXIS_NAMES: Readonly<Record<TiffAxisName, string>> = {
  C: "channel",
  Z: "Z slice",
  T: "time point",
};

function Stepper(props: {
  readonly label: string;
  readonly width: number;
  readonly name: string;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly onStep: (delta: -1 | 1) => void;
}) {
  return (
    <span className="flex items-center gap-0.5">
      {/* Reserved for the widest position, so stepping never rewraps the toolbar. */}
      <span
        aria-live="polite"
        className="inline-block text-center"
        style={{ minWidth: `${props.width}ch` }}
      >
        {props.label}
      </span>
      <FileSurfaceAction
        label={`Previous ${props.name}`}
        disabled={props.atStart}
        onPress={() => props.onStep(-1)}
      >
        <ChevronLeftIcon className="size-3.5" />
      </FileSurfaceAction>
      <FileSurfaceAction
        label={`Next ${props.name}`}
        disabled={props.atEnd}
        onPress={() => props.onStep(1)}
      >
        <ChevronRightIcon className="size-3.5" />
      </FileSurfaceAction>
    </span>
  );
}

export function TiffPreviewSummary(props: {
  readonly info: TiffPreviewInfo;
  readonly preview: TiffPreviewState;
}) {
  const { info, preview } = props;
  const size = `${info.width.toLocaleString()} × ${info.height.toLocaleString()}`;
  // Labels name the plane on screen; buttons step from the plane last asked for.
  const shown = tiffAxisSteps(info.plane, info.axes);
  const requested = tiffAxisSteps(preview.requestedPlane, info.axes);
  const pageDigits = String(info.planes).length;
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 tabular-nums">
      {info.scale < 1 ? (
        <Tooltip>
          <TooltipTrigger render={<span>{size}</span>} />
          <TooltipPopup>Previewed at 1/{Math.round(1 / info.scale)} resolution</TooltipPopup>
        </Tooltip>
      ) : (
        <span>{size}</span>
      )}
      <span aria-hidden>·</span>
      <span>{depth(info)}</span>
      {info.range ? (
        <>
          <span aria-hidden>·</span>
          {/* Reserved for the widest range of this sample type, so stepping never rewraps. */}
          <span className="inline-block" style={{ minWidth: `${tiffRangeWidth(info)}ch` }}>
            <Tooltip>
              <TooltipTrigger render={<span>{tiffRangeText(info.range, info.format)}</span>} />
              <TooltipPopup>
                {info.display
                  ? `Values in this plane. Shown with automatic contrast from ${formatTiffValue(info.display[0], info.format)} to ${formatTiffValue(info.display[1], info.format)}.`
                  : "Values in this plane."}
              </TooltipPopup>
            </Tooltip>
          </span>
        </>
      ) : null}
      {shown.length
        ? shown.map((axis, position) => {
            const current = requested[position]!;
            const digits = String(axis.size).length;
            return (
              <Stepper
                key={axis.name}
                label={`${axis.name} ${axis.index + 1}/${axis.size}`}
                width={3 + 2 * digits}
                name={AXIS_NAMES[axis.name]}
                atStart={current.index === 0}
                atEnd={current.index === axis.size - 1}
                onStep={(delta) => preview.step(delta * axis.stride)}
              />
            );
          })
        : info.planes > 1 && (
            <Stepper
              label={`Page ${info.plane + 1} of ${info.planes}`}
              width={9 + 2 * pageDigits}
              name="page"
              atStart={preview.requestedPlane === 0}
              atEnd={preview.requestedPlane >= info.planes - 1}
              onStep={(delta) => preview.step(delta)}
            />
          )}
    </span>
  );
}
