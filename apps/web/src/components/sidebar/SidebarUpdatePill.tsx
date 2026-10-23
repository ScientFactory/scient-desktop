import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { DownloadIcon, LoaderCircleIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { type ComponentProps, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useScientDownloadProgress } from "../../hooks/useScientDownloadProgress";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadedVersion,
  getScientDesktopUpdateLabel,
  getDesktopUpdateIdleTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
// SCIENT-FORK:START — a finished download offers Restart in place, with one install owner.
import {
  installDesktopUpdateNow,
  type ScientUpdateReadyNoticeHandle,
  showScientUpdateReadyNotice,
} from "../../scient/desktopUpdate/updateReadyNotice";
// SCIENT-FORK:END
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DesktopUpdateStatusIcon,
  type DesktopUpdateStatusIconState,
  shouldContinueDesktopUpdateCheckAnimation,
  shouldShowDesktopUpdateCheckIcon,
} from "./DesktopUpdateStatusIcon";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";
import type { UpdateEverythingRun } from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  useUpdateEverythingRun,
} from "./updateEverythingRun";
import { type ReportLocalUpdateError, useUpdateEverything } from "./useUpdateEverything";
// SCIENT-FORK:START — explicit Restart does not acquire another confirmation.
import { shouldRunUpdateEverything } from "./updateEverything.logic";
// SCIENT-FORK:END
// SCIENT-FORK:START — other machines and providers have their own circle beside the pill.
import { isUpdateRunActive } from "../../scient/desktopUpdate/otherUpdates.logic";
import { SidebarOtherUpdates } from "../../scient/desktopUpdate/SidebarOtherUpdates";
import type { ServerUpdateTarget } from "../ServerUpdateAction";
// SCIENT-FORK:END
// SCIENT-FORK:START — a pass's restart countdown sits above the Restart pill, which restarts now.
import { UpdateRestartCountdown } from "../../scient/desktopUpdate/UpdateRestartCountdown";
import { restartUpdateNow } from "./updateEverythingRun";
// SCIENT-FORK:END
// SCIENT-FORK:START — replaces upstream's UpdateEverythingDialog: a pass asks beside the pill,
// and only when it would stop running threads.
import { UpdateEverythingAsk } from "../../scient/desktopUpdate/UpdateEverythingAsk";
import { confirmServerStops } from "../../scient/desktopUpdate/useOtherUpdates";
// SCIENT-FORK:END

type SidebarUpdatePopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];
type SidebarUpdatePopoverHandle = ReturnType<typeof PopoverCreateHandle>;

function shouldUseSidebarUpdateReleaseNotesPopover(
  showUpdateDetails: boolean,
  state: DesktopUpdateState | null,
): boolean {
  return (
    showUpdateDetails &&
    (state?.channel === "beta" || state?.channel === "nightly") &&
    state.releaseNotes.length > 0
  );
}

export function shouldShowSidebarUpdateRestartIcon(state: DesktopUpdateState | null): boolean {
  return state?.status === "error" && state.errorContext === "install";
}

function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: Pick<SidebarUpdatePopoverChangeDetails, "reason" | "cancel">,
): void {
  if (details.reason === "trigger-press") details.cancel();
}

function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
  event: { readonly key: string; readonly shiftKey: boolean },
  handle: Pick<SidebarUpdatePopoverHandle, "open">,
  triggerId: string,
): void {
  if (event.key !== "Tab" || event.shiftKey) return;
  // Hover-open popovers do not manage focus. Promote this one before native Tab runs.
  flushSync(() => handle.open(triggerId));
}

function resolveSidebarUpdatePresentation({
  action,
  showsEverything,
  run,
  isDownloading,
  showCheckIcon,
}: {
  readonly action: ReturnType<typeof resolveDesktopUpdateButtonAction>;
  readonly showsEverything: boolean;
  readonly run: UpdateEverythingRun | null;
  readonly isDownloading: boolean;
  readonly showCheckIcon: boolean;
}) {
  const showUpdateDetails = action !== "none" || showsEverything || run !== null || isDownloading;
  const iconStatus: DesktopUpdateStatusIconState = showCheckIcon
    ? "checking"
    : isDownloading
      ? "downloading"
      : run !== null
        ? run.localVersion !== null && action === "install"
          ? "downloaded"
          : "everything"
        : showsEverything
          ? "everything"
          : action === "install"
            ? "downloaded"
            : action === "download"
              ? "available"
              : "idle";

  return {
    iconStatus,
    showUpdateDetails,
    showUpdateIconState: showUpdateDetails && !showCheckIcon,
  } as const;
}

export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const state = useDesktopUpdateState();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description = state && visible ? getArm64IntelBuildWarningDescription(state) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

const toastUpdateError: ReportLocalUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

async function downloadLocalUpdate(
  bridge: DesktopBridge,
  {
    // SCIENT-FORK:START — a finished download offers Restart in place (see handleAction).
    onDownloaded,
    // SCIENT-FORK:END
    reportError = toastUpdateError,
  }: {
    readonly onDownloaded?: (state: DesktopUpdateState) => void;
    readonly reportError?: ReportLocalUpdateError;
  } = {},
): Promise<boolean> {
  try {
    const result = await bridge.downloadUpdate();
    if (result.completed) onDownloaded?.(result.state);
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? getDesktopUpdateActionError(result)
      : null;
    if (actionError) reportError("Could not download update", actionError);
    return result.completed;
  } catch (error) {
    reportError(
      "Could not start update download",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return false;
  }
}

export function SidebarUpdatePill() {
  return <SidebarUpdateControl />;
}

function SidebarUpdateControl() {
  const state = useDesktopUpdateState();
  const [isActionPending, setIsActionPending] = useState(false);
  // SCIENT-FORK:START — replaces upstream's dialog open state: the pass waiting on its
  // question, with what it stops and what it admits.
  const [askingPass, setAskingPass] = useState<ReturnType<typeof confirmServerStops> | null>(null);
  // SCIENT-FORK:END
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();
  // SCIENT-FORK:START — one ready notice and install owner, anchored to this control.
  const updateReadyNoticeRef = useRef<ScientUpdateReadyNoticeHandle | null>(null);
  useEffect(() => () => updateReadyNoticeRef.current?.close(), []);
  // Resolves true when the app is relaunching; a bulk pass passes `reportError` for its summary.
  const installFromFooter = (
    bridge: NonNullable<typeof window.desktopBridge>,
    reportError?: ReportLocalUpdateError,
  ) => {
    updateReadyNoticeRef.current?.close();
    setIsActionPending(true);
    return installDesktopUpdateNow(bridge, reportError).finally(() => setIsActionPending(false));
  };
  // SCIENT-FORK:END
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const displayedDownloadPercent = useScientDownloadProgress({
    status: state?.status,
    version: state?.availableVersion,
    percent: state?.downloadPercent ?? null,
    reducedMotion: prefersReducedMotion,
  });

  const updateStatus = state?.status;
  const [isCheckAnimationLatched, setIsCheckAnimationLatched] = useState(
    () => !prefersReducedMotion && updateStatus === "checking",
  );
  const [latchInputs, setLatchInputs] = useState({ prefersReducedMotion, updateStatus });
  if (
    latchInputs.prefersReducedMotion !== prefersReducedMotion ||
    latchInputs.updateStatus !== updateStatus
  ) {
    setLatchInputs({ prefersReducedMotion, updateStatus });
    if (prefersReducedMotion) {
      setIsCheckAnimationLatched(false);
    } else if (updateStatus === "checking") {
      setIsCheckAnimationLatched(true);
    }
  }

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const isDownloading = state?.status === "downloading";
  const localUpdateVersion =
    state && action !== "none" ? getDesktopUpdateDownloadedVersion(state) : null;
  const everything = useUpdateEverything(localUpdateVersion);
  // SCIENT-FORK:START — the pill is this app's own update. Other updates join it only in a pass
  // that downloads this app, never in a running one, and only such a pass holds the pill.
  const run = useUpdateEverythingRun();
  const runsEverything = shouldRunUpdateEverything(
    everything.hasUpdates && !isUpdateRunActive(run),
    isDownloading,
    action,
  );
  const isRunningEverything = run !== null && run.localVersion !== null;
  // The question lasts only while Update would still run the pass; the next press asks again.
  if (!runsEverything && askingPass !== null) setAskingPass(null);
  // SCIENT-FORK:END
  const showCheckIcon = shouldShowDesktopUpdateCheckIcon({
    isAnimationLatched: isCheckAnimationLatched,
    isChecking: state?.status === "checking",
    prefersReducedMotion,
  });
  const { iconStatus, showUpdateDetails, showUpdateIconState } = resolveSidebarUpdatePresentation({
    action,
    // SCIENT-FORK:START — the pill presents this app's own update state only.
    showsEverything: false,
    run: null,
    // SCIENT-FORK:END
    isDownloading,
    showCheckIcon,
  });
  const idleTooltip =
    !showUpdateDetails && !showCheckIcon ? getDesktopUpdateIdleTooltip(state) : null;
  const tooltip = runsEverything
    ? everything.summary
    : showUpdateDetails
      ? state
        ? getDesktopUpdateButtonTooltip(state)
        : "Update available"
      : showCheckIcon
        ? "Checking for updates…"
        : (idleTooltip?.title ?? "Check for updates");
  const disabled = showCheckIcon
    ? true
    : runsEverything
      ? false
      : showUpdateDetails
        ? isDesktopUpdateButtonDisabled(state)
        : !canCheckForUpdate(state);
  // SCIENT-FORK:START — under a pass's restart countdown, the Restart pill restarts now.
  const isInteractionDisabled =
    run?.phase !== "countdown" && (disabled || isActionPending || isRunningEverything);
  // SCIENT-FORK:END
  const showReleaseNotesPopover =
    !isRunningEverything && shouldUseSidebarUpdateReleaseNotesPopover(showUpdateDetails, state);

  useEffect(() => {
    if (!showReleaseNotesPopover) {
      releaseNotesPopoverHandle.close();
      return;
    }

    const trigger = document.getElementById(releaseNotesTriggerId);
    if (trigger?.matches(":focus-visible")) {
      releaseNotesPopoverHandle.open(releaseNotesTriggerId);
    }
  }, [releaseNotesPopoverHandle, releaseNotesTriggerId, showReleaseNotesPopover]);

  const handleAction = async () => {
    const bridge = window.desktopBridge;
    // SCIENT-FORK:START — under a pass's restart countdown, the Restart pill restarts now.
    if (run?.phase === "countdown") {
      restartUpdateNow();
      return;
    }
    // SCIENT-FORK:END
    if (isInteractionDisabled) return;

    if (runsEverything) {
      // SCIENT-FORK:START — ask only when the pass would stop running threads elsewhere. This
      // app's own restart keeps its countdown with Later. Pressing the pill again cancels.
      if (askingPass !== null) {
        setAskingPass(null);
        return;
      }
      const pass = confirmServerStops(everything.otherServers.map((server) => server.target));
      if (pass.stops === 0) {
        void runEverything(pass.admitServer);
      } else {
        releaseNotesPopoverHandle.close();
        setAskingPass(pass);
      }
      // SCIENT-FORK:END
      return;
    }

    if (!bridge || !state) return;
    setIsActionPending(true);

    if (action === "download") {
      void downloadLocalUpdate(bridge, {
        onDownloaded: (downloadedState) => {
          // SCIENT-FORK:START — offer Restart next to the button that started the download.
          // The release-notes popover shares this anchor and would cover the notice.
          // Closing it returns focus to the button only when focus is on the page body or
          // inside the popover; suppress that one reopen, never a later deliberate focus.
          if (releaseNotesPopoverHandle.isOpen) {
            const active = document.activeElement;
            if (
              active === null ||
              active === document.body ||
              releaseNotesPopupRef.current?.contains(active)
            ) {
              suppressReleaseNotesFocusOpen.current = true;
              window.setTimeout(() => {
                suppressReleaseNotesFocusOpen.current = false;
              }, 1_000);
            }
            releaseNotesPopoverHandle.close();
          }
          updateReadyNoticeRef.current?.close();
          updateReadyNoticeRef.current = showScientUpdateReadyNotice({
            shell: bridge,
            state: downloadedState,
            anchor: document.getElementById(releaseNotesTriggerId),
            install: () => installFromFooter(bridge),
          });
          // SCIENT-FORK:END
        },
      }).finally(() => setIsActionPending(false));
      return;
    }

    if (action === "install") {
      // SCIENT-FORK:START — Restart is explicit; no second confirmation. A running pass for
      // other machines is saved first, so its summary and restarting servers follow the relaunch.
      if (isUpdateRunActive(run)) {
        saveUpdateEverythingResult({
          localVersion: localUpdateVersion,
          updatedServers: 0,
          updatedProviders: 0,
          failures: [],
          restarting: [],
        });
        void installFromFooter(bridge).then((installed) => {
          if (!installed) clearSavedUpdateEverythingResult();
        });
      } else {
        void installFromFooter(bridge);
      }
      // SCIENT-FORK:END
      return;
    }

    if (!prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (result.checked) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          }),
        );
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      })
      .finally(() => setIsActionPending(false));
  };

  // SCIENT-FORK:START — servers restart only while they stop no more threads than agreed.
  const runEverything = async (admitServer: (target: ServerUpdateTarget) => boolean) => {
    const bridge = window.desktopBridge;
    setAskingPass(null);
    // SCIENT-FORK:END
    setIsActionPending(true);
    const result = await settlePromise(() =>
      everything.run({
        ...(bridge && action === "download"
          ? { downloadLocal: (reportError) => downloadLocalUpdate(bridge, { reportError }) }
          : {}),
        // SCIENT-FORK:START — bulk and explicit Restart share the existing installer.
        ...(bridge && action !== "none"
          ? { installLocal: (reportError) => installFromFooter(bridge, reportError) }
          : {}),
        admitServer,
        // SCIENT-FORK:END
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update everything",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    }
    setIsActionPending(false);
  };

  const handleCheckAnimationIteration = () => {
    setIsCheckAnimationLatched(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: state?.status === "checking",
        prefersReducedMotion,
      }),
    );
  };

  // SCIENT-FORK:START — compact labels for this app's own update. Other machines and providers
  // have their own circle, which is all a browser shows.
  const updateLabel =
    showUpdateIconState && state
      ? getScientDesktopUpdateLabel({ ...state, downloadPercent: displayedDownloadPercent })
      : null;
  const updateOthers = (admitServer: (target: ServerUpdateTarget) => boolean) =>
    everything.run({ admitServer });
  if (!isElectron) {
    return (
      <SidebarOtherUpdates servers={everything.otherServers} standalone updateAll={updateOthers} />
    );
  }
  // SCIENT-FORK:END

  const statusIcon = (
    <DesktopUpdateStatusIcon
      key={showCheckIcon ? checkAnimationKey : iconStatus}
      // SCIENT-FORK: smoothed download progress, shared with the label.
      downloadPercent={displayedDownloadPercent}
      isCheckAnimating={showCheckIcon && !prefersReducedMotion}
      onCheckAnimationIteration={handleCheckAnimationIteration}
      status={iconStatus}
    />
  );
  const updateButton = (
    <button
      type="button"
      aria-label={
        isDownloading && updateLabel
          ? `Downloading update (${updateLabel})`
          : updateLabel
            ? `${updateLabel}: ${tooltip}`
            : tooltip
      }
      aria-disabled={isInteractionDisabled || undefined}
      className={cn(
        "inline-flex items-center justify-center outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
        isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer",
        showUpdateIconState
          ? cn(
              // SCIENT-FORK: lab-verified compact pill dimensions, type and spacing.
              "h-5 rounded-(--control-radius) bg-primary text-2xs font-medium whitespace-nowrap text-primary-foreground",
              "w-16 gap-0.5 px-0.5",
              !isInteractionDisabled && "hover:bg-primary/90",
            )
          : cn(
              // SCIENT-FORK: idle circle 32px -> 20px to match the pill.
              "size-5 rounded-full text-(--sidebar-icon-color)",
              !isInteractionDisabled && "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            ),
        disabled && !showUpdateIconState && "opacity-60",
      )}
      onClick={handleAction}
      onBlur={() => {
        suppressReleaseNotesFocusOpen.current = false;
      }}
      onFocus={(event) => {
        if (!showReleaseNotesPopover || !event.currentTarget.matches(":focus-visible")) return;
        if (suppressReleaseNotesFocusOpen.current) {
          suppressReleaseNotesFocusOpen.current = false;
          return;
        }
        flushSync(() => releaseNotesPopoverHandle.open(releaseNotesTriggerId));
      }}
      onKeyDown={(event) => {
        if (!showReleaseNotesPopover) return;
        openSidebarUpdateReleaseNotesPopoverOnForwardTab(
          event,
          releaseNotesPopoverHandle,
          releaseNotesTriggerId,
        );
      }}
    >
      {iconStatus === "available" ? (
        <DownloadIcon aria-hidden="true" className="size-[13px] shrink-0" strokeWidth={2.25} />
      ) : iconStatus === "downloaded" ? (
        // SCIENT-FORK: the clean ready-to-restart state is text-only, but the
        // install-retry state (status "error" + errorContext "install") shares
        // the "downloaded" iconStatus, so it keeps its restart icon.
        shouldShowSidebarUpdateRestartIcon(state) ? (
          <RotateCwIcon aria-hidden="true" className="size-[13px] shrink-0" strokeWidth={2.25} />
        ) : null
      ) : iconStatus === "downloading" && (state?.downloadPercent ?? 0) <= 0 ? (
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-[13px] shrink-0 animate-spin motion-reduce:animate-none"
          strokeWidth={2.25}
        />
      ) : (
        <span
          className={cn(
            "flex shrink-0 items-center justify-center",
            iconStatus === "downloading" &&
              // SCIENT-FORK: ring visual diameter 24px -> ~17px.
              "size-[17px] [&>span]:shrink-0 [&>span]:scale-[0.53] [&_circle]:transition-none",
          )}
        >
          {statusIcon}
        </span>
      )}
      {updateLabel ? (
        // SCIENT-FORK: label weight 650 (variable-font axis; font-medium is 500).
        <span className="tabular-nums" style={{ fontVariationSettings: '"wght" 650' }}>
          {updateLabel}
        </span>
      ) : null}
    </button>
  );

  return (
    <SidebarMenuItem
      // SCIENT-FORK:START — the circle for other machines and providers sits beside the pill.
      className="ml-auto flex shrink-0 items-center"
      // SCIENT-FORK:END
      data-update-active={showUpdateDetails || undefined}
    >
      {/* SCIENT-FORK:START */}
      <SidebarOtherUpdates servers={everything.otherServers} updateAll={updateOthers} />
      {/* SCIENT-FORK:END */}
      <Popover
        handle={releaseNotesPopoverHandle}
        onOpenChange={(open, details) => {
          if (open && !showReleaseNotesPopover) {
            details.cancel();
            return;
          }
          handleSidebarUpdateReleaseNotesPopoverOpenChange(open, details);
        }}
      >
        <Tooltip disabled={showReleaseNotesPopover}>
          <TooltipTrigger
            id={releaseNotesTriggerId}
            render={
              <PopoverTrigger
                {...(!showReleaseNotesPopover
                  ? {
                      "aria-controls": undefined,
                      "aria-expanded": undefined,
                      "aria-haspopup": undefined,
                    }
                  : {})}
                closeDelay={150}
                handle={releaseNotesPopoverHandle}
                id={releaseNotesTriggerId}
                openOnHover={showReleaseNotesPopover}
                render={updateButton}
              />
            }
          />
          {!showReleaseNotesPopover ? (
            <TooltipPopup
              align="center"
              className={showUpdateDetails ? "max-w-48 text-left" : undefined}
              side="top"
              variant={showUpdateDetails ? "glass" : "default"}
            >
              {idleTooltip?.detail ? (
                <div className="text-left">
                  <div className="font-medium">{idleTooltip.title}</div>
                  <div className="text-muted-foreground">{idleTooltip.detail}</div>
                </div>
              ) : (
                <span className="whitespace-pre-line">{tooltip}</span>
              )}
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {showReleaseNotesPopover && state ? (
          <PopoverPopup
            align="center"
            aria-label={`${state.channel === "beta" ? "Beta" : "Nightly"} update release notes`}
            initialFocus={false}
            onKeyDownCapture={(event) => {
              if (
                event.key === "Escape" &&
                releaseNotesPopupRef.current?.contains(document.activeElement)
              ) {
                suppressReleaseNotesFocusOpen.current = true;
              }
            }}
            ref={releaseNotesPopupRef}
            side="top"
            tooltipStyle
          >
            <SidebarUpdateReleaseNotes
              shell={window.desktopBridge}
              state={state}
              tooltip={tooltip}
            />
          </PopoverPopup>
        ) : null}
      </Popover>
      {/* SCIENT-FORK:START — replaces upstream's confirmation dialog mount. */}
      <UpdateEverythingAsk
        anchorId={releaseNotesTriggerId}
        stops={askingPass?.stops ?? null}
        onCancel={() => setAskingPass(null)}
        onUpdate={() => {
          if (askingPass !== null) void runEverything(askingPass.admitServer);
        }}
      />
      <UpdateRestartCountdown anchorId={releaseNotesTriggerId} run={run} />
      {/* SCIENT-FORK:END */}
    </SidebarMenuItem>
  );
}
