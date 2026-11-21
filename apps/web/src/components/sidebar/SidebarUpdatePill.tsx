import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { managedUpdatesDenial } from "@t3tools/client-runtime/contract-labels";
import { type DesktopBridge, type DesktopUpdateState } from "@t3tools/contracts";
import { DownloadIcon, LoaderCircleIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { type ComponentProps, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../../env";
import { m } from "../../i18n/messages";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useScientDownloadProgress } from "../../hooks/useScientDownloadProgress";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { usePrimaryManagedPolicy } from "../../state/managedPolicy";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateBackgroundTooltip,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadedVersion,
  getScientDesktopUpdateLabel,
  getDesktopUpdateIdleTooltip,
  isBackgroundDesktopUpdate,
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
import { useCheckProviderUpdates } from "../ProviderUpdatesAction";
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
import { OTHER_UPDATES_TONE } from "../../scient/desktopUpdate/otherUpdatesTone";
import { useRailOtherUpdatesSlot } from "../../scient/sidebar/railOtherUpdatesSlot";
import type { ServerUpdateTarget } from "../ServerUpdateAction";
// SCIENT-FORK:END
// SCIENT-FORK:START — a downloaded update restarts at once only while nothing here is working.
import { useLocalWorkBlocksRestart } from "../../scient/desktopUpdate/restartWhenIdle";
// SCIENT-FORK:END
// SCIENT-FORK:START — replaces upstream's UpdateEverythingDialog: a pass asks beside the pill,
// and only when it would stop running threads.
import { UpdateEverythingAsk } from "../../scient/desktopUpdate/UpdateEverythingAsk";
import { useRestartProgressNotice } from "../../scient/desktopUpdate/useRestartProgressNotice";
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
  // SCIENT-FORK: the release-notes popover stays on prerelease tracks.
  return (
    showUpdateDetails &&
    (state?.channel === "beta" || state?.channel === "nightly") &&
    state.releaseNotes.length > 0
  );
}

// SCIENT-FORK:START — expose the existing restart-icon policy to its restored regression guards.
export function shouldShowSidebarUpdateRestartIcon(state: DesktopUpdateState | null): boolean {
  return state?.status === "error" && state.errorContext === "install";
}
// SCIENT-FORK:END

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
  const messages = useMessages();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description =
    state && visible ? getArm64IntelBuildWarningDescription(state, messages) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>
        <T>Intel build on Apple Silicon</T>
      </AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

const toastUpdateError: ReportLocalUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

export async function downloadLocalUpdate(
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
    if (actionError) reportError(m(msg("Could not download update")), actionError);
    return result.completed;
  } catch (error) {
    reportError(
      m(msg("Could not start update download")),
      thrownErrorMessage(error, m) ?? m(msg("An unexpected error occurred.")),
    );
    return false;
  }
}

// SCIENT-FORK:START — with the icon rail, the header shows this app's update in the brand's place.
interface SidebarUpdatePillProps {
  /**
   * `header` (icon rail): while there is an update to act on, the pill stands in the sidebar header
   * after `activeLeading` (the Scient symbol), in place of the brand name; otherwise the header
   * shows `idleContent`. It has no idle check-for-updates button, its cards open below, and the
   * circle for other updates sits in the rail.
   */
  readonly placement?: "footer" | "header";
  readonly idleContent?: ReactNode;
  readonly activeLeading?: ReactNode;
  /** Over the stage artwork the header pill takes the other-updates blue, which reads there. */
  readonly onStage?: boolean;
}

export function SidebarUpdatePill(props: SidebarUpdatePillProps) {
  return <SidebarUpdateControl {...props} />;
}

function SidebarUpdateControl({
  placement = "footer",
  idleContent = null,
  activeLeading = null,
  onStage = false,
}: SidebarUpdatePillProps) {
  const inHeader = placement === "header";
  // SCIENT-FORK:END
  const state = useDesktopUpdateState();
  const gt = useGT();
  const messages = useMessages();
  // The desktop updates this machine, whose policy the primary environment reports.
  const updatesDenial = managedUpdatesDenial(usePrimaryManagedPolicy(), messages);
  const [isActionPending, setIsActionPending] = useState(false);
  // SCIENT-FORK:START — replaces upstream's dialog open state: the pass waiting on its
  // question, with what it stops and what it admits.
  const [askingPass, setAskingPass] = useState<ReturnType<typeof confirmServerStops> | null>(null);
  // SCIENT-FORK:END
  const [providerCheck, setProviderCheck] = useState<"button" | null>(null);
  const isCheckingProviders = providerCheck === "button";
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();
  // SCIENT-FORK:START — one ready notice and install owner, anchored to this control.
  // Restart progress and the reason a restart stopped show beside it without hover.
  const restartNotice = useRestartProgressNotice(state, releaseNotesTriggerId);
  const updateReadyNoticeRef = useRef<ScientUpdateReadyNoticeHandle | null>(null);
  // The card Update opens stays until Restart or dismissal; a second press closes it.
  const restartCardOpenRef = useRef(false);
  // A download the user started shows its progress; the desktop's own stays behind the idle control.
  const [userStartedDownload, setUserStartedDownload] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the imperative ready notice when its owner unmounts
  useEffect(() => () => updateReadyNoticeRef.current?.close(), []);
  const localWorkBlocksRestart = useLocalWorkBlocksRestart();
  // Resolves true when the app is relaunching; a bulk pass passes `reportError` for its summary.
  // A version installs only that downloaded build, never one that replaced it.
  const installFromFooter = (
    bridge: NonNullable<typeof window.desktopBridge>,
    reportError?: ReportLocalUpdateError,
    expectedVersion?: string | null,
  ) => {
    updateReadyNoticeRef.current?.close();
    setIsActionPending(true);
    return installDesktopUpdateNow(
      bridge,
      reportError ?? restartNotice.reportFailure,
      expectedVersion,
    ).finally(() => setIsActionPending(false));
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

  // SCIENT-FORK:START — the pill is this app's own update. Other updates join it only in a pass
  // that downloads this app, never in a running one, and only such a pass holds the pill.
  const run = useUpdateEverythingRun();
  const isRunningEverything = run !== null && run.localVersion !== null;
  // A download the desktop runs by itself leaves the control idle until the update is ready.
  const backgroundUpdate = isBackgroundDesktopUpdate(
    state,
    userStartedDownload || isRunningEverything,
  );
  const updaterAction = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const action = backgroundUpdate ? "none" : updaterAction;
  const isDownloading = state?.status === "downloading" && !backgroundUpdate;
  const isPreparing = state?.status === "preparing";
  const localUpdateVersion =
    state && updaterAction !== "none" ? getDesktopUpdateDownloadedVersion(state) : null;
  // SCIENT-FORK:END
  const everything = useUpdateEverything(localUpdateVersion);
  const checkProviderUpdates = useCheckProviderUpdates();
  // SCIENT-FORK:START — the icon rail's slot for the other-updates circle.
  const railOtherUpdatesSlot = useRailOtherUpdatesSlot();
  // SCIENT-FORK:END
  // SCIENT-FORK:START
  const runsEverything = shouldRunUpdateEverything(
    everything.hasUpdates && !isUpdateRunActive(run),
    isDownloading,
    action,
  );
  // The question lasts only while Update would still run the pass; the next press asks again.
  if (!runsEverything && askingPass !== null) setAskingPass(null);
  // A card for an update that is no longer ready would offer a refused restart.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the imperative restart card when its update stops being installable
  useEffect(() => {
    if (action !== "install" && restartCardOpenRef.current) updateReadyNoticeRef.current?.close();
  }, [action]);
  // Restart is explicit; no second confirmation. A pass for other machines running when Restart is
  // chosen, even one started after the card opened, is saved first, so its summary and restarting
  // servers follow the relaunch.
  const installLocal = useStableCallback(
    (bridge: NonNullable<typeof window.desktopBridge>, version: string | null) => {
      if (!isUpdateRunActive(run)) return installFromFooter(bridge, undefined, version);
      saveUpdateEverythingResult({
        localVersion: version,
        updatedServers: 0,
        updatedProviders: 0,
        failures: [],
        restarting: [],
      });
      return installFromFooter(bridge, undefined, version).then((installed) => {
        if (!installed) clearSavedUpdateEverythingResult();
        return installed;
      });
    },
  );
  // SCIENT-FORK:END
  const showCheckIcon = shouldShowDesktopUpdateCheckIcon({
    isAnimationLatched: isCheckAnimationLatched,
    isChecking: state?.status === "checking" || isCheckingProviders,
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
    !showUpdateDetails && !showCheckIcon
      ? // SCIENT-FORK: an idle control still says when an update is downloading behind it.
        backgroundUpdate && state && updatesDenial === undefined
        ? { title: getDesktopUpdateBackgroundTooltip(state, messages), detail: null }
        : getDesktopUpdateIdleTooltip(state, updatesDenial, messages)
      : null;
  const tooltip =
    isPreparing && state
      ? getDesktopUpdateButtonTooltip(state, messages)
      : runsEverything
        ? everything.summary
        : showUpdateDetails
          ? state
            ? getDesktopUpdateButtonTooltip(state, messages)
            : gt("Update available")
          : showCheckIcon
            ? gt("Checking for updates…")
            : (idleTooltip?.title ?? gt("Check for updates"));
  const disabled = showCheckIcon
    ? true
    : runsEverything
      ? false
      : showUpdateDetails
        ? isDesktopUpdateButtonDisabled(state)
        : !canCheckForUpdate(state);
  const isInteractionDisabled = isPreparing || disabled || isActionPending || isRunningEverything;
  const showReleaseNotesPopover =
    !restartNotice.open &&
    !isPreparing &&
    !isRunningEverything &&
    shouldUseSidebarUpdateReleaseNotesPopover(showUpdateDetails, state);

  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [releaseNotesTriggerFocusVisible, setReleaseNotesTriggerFocusVisible] = useState(false);
  // Release notes close when they stop applying, and open when they start
  // applying while the trigger already holds keyboard focus.
  const [releaseNotesShownBefore, setReleaseNotesShownBefore] = useState(showReleaseNotesPopover);
  if (releaseNotesShownBefore !== showReleaseNotesPopover) {
    setReleaseNotesShownBefore(showReleaseNotesPopover);
    setReleaseNotesOpen(showReleaseNotesPopover && releaseNotesTriggerFocusVisible);
  }

  const handleAction = async () => {
    const bridge = window.desktopBridge;
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

    if (action === "install" && state.errorContext !== "install") {
      // SCIENT-FORK:START — Update opens the restart card; a second press closes it.
      if (restartCardOpenRef.current) {
        updateReadyNoticeRef.current?.close();
        return;
      }
      releaseNotesPopoverHandle.close();
      updateReadyNoticeRef.current?.close();
      restartCardOpenRef.current = true;
      updateReadyNoticeRef.current = showScientUpdateReadyNotice({
        shell: bridge,
        state,
        anchor: document.getElementById(releaseNotesTriggerId),
        install: (version) => installLocal(bridge, version),
        persistent: true,
        onClose: () => {
          restartCardOpenRef.current = false;
        },
      });
      // SCIENT-FORK:END
      return;
    }

    setIsActionPending(true);

    if (action === "download") {
      // SCIENT-FORK: a download the user started shows its progress in the control.
      setUserStartedDownload(true);
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
          // The finished download offers Restart; restarting stays the user's choice.
          updateReadyNoticeRef.current = showScientUpdateReadyNotice({
            shell: bridge,
            state: downloadedState,
            anchor: document.getElementById(releaseNotesTriggerId),
            install: (version) => installFromFooter(bridge, undefined, version),
          });
          // SCIENT-FORK:END
        },
      }).finally(() => {
        setIsActionPending(false);
        setUserStartedDownload(false);
      });
      return;
    }

    if (action === "install") {
      // SCIENT-FORK: a failed install retries directly.
      void installLocal(bridge, state.downloadedVersion);
      return;
    }

    if (!prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    const appCheck = bridge
      .checkForUpdate()
      .then((result) => {
        if (result.checked) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not check for updates"),
            description:
              updatesDenial ??
              result.state.message ??
              gt("Automatic updates are not available in this build."),
          }),
        );
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not check for updates"),
            description: thrownErrorMessage(error, m) ?? gt("Update check failed."),
          }),
        );
      });
    setProviderCheck("button");
    const providersChecked = checkProviderUpdates().finally(() => setProviderCheck(null));
    void Promise.allSettled([appCheck, providersChecked]).then(() => setIsActionPending(false));
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
          ? {
              installLocal: (reportError) =>
                installFromFooter(bridge, reportError, localUpdateVersion),
            }
          : {}),
        admitServer,
        localWorkBlocksRestart,
        // SCIENT-FORK:END
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not update everything"),
          description: thrownErrorMessage(error, m) ?? gt("An unexpected error occurred."),
        }),
      );
    }
    setIsActionPending(false);
  };

  const handleCheckAnimationIteration = () => {
    setIsCheckAnimationLatched(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: state?.status === "checking" || isCheckingProviders,
        prefersReducedMotion,
      }),
    );
  };

  // SCIENT-FORK:START — compact labels for this app's own update. Other machines and providers
  // have their own circle, which is all a browser shows.
  const updateLabel =
    !isPreparing && showUpdateIconState && state
      ? getScientDesktopUpdateLabel(
          { ...state, downloadPercent: displayedDownloadPercent },
          messages,
        )
      : null;
  const updateOthers = (admitServer: (target: ServerUpdateTarget) => boolean) =>
    everything.run({ admitServer });
  // In the header (icon rail), this app's update stays up top and the circle for other updates
  // sits in the rail.
  const railOtherUpdates =
    inHeader && railOtherUpdatesSlot
      ? createPortal(
          <SidebarOtherUpdates
            placement="rail"
            servers={everything.otherServers}
            updateAll={updateOthers}
          />,
          railOtherUpdatesSlot,
        )
      : null;
  if (!isElectron) {
    return (
      <>
        {idleContent}
        {inHeader ? (
          railOtherUpdates
        ) : (
          <SidebarOtherUpdates
            placement="footer"
            servers={everything.otherServers}
            updateAll={updateOthers}
          />
        )}
      </>
    );
  }
  if (
    inHeader &&
    !showUpdateIconState &&
    !isPreparing &&
    !restartNotice.open &&
    askingPass === null
  ) {
    return (
      <>
        {idleContent}
        {railOtherUpdates}
      </>
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
          ? gt("Downloading update ({progress})", { progress: updateLabel })
          : updateLabel
            ? gt("{label}: {tooltip}", { label: updateLabel, tooltip })
            : tooltip
      }
      aria-disabled={isInteractionDisabled || undefined}
      aria-busy={isPreparing || undefined}
      className={cn(
        "inline-flex items-center justify-center outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
        isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer",
        showUpdateIconState || isPreparing
          ? cn(
              // SCIENT-FORK: lab-verified compact pill dimensions, type and spacing; the icon rail's
              // header pill is a step larger and, over the stage artwork, the other-updates blue.
              "rounded-(--control-radius) font-medium whitespace-nowrap",
              inHeader ? "text-xs" : "text-2xs",
              "h-5 w-16 gap-0.5 px-0.5",
              onStage && inHeader
                ? OTHER_UPDATES_TONE
                : cn(
                    "bg-primary text-primary-foreground",
                    !isInteractionDisabled && "hover:bg-primary/90",
                  ),
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
        setReleaseNotesTriggerFocusVisible(false);
      }}
      onFocus={(event) => {
        const focusVisible = event.currentTarget.matches(":focus-visible");
        setReleaseNotesTriggerFocusVisible(focusVisible);
        if (!showReleaseNotesPopover || !focusVisible) return;
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
      {isPreparing ? (
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-[13px] shrink-0 animate-spin motion-reduce:animate-none"
          strokeWidth={2.25}
        />
      ) : iconStatus === "available" ? (
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
        // SCIENT-FORK: label weight 650 (variable-font axis; font-medium is 500), 750 in the header.
        <span
          className="tabular-nums"
          style={{ fontVariationSettings: inHeader ? '"wght" 750' : '"wght" 650' }}
        >
          {updateLabel}
        </span>
      ) : null}
    </button>
  );

  // SCIENT-FORK:START — progress, then the reason a restart stopped, announced as they change.
  const restartNoticeContent = restartNotice.open ? (
    <div aria-live="polite" className="text-left" role="status">
      {restartNotice.title ? <div className="font-medium">{restartNotice.title}</div> : null}
      <div className={restartNotice.title ? "text-muted-foreground" : undefined}>
        {restartNotice.description}
      </div>
    </div>
  ) : null;
  // SCIENT-FORK:END

  // SCIENT-FORK: the controls sit in the footer item or, with the icon rail, in the header.
  const controls = (
    <>
      {/* SCIENT-FORK:START */}
      {inHeader ? (
        railOtherUpdates
      ) : (
        <SidebarOtherUpdates servers={everything.otherServers} updateAll={updateOthers} />
      )}
      {/* SCIENT-FORK:END */}
      <Popover
        handle={releaseNotesPopoverHandle}
        open={releaseNotesOpen && showReleaseNotesPopover}
        triggerId={releaseNotesTriggerId}
        onOpenChange={(open, details) => {
          if (open && !showReleaseNotesPopover) {
            details.cancel();
            return;
          }
          handleSidebarUpdateReleaseNotesPopoverOpenChange(open, details);
          if (!details.isCanceled) setReleaseNotesOpen(open);
        }}
      >
        <Tooltip
          // SCIENT-FORK: the restart notice holds the tooltip open; hover cannot close it.
          key={restartNotice.open ? "restart-notice" : isPreparing ? "preparing" : "update"}
          disabled={showReleaseNotesPopover}
          {...(restartNotice.open ? { open: true } : {})}
        >
          <TooltipTrigger
            id={releaseNotesTriggerId}
            render={
              isPreparing ? (
                <span className="inline-flex">{updateButton}</span>
              ) : (
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
              )
            }
          />
          {!showReleaseNotesPopover ? (
            <TooltipPopup
              align="center"
              className={
                // SCIENT-FORK: an off-screen control's notice is a corner toast instead.
                restartNotice.open
                  ? "max-w-56 text-left in-data-[anchor-hidden]:invisible"
                  : showUpdateDetails
                    ? "max-w-48 text-left"
                    : undefined
              }
              // SCIENT-FORK: the icon rail's header control opens its cards below.
              side={inHeader ? "bottom" : "top"}
              variant={showUpdateDetails ? "glass" : "default"}
            >
              {restartNoticeContent ??
                (!isPreparing && idleTooltip?.detail ? (
                  <div className="text-left">
                    <div className="font-medium">{idleTooltip.title}</div>
                    <div className="text-muted-foreground">{idleTooltip.detail}</div>
                  </div>
                ) : (
                  <span className="whitespace-pre-line">{tooltip}</span>
                ))}
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {showReleaseNotesPopover && state ? (
          <PopoverPopup
            align="center"
            aria-label={gt("Update release notes")}
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
            // SCIENT-FORK: the icon rail's header control opens its cards below.
            side={inHeader ? "bottom" : "top"}
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
        side={inHeader ? "bottom" : "top"}
        stops={askingPass?.stops ?? null}
        onCancel={() => setAskingPass(null)}
        onUpdate={() => {
          if (askingPass !== null) void runEverything(askingPass.admitServer);
        }}
      />
      {/* SCIENT-FORK:END */}
    </>
  );
  // SCIENT-FORK:START — the icon rail's header puts the control after the Scient symbol.
  return inHeader ? (
    <div className="flex shrink-0 items-center gap-2.5">
      {activeLeading}
      <div
        className="relative z-10 flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
        data-update-active={showUpdateDetails || undefined}
      >
        {controls}
      </div>
    </div>
  ) : (
    // SCIENT-FORK:END
    <SidebarMenuItem
      // SCIENT-FORK:START — the circle for other machines and providers sits beside the pill.
      className="ml-auto flex shrink-0 items-center"
      // SCIENT-FORK:END
      data-update-active={showUpdateDetails || undefined}
    >
      {controls}
    </SidebarMenuItem>
  );
}
