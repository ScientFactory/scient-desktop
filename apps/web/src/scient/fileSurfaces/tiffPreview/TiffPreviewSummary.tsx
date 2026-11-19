import { msg, T, useGT, useMessages, Var } from "gt-react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { FileSurfaceAction } from "~/components/files/fileSurfaceChrome";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { MessageResolver } from "~/i18n/messages";

import type { TiffAxisName, TiffPreviewInfo } from "./tiffPreview";
import { formatTiffValue, tiffAxisSteps, tiffRangeText, tiffRangeWidth } from "./tiffPreviewText";
import type { TiffPreviewState } from "./useTiffPreview";

function depth(info: TiffPreviewInfo, resolve: MessageResolver) {
  if (info.format === "float") return resolve(msg("{bits}-bit float", { bits: info.bits }));
  return info.format === "int"
    ? resolve(msg("{bits}-bit signed", { bits: info.bits }))
    : resolve(msg("{bits}-bit", { bits: info.bits }));
}

type StepLabels = { readonly previous: string; readonly next: string };

const AXIS_STEP_LABELS: Readonly<Record<TiffAxisName | "page", StepLabels>> = {
  C: { previous: msg("Previous channel"), next: msg("Next channel") },
  Z: { previous: msg("Previous Z slice"), next: msg("Next Z slice") },
  T: { previous: msg("Previous time point"), next: msg("Next time point") },
  page: { previous: msg("Previous page"), next: msg("Next page") },
};

function Stepper(props: {
  readonly label: string;
  readonly width: number;
  readonly steps: StepLabels;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly onStep: (delta: -1 | 1) => void;
}) {
  const m = useMessages();
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
        label={m(props.steps.previous)}
        disabled={props.atStart}
        onPress={() => props.onStep(-1)}
      >
        <ChevronLeftIcon className="size-3.5" />
      </FileSurfaceAction>
      <FileSurfaceAction
        label={m(props.steps.next)}
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
  const gt = useGT();
  const m = useMessages();
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
          <TooltipPopup>
            <T>
              Previewed at 1/<Var>{Math.round(1 / info.scale)}</Var> resolution
            </T>
          </TooltipPopup>
        </Tooltip>
      ) : (
        <span>{size}</span>
      )}
      <span aria-hidden>·</span>
      <span>{depth(info, m)}</span>
      {info.range ? (
        <>
          <span aria-hidden>·</span>
          {/* Reserved for the widest range of this sample type, so stepping never rewraps. */}
          <span className="inline-block" style={{ minWidth: `${tiffRangeWidth(info)}ch` }}>
            <Tooltip>
              <TooltipTrigger render={<span>{tiffRangeText(info.range, info.format)}</span>} />
              <TooltipPopup>
                {info.display
                  ? gt(
                      "Values in this plane. Shown with automatic contrast from {low} to {high}.",
                      {
                        low: formatTiffValue(info.display[0], info.format),
                        high: formatTiffValue(info.display[1], info.format),
                      },
                    )
                  : gt("Values in this plane.")}
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
                steps={AXIS_STEP_LABELS[axis.name]}
                atStart={current.index === 0}
                atEnd={current.index === axis.size - 1}
                onStep={(delta) => preview.step(delta * axis.stride)}
              />
            );
          })
        : info.planes > 1 && (
            <Stepper
              label={gt("Page {page} of {pages}", { page: info.plane + 1, pages: info.planes })}
              width={9 + 2 * pageDigits}
              steps={AXIS_STEP_LABELS.page}
              atStart={preview.requestedPlane === 0}
              atEnd={preview.requestedPlane >= info.planes - 1}
              onStep={(delta) => preview.step(delta)}
            />
          )}
    </span>
  );
}
