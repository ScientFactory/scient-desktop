import type { ScopedThreadRef } from "@t3tools/contracts";
import { GripIcon, MoreVerticalIcon, PlusIcon, SearchIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { useFaviconForThreadUrl } from "~/browserFaviconStore";
import { FaviconImage } from "~/components/preview/PreviewFaviconIcon";
import { ScientSymbol } from "~/components/ScientSymbol";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Label } from "~/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { profileDomains } from "~/scient/accounts/accountsView";
import { useAccounts } from "~/scient/accounts/useAccounts";

import {
  canAddShortcut,
  GMAIL,
  GOOGLE,
  GOOGLE_APPS,
  type HomeSite,
  parseSiteUrl,
  type Shortcut,
  universityMoodle,
  useBrowserShortcuts,
  visibleShortcuts,
} from "./browserShortcuts";

const TILE_CLASS =
  "flex w-full flex-col items-center gap-1.5 rounded-lg p-1.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
const CIRCLE_CLASS =
  "flex size-11 items-center justify-center overflow-hidden rounded-full border border-border/60";
const TILE_LABEL_CLASS = "w-full truncate text-center text-xs text-muted-foreground";
/** The menu button sits on the tile, so the tile stays lit under it and while its menu is open. */
const SHORTCUT_TILE_CLASS = `${TILE_CLASS} group-hover/row:bg-accent group-has-data-popup-open/row:bg-accent`;
/** Darker than the tile in both themes, whatever the tile beneath it shows. */
const SHORTCUT_MENU_CLASS =
  "absolute end-0.5 top-0.5 flex size-5 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-foreground/10 data-popup-open:text-foreground data-popup-open:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100";
/** Four rows of apps, and the fade that shows there are more. */
const APPS_HEIGHT_CLASS = "h-[17.75rem]";
const MAX_NAME_LENGTH = 60;

function SiteIcon({
  threadRef,
  site,
  className,
}: {
  threadRef: ScopedThreadRef;
  site: HomeSite;
  className: string;
}) {
  const captured = useFaviconForThreadUrl(threadRef, site.url);
  return (
    <FaviconImage
      sources={[site.icon, captured, `${new URL(site.url).origin}/favicon.ico`]}
      fallback={
        <span aria-hidden className="text-sm font-medium text-neutral-600">
          {site.name.charAt(0).toUpperCase()}
        </span>
      }
      className={className}
    />
  );
}

function GoogleApps({
  threadRef,
  onOpenUrl,
}: {
  threadRef: ScopedThreadRef;
  onOpenUrl: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="sm" variant="ghost" />}>
        <GripIcon />
        Apps
      </PopoverTrigger>
      <PopoverPopup padding="tight">
        <ScrollArea scrollFade className={APPS_HEIGHT_CLASS}>
          <div className="grid w-64 grid-cols-3 gap-1">
            {GOOGLE_APPS.map((app) => (
              <button
                key={app.name}
                type="button"
                className={TILE_CLASS}
                onClick={() => {
                  setOpen(false);
                  onOpenUrl(app.url);
                }}
              >
                <SiteIcon threadRef={threadRef} site={app} className="size-7 object-contain" />
                <span className={TILE_LABEL_CLASS}>{app.name}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </PopoverPopup>
    </Popover>
  );
}

function ShortcutCircle({
  threadRef,
  shortcut,
  onOpen,
  onEdit,
  onRemove,
}: {
  threadRef: ScopedThreadRef;
  shortcut: Shortcut;
  onOpen: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group/row relative w-20">
      <button type="button" className={SHORTCUT_TILE_CLASS} onClick={onOpen}>
        <span className={`${CIRCLE_CLASS} bg-white`}>
          <SiteIcon threadRef={threadRef} site={shortcut} className="size-6 object-contain" />
        </span>
        <span className={TILE_LABEL_CLASS}>{shortcut.name}</span>
      </button>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              className={SHORTCUT_MENU_CLASS}
              aria-label={`${shortcut.name} options`}
            />
          }
        >
          <MoreVerticalIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuItem onClick={onEdit}>Edit</MenuItem>
          <MenuItem onClick={onRemove}>Remove</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** Adds a shortcut, or edits `shortcut`. */
function ShortcutDialog({ shortcut, onClose }: { shortcut: Shortcut | null; onClose: () => void }) {
  const save = useBrowserShortcuts((state) => state.save);
  const [name, setName] = useState(shortcut?.name ?? "");
  const [link, setLink] = useState(shortcut?.url ?? "");
  const [invalid, setInvalid] = useState(false);
  const formId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!parseSiteUrl(link)) {
      setInvalid(true);
      return;
    }
    save(shortcut, link, name);
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{shortcut ? "Edit shortcut" : "Add shortcut"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="grid gap-4" onSubmit={submit}>
            <label className="grid gap-1.5">
              <Label render={<span />}>Name</Label>
              <Input
                autoFocus={shortcut !== null}
                maxLength={MAX_NAME_LENGTH}
                placeholder="Optional"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="grid gap-1.5">
              <label className="grid gap-1.5">
                <Label render={<span />}>Link</Label>
                <Input
                  autoFocus={shortcut === null}
                  aria-invalid={invalid}
                  placeholder="example.org"
                  value={link}
                  onChange={(event) => {
                    setLink(event.target.value);
                    setInvalid(false);
                  }}
                />
              </label>
              {invalid ? (
                <p className="text-xs text-destructive-foreground">Enter a web address.</p>
              ) : null}
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId}>
            {shortcut ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function HomeSearch({ onSearch }: { onSearch: (query: string) => void }) {
  const [query, setQuery] = useState("");
  return (
    <div className="flex w-full flex-col items-center gap-6 pt-6">
      <p className="flex items-center gap-1.5 text-xl tracking-tight">
        <ScientSymbol className="size-6" />
        <span>
          <span className="font-semibold">Scient</span>{" "}
          <span className="text-muted-foreground">Browser</span>
        </span>
      </p>
      <form
        role="search"
        className="w-full max-w-md"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) onSearch(query);
        }}
      >
        <InputGroup className="h-11 [--control-radius:9999px]">
          <InputGroupAddon align="inline-start">
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search or enter an address"
            placeholder="Search or enter an address"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
      </form>
    </div>
  );
}

/** What an empty browser tab offers first: Google's main apps, search and the user's shortcuts. */
export function BrowserHome({
  threadRef,
  profileId,
  onOpenUrl,
  onSearch,
}: {
  threadRef: ScopedThreadRef;
  profileId: string;
  onOpenUrl: (url: string) => void;
  onSearch: (query: string) => void;
}) {
  const { data } = useAccounts(threadRef.environmentId);
  const moodle = universityMoodle(profileDomains(data, profileId));
  const added = useBrowserShortcuts((state) => state.added);
  const names = useBrowserShortcuts((state) => state.names);
  const hidden = useBrowserShortcuts((state) => state.hidden);
  const visits = useBrowserShortcuts((state) => state.visits);
  const remove = useBrowserShortcuts((state) => state.remove);
  const [dialog, setDialog] = useState<{ shortcut: Shortcut | null } | null>(null);
  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex flex-wrap items-center justify-center gap-1">
        {[GOOGLE, GMAIL, ...(moodle ? [moodle] : [])].map((site) => (
          <Button key={site.name} size="sm" variant="ghost" onClick={() => onOpenUrl(site.url)}>
            <SiteIcon threadRef={threadRef} site={site} className="size-5 object-contain" />
            {site.name}
          </Button>
        ))}
        <GoogleApps threadRef={threadRef} onOpenUrl={onOpenUrl} />
      </div>
      <HomeSearch onSearch={onSearch} />
      <div className="flex max-w-[calc(5rem*4+0.25rem*3)] flex-wrap justify-center gap-1">
        {visibleShortcuts({ added, names, hidden, visits }, moodle ? [moodle] : []).map(
          (shortcut) => (
            <ShortcutCircle
              key={shortcut.url}
              threadRef={threadRef}
              shortcut={shortcut}
              onOpen={() => onOpenUrl(shortcut.url)}
              onEdit={() => setDialog({ shortcut })}
              onRemove={() => remove(shortcut)}
            />
          ),
        )}
        {canAddShortcut(added) ? (
          <div className="w-20">
            <button
              type="button"
              className={TILE_CLASS}
              onClick={() => setDialog({ shortcut: null })}
            >
              <span className={`${CIRCLE_CLASS} bg-muted text-muted-foreground`}>
                <PlusIcon className="size-5" />
              </span>
              <span className={TILE_LABEL_CLASS}>Add</span>
            </button>
          </div>
        ) : null}
      </div>
      {dialog ? (
        <ShortcutDialog shortcut={dialog.shortcut} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}
