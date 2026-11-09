import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { FileSurfaceAction } from "~/components/files/fileSurfaceChrome";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { tiffPlaneLabel, type TiffPreviewInfo } from "./tiffPreview";
import type { TiffPreviewState } from "./useTiffPreview";

function formatTiffValue(value: number, format: TiffPreviewInfo["format"]) {
  const text = (
    format === "float" ? Number(value.toPrecision(4)) : Math.round(value)
  ).toLocaleString(undefined, { maximumFractionDigits: 6 });
  return text.replace(/^-/u, "−");
}

function depth(info: TiffPreviewInfo) {
  if (info.format === "float") return `${info.bits}-bit float`;
  return info.format === "int" ? `${info.bits}-bit signed` : `${info.bits}-bit`;
}

export function TiffPreviewSummary(props: {
  readonly info: TiffPreviewInfo;
  readonly preview: TiffPreviewState;
}) {
  const { info, preview } = props;
  const size = `${info.width.toLocaleString()} × ${info.height.toLocaleString()}`;
  const label = tiffPlaneLabel(info);
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
          <Tooltip>
            <TooltipTrigger
              render={
                <span>
                  {formatTiffValue(info.range[0], info.format)}–
                  {formatTiffValue(info.range[1], info.format)}
                </span>
              }
            />
            <TooltipPopup>
              {info.display
                ? `Values in this plane. Shown with automatic contrast from ${formatTiffValue(info.display[0], info.format)} to ${formatTiffValue(info.display[1], info.format)}.`
                : "Values in this plane."}
            </TooltipPopup>
          </Tooltip>
        </>
      ) : null}
      {label ? (
        <span className="flex items-center gap-0.5">
          <FileSurfaceAction
            label="Previous plane"
            disabled={preview.requestedPlane === 0}
            onPress={() => preview.step(-1)}
          >
            <ChevronLeftIcon className="size-3.5" />
          </FileSurfaceAction>
          <span aria-live="polite">{label}</span>
          <FileSurfaceAction
            label="Next plane"
            disabled={preview.requestedPlane >= info.planes - 1}
            onPress={() => preview.step(1)}
          >
            <ChevronRightIcon className="size-3.5" />
          </FileSurfaceAction>
        </span>
      ) : null}
    </span>
  );
}
