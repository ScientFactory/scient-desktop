"use client";

import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CopyIcon, DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { copyStaticImage, downloadStaticImage } from "./staticImageActions";

interface StaticImageActionButtonBaseProps {
  readonly assetUrl: string | null;
  readonly disabled?: boolean;
  readonly threadRef: ScopedThreadRef;
}

type StaticImageActionButtonProps = StaticImageActionButtonBaseProps &
  ({ readonly action: "copy" } | { readonly action: "download"; readonly fileName: string });

function addThreadToast(
  threadRef: ScopedThreadRef,
  toast: Omit<Parameters<typeof stackedThreadToast>[0], "data">,
) {
  toastManager.add(stackedThreadToast({ ...toast, data: { threadRef } }));
}

function StaticImageActionButton(props: StaticImageActionButtonProps) {
  const gt = useGT();
  const [running, setRunning] = useState(false);
  const isCopy = props.action === "copy";
  const idleLabel = isCopy ? gt("Copy image") : gt("Download original");
  const runningLabel = isCopy ? gt("Copying image…") : gt("Preparing download…");

  const runAction = async () => {
    if (running || props.assetUrl === null) return;
    setRunning(true);
    let operationFailure: { error: unknown } | null = null;
    try {
      {
        try {
          if (props.action === "copy") {
            await copyStaticImage(props.assetUrl);
            addThreadToast(props.threadRef, {
              type: "success",
              title: gt("Image copied"),
              timeout: 1_800,
            });
          } else {
            await downloadStaticImage(props.assetUrl, props.fileName);
          }
        } catch (cause) {
          console.error(`[preview] ${isCopy ? "Copy image" : "Download original"} failed`, cause);
          addThreadToast(props.threadRef, {
            type: "error",
            title: isCopy ? gt("Unable to copy image") : gt("Unable to download image"),
            description: cause instanceof Error ? cause.message : gt("The image action failed."),
          });
        }
      }
    } catch (error) {
      operationFailure = { error };
    }

    setRunning(false);

    if (operationFailure !== null) throw operationFailure.error;
  };

  const isDisabled = props.disabled || props.assetUrl === null || running;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={running ? runningLabel : idleLabel}
            disabled={isDisabled}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void runAction();
            }}
            size="icon-xs"
            type="button"
            variant="ghost"
          />
        }
      >
        {running ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : isCopy ? (
          <CopyIcon />
        ) : (
          <DownloadIcon />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{running ? runningLabel : idleLabel}</TooltipPopup>
    </Tooltip>
  );
}

export function StaticImageCopyButton(props: StaticImageActionButtonBaseProps) {
  return <StaticImageActionButton {...props} action="copy" />;
}

export function StaticImageDownloadButton(
  props: StaticImageActionButtonBaseProps & { readonly fileName: string },
) {
  return <StaticImageActionButton {...props} action="download" />;
}
