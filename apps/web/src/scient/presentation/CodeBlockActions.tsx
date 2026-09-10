import { CheckIcon, CopyIcon, WrapTextIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings } from "~/hooks/useSettings";

/** A block can override wrapping locally; a new global preference resets it. */
export function useCodeBlockWordWrap() {
  const defaultWrap = useClientSettings((settings) => settings.wordWrap);
  const [state, setState] = useState({ defaultWrap, wrapped: defaultWrap });
  if (state.defaultWrap !== defaultWrap) {
    setState({ defaultWrap, wrapped: defaultWrap });
  }
  return [
    state.defaultWrap === defaultWrap ? state.wrapped : defaultWrap,
    (wrapped: boolean) => setState({ defaultWrap, wrapped }),
  ] as const;
}

export function CodeBlockActions({
  wrapped,
  onWrapChange,
  readCode,
  onCopyFailure,
}: {
  readonly wrapped: boolean;
  readonly onWrapChange: (wrapped: boolean) => void;
  readonly readCode: () => string;
  readonly onCopyFailure?: (cause: unknown) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(readCode());
      if (!mounted.current) return;
      if (timer.current !== null) clearTimeout(timer.current);
      setCopied(true);
      timer.current = setTimeout(() => {
        setCopied(false);
        timer.current = null;
      }, 1200);
    } catch (cause) {
      if (onCopyFailure) onCopyFailure(cause);
      else console.error("[markdown] copy code failed", cause);
    }
  };

  return (
    <span
      className="flex shrink-0 items-center gap-0.5"
      role="toolbar"
      aria-label="Code block actions"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="chat-markdown-chrome-action"
              aria-pressed={wrapped}
              onClick={() => onWrapChange(!wrapped)}
              aria-label={wrapLabel}
            />
          }
        >
          <WrapTextIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="chat-markdown-chrome-action"
              onClick={() => void copy()}
              aria-label={copyLabel}
            />
          }
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{copyLabel}</TooltipPopup>
      </Tooltip>
    </span>
  );
}
