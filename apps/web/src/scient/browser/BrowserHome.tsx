import type { ScopedThreadRef } from "@t3tools/contracts";
import { GripIcon, PlusIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { useFaviconForThreadUrl } from "~/browserFaviconStore";
import { FaviconImage } from "~/components/preview/PreviewFaviconIcon";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

import {
  canAddShortcut,
  GMAIL,
  GOOGLE,
  GOOGLE_APPS,
  type HomeSite,
  parseSiteUrl,
  type Shortcut,
  useBrowserShortcuts,
  visibleShortcuts,
} from "./browserShortcuts";

const TILE_CLASS =
  "flex w-full flex-col items-center gap-1.5 rounded-lg p-1.5 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
const CIRCLE_CLASS =
  "flex size-11 items-center justify-center overflow-hidden rounded-full border border-border/60";
const TILE_LABEL_CLASS = "w-full truncate text-center text-xs text-muted-foreground";

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
      </PopoverPopup>
    </Popover>
  );
}

function ShortcutCircle({
  threadRef,
  shortcut,
  onOpen,
  onRemove,
}: {
  threadRef: ScopedThreadRef;
  shortcut: Shortcut;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group/row relative w-20">
      <button type="button" className={TILE_CLASS} onClick={onOpen}>
        <span className={`${CIRCLE_CLASS} bg-white`}>
          <SiteIcon threadRef={threadRef} site={shortcut} className="size-6 object-contain" />
        </span>
        <span className={TILE_LABEL_CLASS}>{shortcut.name}</span>
      </button>
      <Button
        size="icon-tiny"
        variant="ghost-muted-row"
        className="absolute end-1 top-1"
        aria-label={`Remove ${shortcut.name}`}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function AddShortcut() {
  const add = useBrowserShortcuts((state) => state.add);
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const reset = () => {
    setAddress("");
    setInvalid(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!parseSiteUrl(address)) {
      setInvalid(true);
      return;
    }
    add(address);
    reset();
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <div className="w-20">
        <PopoverTrigger render={<button type="button" className={TILE_CLASS} />}>
          <span className={`${CIRCLE_CLASS} bg-muted text-muted-foreground`}>
            <PlusIcon className="size-5" />
          </span>
          <span className={TILE_LABEL_CLASS}>Add</span>
        </PopoverTrigger>
      </div>
      <PopoverPopup padding="comfortable">
        <form className="flex w-64 flex-col gap-2" onSubmit={submit}>
          <Input
            autoFocus
            aria-label="Site address"
            aria-invalid={invalid}
            placeholder="Site address"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setInvalid(false);
            }}
          />
          {invalid ? (
            <p className="text-xs text-destructive-foreground">Enter a web address.</p>
          ) : null}
          <Button type="submit" size="sm" className="self-end">
            Add shortcut
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

/** What an empty browser tab offers first: Google, Gmail, the apps and the user's shortcuts. */
export function BrowserHome({
  threadRef,
  onOpenUrl,
}: {
  threadRef: ScopedThreadRef;
  onOpenUrl: (url: string) => void;
}) {
  const added = useBrowserShortcuts((state) => state.added);
  const hidden = useBrowserShortcuts((state) => state.hidden);
  const visits = useBrowserShortcuts((state) => state.visits);
  const remove = useBrowserShortcuts((state) => state.remove);
  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex flex-wrap items-center justify-center gap-1">
        {[GOOGLE, GMAIL].map((site) => (
          <Button key={site.name} size="sm" variant="ghost" onClick={() => onOpenUrl(site.url)}>
            <SiteIcon threadRef={threadRef} site={site} className="size-4 object-contain" />
            {site.name}
          </Button>
        ))}
        <GoogleApps threadRef={threadRef} onOpenUrl={onOpenUrl} />
      </div>
      <div className="flex max-w-[calc(5rem*4+0.25rem*3)] flex-wrap justify-center gap-1">
        {visibleShortcuts({ added, hidden, visits }).map((shortcut) => (
          <ShortcutCircle
            key={shortcut.key}
            threadRef={threadRef}
            shortcut={shortcut}
            onOpen={() => onOpenUrl(shortcut.url)}
            onRemove={() => remove(shortcut)}
          />
        ))}
        {canAddShortcut(added) ? <AddShortcut /> : null}
      </div>
    </div>
  );
}
