import type { BrowserHistoryCursor, BrowserHistoryPage, ScopedThreadRef } from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { SearchIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { PreviewRecentUrlCard } from "~/components/preview/PreviewRecentUrlCard";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { DiscoveryList } from "~/components/ui/discovery-list";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { useAtomCommand } from "~/state/use-atom-command";

import { pagesByDay } from "./browserHistoryDays";
import { browserHistoryState } from "./browserHistoryState";

const SEARCH_DELAY_MS = 150;
const QUIET = { reportFailure: false, reportDefect: false };

/** Every page visited in this profile, newest first. Opening one closes this. */
export function BrowserHistoryDialog({
  threadRef,
  profileId,
  onOpenUrl,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  profileId: string;
  onOpenUrl: (url: string) => void;
  onClose: () => void;
}) {
  const { environmentId } = threadRef;
  const list = useAtomCommand(browserHistoryState.list, QUIET);
  const remove = useAtomCommand(browserHistoryState.remove, QUIET);
  const clear = useAtomCommand(browserHistoryState.clear, QUIET);

  const [query, setQuery] = useState("");
  const [search] = useDebouncedValue(query.trim(), { wait: SEARCH_DELAY_MS });
  const [pages, setPages] = useState<ReadonlyArray<BrowserHistoryPage> | null>(null);
  const [next, setNext] = useState<BrowserHistoryCursor | undefined>();
  const [failed, setFailed] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [now] = useState(() => Date.now());
  const latestRequest = useRef(0);

  const load = useEffectEvent(
    async (text: string, profile: string, before?: BrowserHistoryCursor) => {
      const request = ++latestRequest.current;
      const result = await list({
        environmentId,
        input: {
          profileId: profile,
          ...(text ? { query: text } : {}),
          ...(before ? { before } : {}),
        },
      });
      if (request !== latestRequest.current) return;
      setFailed(result._tag === "Failure");
      if (result._tag === "Failure") return;
      setPages((current) =>
        before ? [...(current ?? []), ...result.value.pages] : result.value.pages,
      );
      setNext(result.value.next);
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each search, in each profile, asks the server again
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- state changes once the server answers
    void load(search, profileId);
  }, [search, profileId]);

  const removePage = async (url: string) => {
    const before = pages;
    setPages((current) => current?.filter((page) => page.url !== url) ?? null);
    const result = await remove({ environmentId, input: { profileId, urls: [url] } });
    if (result._tag === "Success") return;
    setPages(before);
    toastManager.add({ type: "error", title: "Could not remove this from your history" });
  };

  const clearAll = async () => {
    setConfirmingClear(false);
    const result = await clear({ environmentId, input: { profileId } });
    if (result._tag === "Success") {
      setPages([]);
      setNext(undefined);
      return;
    }
    toastManager.add({ type: "error", title: "Could not clear your history" });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <InputGroup>
              <InputGroupAddon align="inline-start">
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                autoFocus
                type="search"
                aria-label="Search history"
                placeholder="Search history"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </InputGroup>
            <div className="flex h-[min(60vh,28rem)] flex-col gap-5 overflow-y-auto">
              {failed ? (
                <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
                  <p>Could not load your history.</p>
                  <Button size="sm" variant="outline" onClick={() => void load(search, profileId)}>
                    Try again
                  </Button>
                </div>
              ) : pages?.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {search ? "No pages match your search." : "Pages you visit will appear here."}
                </p>
              ) : (
                pagesByDay(pages ?? [], now).map((day) => (
                  <section key={day.label} className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-muted-foreground">{day.label}</h3>
                    <DiscoveryList>
                      {day.pages.map((page) => (
                        <PreviewRecentUrlCard
                          key={page.url}
                          threadRef={threadRef}
                          entry={{
                            url: page.url,
                            lastVisitedAt: page.lastVisitedAt,
                            ...(page.title ? { title: page.title } : {}),
                          }}
                          onOpen={() => {
                            onClose();
                            onOpenUrl(page.url);
                          }}
                          onRemove={() => void removePage(page.url)}
                        />
                      ))}
                    </DiscoveryList>
                  </section>
                ))
              )}
              {next ? (
                <Button
                  className="self-center"
                  size="sm"
                  variant="outline"
                  onClick={() => void load(search, profileId, next)}
                >
                  Show more
                </Button>
              ) : null}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare" className="sm:justify-start">
          <Button
            variant="ghost"
            disabled={!pages || pages.length === 0}
            onClick={() => setConfirmingClear(true)}
          >
            Clear history
          </Button>
        </DialogFooter>
      </DialogPopup>
      <AlertDialog open={confirmingClear} onOpenChange={setConfirmingClear}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear your history?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes every page from this profile&apos;s history. Your Recently used list,
              cookies and sign-ins stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void clearAll()}>
              Clear history
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Dialog>
  );
}
