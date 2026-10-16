import { useAtomValue } from "@effect/atom-react";
import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { DownloadIcon, LoaderCircleIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useScientDownloadProgress } from "../../hooks/useScientDownloadProgress";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { serverEnvironment } from "../../state/server";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadedVersion,
  getScientDesktopUpdateLabel,
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
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import {
  describeUpdateRun,
  resolveUpdateRunMachineStatus,
  type UpdateEverythingRun,
} from "./updateEverything.logic";
import { useUpdateEverythingRun } from "./updateEverythingRun";
import { type ReportLocalUpdateError, useUpdateEverything } from "./useUpdateEverything";
// SCIENT-FORK:START — explicit Restart does not acquire another confirmation.
import { shouldRunUpdateEverything } from "./updateEverything.logic";
// SCIENT-FORK:END

type SidebarUpdatePopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];
type SidebarUpdatePopoverHandle = ReturnType<typeof PopoverCreateHandle>;

export function shouldUseSidebarUpdateReleaseNotesPopover(
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

export function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: Pick<SidebarUpdatePopoverChangeDetails, "reason" | "cancel">,
): void {
  // The trigger is the update action, so its presses must not also toggle the Popover.
  if (details.reason === "trigger-press") details.cancel();
}

export function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
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
  /** Remote work is waiting, and this app is not downloading. */
  readonly showsEverything: boolean;
  /** The running "update everything" pass. Its state sets the icon. */
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

/** Downloads this app's update. Resolves true when it is ready to install;
    failures go to `reportError` (a toast by default) and resolve false. */
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

/** Tooltip lines for a running pass: this app first, then one per machine. */
function useUpdateRunTooltip(
  run: UpdateEverythingRun | null,
  state: DesktopUpdateState | null,
  localReady: boolean,
): string | null {
  const statusesAtom = useMemo(
    () =>
      Atom.make((get) =>
        run === null
          ? []
          : run.machines.map((machine) => ({
              label: machine.label,
              status: resolveUpdateRunMachineStatus(
                machine,
                run.phase,
                get(serverEnvironment.updateStateAtom(machine.environmentId)),
              ),
            })),
      ),
    [run],
  );
  const statuses = useAtomValue(statusesAtom);
  if (run === null) return null;
  const local =
    run.localVersion === null
      ? null
      : state?.status === "downloading"
        ? `downloading${state.downloadPercent === null ? "" : ` ${Math.floor(state.downloadPercent)}%`}`
        : run.phase === "installing"
          ? "restarting"
          : localReady
            ? "restarts last"
            : "waiting";
  return describeUpdateRun(statuses, local).join("\n");
}

/**
 * The sidebar update button. With only a local app update it downloads, then
 * installs. When other machines' servers or any providers are behind, one
 * click updates everything: providers, then servers, then this app last. On
 * web there is no local app, so the button shows only for remote updates.
 */
export function SidebarUpdatePill() {
  return <SidebarUpdateControl />;
}

function SidebarUpdateControl() {
  const state = useDesktopUpdateState();
  const [isActionPending, setIsActionPending] = useState(false);
  const [isConfirmingEverything, setIsConfirmingEverything] = useState(false);
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const [isCheckAnimationLatched, setIsCheckAnimationLatched] = useState(false);
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();
  // SCIENT-FORK:START — one ready notice and install owner, anchored to this control.
  const updateReadyNoticeRef = useRef<ScientUpdateReadyNoticeHandle | null>(null);
  useEffect(() => () => updateReadyNoticeRef.current?.close(), []);
  // Resolves true when the app is relaunching; a bulk pass passes `reportError` for its summary.
  const installFromFooter = useCallback(
    (bridge: NonNullable<typeof window.desktopBridge>, reportError?: ReportLocalUpdateError) => {
      updateReadyNoticeRef.current?.close();
      setIsActionPending(true);
      return installDesktopUpdateNow(bridge, reportError).finally(() => setIsActionPending(false));
    },
    [],
  );
  // SCIENT-FORK:END
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const displayedDownloadPercent = useScientDownloadProgress({
    status: state?.status,
    version: state?.availableVersion,
    percent: state?.downloadPercent ?? null,
    reducedMotion: prefersReducedMotion,
  });

  useEffect(() => {
    if (prefersReducedMotion) {
      setIsCheckAnimationLatched(false);
    } else if (state?.status === "checking") {
      setIsCheckAnimationLatched(true);
    }
  }, [prefersReducedMotion, state?.status]);

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const isDownloading = state?.status === "downloading";
  // Remote servers follow this app to the version it is about to install.
  const localUpdateVersion =
    state && action !== "none" ? getDesktopUpdateDownloadedVersion(state) : null;
  const everything = useUpdateEverything(localUpdateVersion);
  const runsEverything = shouldRunUpdateEverything(everything.hasUpdates, isDownloading, action);
  // Providers leave the list once queued, so the run keeps its own state.
  const run = useUpdateEverythingRun();
  const isRunningEverything = run !== null;
  const runTooltip = useUpdateRunTooltip(run, state, action === "install");
  const showCheckIcon = shouldShowDesktopUpdateCheckIcon({
    isAnimationLatched: isCheckAnimationLatched,
    isChecking: state?.status === "checking",
    prefersReducedMotion,
  });
  const { iconStatus, showUpdateDetails, showUpdateIconState } = resolveSidebarUpdatePresentation({
    action,
    showsEverything: runsEverything,
    run,
    isDownloading,
    showCheckIcon,
  });
  const tooltip =
    runTooltip !== null
      ? runTooltip
      : runsEverything
        ? everything.summary
        : showUpdateDetails
          ? state
            ? getDesktopUpdateButtonTooltip(state)
            : "Update available"
          : showCheckIcon
            ? "Checking for updates…"
            : "Check for updates";
  const disabled = showCheckIcon
    ? true
    : runsEverything
      ? false
      : showUpdateDetails
        ? isDesktopUpdateButtonDisabled(state)
        : !canCheckForUpdate(state);
  const isInteractionDisabled = disabled || isActionPending || isRunningEverything;
  // During a run the tooltip shows its progress instead of release notes.
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

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (isInteractionDisabled) return;

    if (runsEverything) {
      setIsConfirmingEverything(true);
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
      // SCIENT-FORK:START — Restart is explicit; no second confirmation.
      void installFromFooter(bridge);
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
  }, [
    action,
    installFromFooter,
    isInteractionDisabled,
    prefersReducedMotion,
    releaseNotesPopoverHandle,
    releaseNotesTriggerId,
    runsEverything,
    state,
  ]);

  const runEverything = useCallback(async () => {
    const bridge = window.desktopBridge;
    setIsConfirmingEverything(false);
    setIsActionPending(true);
    try {
      await everything.run({
        ...(bridge && action === "download"
          ? { downloadLocal: (reportError) => downloadLocalUpdate(bridge, { reportError }) }
          : {}),
        // SCIENT-FORK:START — bulk and explicit Restart share the existing installer.
        ...(bridge && action !== "none"
          ? { installLocal: (reportError) => installFromFooter(bridge, reportError) }
          : {}),
        // SCIENT-FORK:END
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update everything",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    } finally {
      setIsActionPending(false);
    }
  }, [action, everything, installFromFooter]);

  const handleCheckAnimationIteration = useCallback(() => {
    setIsCheckAnimationLatched(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: state?.status === "checking",
        prefersReducedMotion,
      }),
    );
  }, [prefersReducedMotion, state?.status]);

  // SCIENT-FORK:START — compact labels; remote orchestration preserves local updater state.
  // This app's own download keeps its progress label during a pass.
  const showsRunLabel = isRunningEverything && !isDownloading;
  const updateLabel = showsRunLabel
    ? "Updating"
    : runsEverything
      ? "Update"
      : showUpdateIconState && state
        ? getScientDesktopUpdateLabel({ ...state, downloadPercent: displayedDownloadPercent })
        : null;
  // The shared "Update"/"Updating" labels size the pill, whatever icon a pass shows.
  const sizesToLabel = showsRunLabel || iconStatus === "everything";
  // SCIENT-FORK:END
  // Web has no local app to check; only eligible remote work exposes the action.
  if (!isElectron && !runsEverything && !isRunningEverything) return null;

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
              // This app's states fit the fixed width; "Update"/"Updating" for other
              // machines and providers grow to their label with even insets.
              sizesToLabel ? "min-w-16 gap-1 px-1.5" : "w-16 gap-0.5 px-0.5",
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
          <DesktopUpdateStatusIcon
            key={showCheckIcon ? checkAnimationKey : iconStatus}
            downloadPercent={displayedDownloadPercent}
            isCheckAnimating={showCheckIcon && !prefersReducedMotion}
            onCheckAnimationIteration={handleCheckAnimationIteration}
            status={iconStatus}
          />
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
      className="ml-auto shrink-0"
      data-update-active={showUpdateDetails || undefined}
    >
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
              <span className={cn("whitespace-pre-line", showUpdateDetails && "text-wrap")}>
                {tooltip}
              </span>
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
      <UpdateEverythingDialog
        open={isConfirmingEverything}
        onOpenChange={setIsConfirmingEverything}
        summary={everything.summary}
        lines={everything.lines}
        restarts={everything.restarts}
        skipped={everything.skipped}
        onConfirm={() => void runEverything()}
      />
    </SidebarMenuItem>
  );
}
