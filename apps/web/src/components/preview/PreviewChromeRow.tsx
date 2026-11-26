// SCIENT-FORK:START — Scient Accounts: desktop account controls for the owning tab.
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { BrowserAccountControls } from "~/scient/accounts/BrowserAccountControls";
// SCIENT-FORK:END
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  MousePointerClick,
  PictureInPicture2,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
} from "react";
import { T, useGT } from "gt-react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
// SCIENT-FORK:START — Scient Browser: suggestions as you type.
import { BrowserSuggestionInput, BrowserSuggestions } from "~/scient/browser/BrowserSuggestions";
// SCIENT-FORK:END
import { Tooltip, TooltipTrigger } from "~/components/ui/tooltip";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { cn } from "~/lib/utils";

interface Props {
  // SCIENT-FORK:START — Scient Accounts: the preview owner supplies the native tab identity.
  accountsTab?:
    | {
        environmentId: EnvironmentId;
        threadRef: ScopedThreadRef;
        tabId: string;
        /** The tab's id in the conversation's browser, where the server reaches it. */
        previewTabId: string;
        profileId: string;
      }
    | undefined;
  // SCIENT-FORK:END
  // SCIENT-FORK:START — Scient Browser: suggestions as you type.
  threadRef: ScopedThreadRef;
  profileId: string;
  incognito: boolean;
  // SCIENT-FORK:END
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  refreshDisabled: boolean;
  inputDisabled?: boolean | undefined;
  /** Owned by the caller so its shortcut handler can focus the address bar directly. */
  urlInputRef: RefObject<HTMLInputElement | null>;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onStopLoading: () => void;
  onSubmit: (url: string) => void;
  onOpenInBrowser?: (() => void) | undefined;
  onCapture?: ((record: boolean) => void) | undefined;
  captureDisabled?: boolean | undefined;
  recording?: boolean | undefined;
  onPictureInPicture?: (() => void) | undefined;
  pictureInPicture?: boolean | undefined;
  pictureInPictureDisabled?: boolean | undefined;
  onPickElement?: (() => void) | undefined;
  pickActive?: boolean | undefined;
  pickDisabled?: boolean | undefined;
  pickDisabledReason?: string | undefined;
  trailingActions?: ReactNode;
  leadingActions?: ReactNode;
}

const NOOP = () => {};

export function PreviewChromeRow({
  url,
  // SCIENT-FORK:START — Scient Accounts: receive the native tab account context.
  accountsTab,
  // SCIENT-FORK:END
  // SCIENT-FORK:START — Scient Browser: suggestions as you type.
  threadRef,
  profileId,
  incognito,
  // SCIENT-FORK:END
  loading,
  canGoBack,
  canGoForward,
  refreshDisabled,
  inputDisabled,
  urlInputRef: inputRef,
  onBack,
  onForward,
  onRefresh,
  onStopLoading,
  onSubmit,
  onOpenInBrowser,
  onCapture,
  captureDisabled,
  recording,
  onPictureInPicture,
  pictureInPicture,
  pictureInPictureDisabled,
  onPickElement,
  pickActive,
  pickDisabled,
  pickDisabledReason,
  trailingActions,
  leadingActions,
}: Props) {
  const gt = useGT();
  const [draft, setDraft] = useState(url);
  const [inputFocused, setInputFocused] = useState(false);
  // SCIENT-FORK:START — Scient Browser: the bar follows the page until someone types.
  const [edited, setEdited] = useState(false);
  const shownAddress = inputFocused && edited ? draft : url;
  // SCIENT-FORK:END
  // SCIENT-FORK:START — Scient Browser: suggestions as you type.
  const addressBar = useRef<HTMLDivElement>(null);
  // SCIENT-FORK:END

  const submit = (event?: FormEvent | KeyboardEvent) => {
    event?.preventDefault();
    const next = shownAddress.trim();
    if (next.length === 0) return;
    onSubmit(next);
    inputRef.current?.blur();
  };

  return (
    <div className="relative">
      <form
        onSubmit={submit}
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <div className="flex items-center gap-0.5" role="group" aria-label={gt("Navigation")}>
          <SharedTooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={canGoBack ? onBack : NOOP}
                disabled={!canGoBack}
                aria-label={gt("Back", { $context: "browser navigation" })}
                type="button"
              />
            }
            label={
              <>
                <T context="browser navigation">Back</T>
              </>
            }
          >
            <ArrowLeft />
          </SharedTooltipTrigger>
          <SharedTooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={canGoForward ? onForward : NOOP}
                disabled={!canGoForward}
                aria-label={gt("Forward", { $context: "browser navigation" })}
                type="button"
              />
            }
            label={
              <>
                <T context="browser navigation">Forward</T>
              </>
            }
          >
            <ArrowRight />
          </SharedTooltipTrigger>
          <SharedTooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={refreshDisabled ? NOOP : loading ? onStopLoading : onRefresh}
                disabled={refreshDisabled}
                aria-label={
                  loading ? gt("Stop", { $context: "stop loading the page" }) : gt("Refresh")
                }
                type="button"
              />
            }
            label={loading ? gt("Stop", { $context: "stop loading the page" }) : gt("Refresh")}
          >
            <RefreshIcon refreshing={loading} />
          </SharedTooltipTrigger>
        </div>

        {leadingActions}

        {/* SCIENT-FORK:START — Scient Browser: suggestions as you type. */}
        <BrowserSuggestions
          threadRef={threadRef}
          profileId={profileId}
          text={shownAddress}
          active={inputFocused && edited && !incognito}
          anchor={addressBar}
          onTextChange={(text) => {
            setDraft(text);
            setEdited(true);
          }}
          onPick={(value) => {
            onSubmit(value);
            inputRef.current?.blur();
          }}
        >
          {/* SCIENT-FORK:END */}
          <InputGroup ref={addressBar} variant="ghost" className="group/address h-7 flex-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <BrowserSuggestionInput
                    render={
                      <InputGroupInput
                        ref={inputRef}
                        value={shownAddress}
                        onFocus={() => {
                          setDraft(url);
                          setEdited(false);
                          setInputFocused(true);
                          queueMicrotask(() => inputRef.current?.select());
                        }}
                        onBlur={() => {
                          setInputFocused(false);
                        }}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.keyCode === 229) {
                            // A trusted Enter would still submit the form implicitly.
                            if (event.key === "Enter") event.preventDefault();
                            return;
                          }
                          if (event.key === "Enter") submit(event);
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setDraft(url);
                            inputRef.current?.blur();
                          }
                        }}
                        placeholder={gt("Search or enter URL")}
                        aria-label={gt("Search or enter URL")}
                        data-workspace-focus-default
                        spellCheck={false}
                        disabled={inputDisabled}
                        data-preview-url-input
                        size="sm"
                      />
                    }
                  />
                }
              />
            </Tooltip>
            {/* SCIENT-FORK:START — Scient Accounts: fill and capture stay anchored to this tab. */}
            {accountsTab ? <BrowserAccountControls {...accountsTab} url={url} /> : null}
            {/* SCIENT-FORK:END */}
            {onOpenInBrowser && !inputFocused ? (
              <InputGroupAddon align="inline-end">
                {}
                <span className="pointer-events-none flex opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/address:pointer-events-auto group-hover/address:opacity-100">
                  <SharedTooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={onOpenInBrowser}
                        aria-label={gt("Open in system browser")}
                        type="button"
                      />
                    }
                    label={
                      <>
                        <T>Open in system browser</T>
                      </>
                    }
                  >
                    <ExternalLink />
                  </SharedTooltipTrigger>
                </span>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          {/* SCIENT-FORK:START — Scient Browser: suggestions as you type. */}
        </BrowserSuggestions>
        {/* SCIENT-FORK:END */}

        {onPickElement ? (
          <SharedTooltipTrigger
            render={
              <Button
                variant={pickActive ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={onPickElement}
                disabled={pickDisabled}
                aria-label={pickActive ? gt("Cancel annotation") : gt("Annotate preview")}
                aria-pressed={pickActive ? "true" : "false"}
                type="button"
              />
            }
            label={
              pickDisabled && pickDisabledReason
                ? pickDisabledReason
                : pickActive
                  ? gt("Cancel annotation (Esc)")
                  : gt("Annotate elements, regions, and drawings")
            }
          >
            <MousePointerClick className={cn(pickActive && "text-primary")} />
          </SharedTooltipTrigger>
        ) : null}
        {onCapture ? (
          <SharedTooltipTrigger
            render={
              <Button
                variant={recording ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={(event) => onCapture(event.shiftKey)}
                aria-label={recording ? gt("Stop recording") : gt("Capture screenshot")}
                type="button"
                className="relative"
                disabled={captureDisabled}
              />
            }
            label={recording ? gt("Stop recording") : gt("Screenshot · Shift-click to record")}
          >
            <Camera className={cn(recording && "text-destructive")} />
            {recording ? (
              <span className="absolute right-0.5 top-0.5 size-1.5 motion-safe:animate-status-pulse rounded-full bg-destructive" />
            ) : null}
          </SharedTooltipTrigger>
        ) : null}
        {onPictureInPicture ? (
          <SharedTooltipTrigger
            render={
              <Button
                variant={pictureInPicture ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={onPictureInPicture}
                aria-label={
                  pictureInPicture ? gt("Close floating preview") : gt("Float preview over chat")
                }
                aria-pressed={pictureInPicture ? "true" : "false"}
                type="button"
                disabled={pictureInPictureDisabled}
              />
            }
            label={pictureInPicture ? gt("Close floating preview") : gt("Float preview over chat")}
          >
            <PictureInPicture2 className={cn(pictureInPicture && "text-primary")} />
          </SharedTooltipTrigger>
        ) : null}
        {trailingActions}
      </form>
      <div
        aria-hidden
        data-loading={loading}
        className="preview-loading-progress pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 w-full origin-left rounded-r-full bg-primary"
        style={{ boxShadow: "0 0 6px 1px var(--color-ring)" }}
      />
    </div>
  );
}
