import type { ScientAnalyticsConsent } from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";
import { Popover, PopoverTrigger, PopoverPopup, PopoverTitle } from "../../components/ui/popover";

/** One explanation shared by settings and the first-run sharing notice. */
export function AnalyticsSharingInfo({ consent }: { consent: ScientAnalyticsConsent }) {
  return (
    <Popover>
      <PopoverTrigger className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-normal text-sky-600 transition-colors hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        What’s shared? <InfoIcon aria-hidden="true" className="size-3" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-96 max-w-[calc(100vw-2rem)]">
        <PopoverTitle className="text-sm">What’s shared?</PopoverTitle>
        <div className="mt-3 space-y-3 text-xs leading-relaxed text-muted-foreground">
          <p>
            Share which features and provider/model categories you use, reported token counts,
            whether operations succeed or fail, basic performance information, and counters that
            help check analytics delivery. Turn sharing off in Settings to stop sending analytics.
          </p>
          {consent === "essential" || consent === "product" ? (
            <p>
              {consent === "essential"
                ? "Your saved preference shares only reliability information."
                : "Your saved preference shares usage and reliability without delivery counters."}{" "}
              It has not been increased. Turning sharing off and back on enables the full set
              described above.
            </p>
          ) : null}
          <p>
            <strong className="block font-medium text-foreground">Your privacy</strong>
            Analytics never includes prompts, responses, file contents, paths, URLs, credentials, or
            provider account identities. A random installation identifier connects events from the
            same installation; it is not your provider account.
          </p>
          <p>
            <strong className="block font-medium text-foreground">Storage</strong>
            In Scient’s own storage, usage and reliability events are kept for up to 180 days and
            delivery diagnostics for up to 30 days.
          </p>
          <p>
            <strong className="block font-medium text-foreground">Deleting data</strong>
            Delete data requests removal of this installation’s analytics and resets its identifier.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
