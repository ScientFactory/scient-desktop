import { useRef, useState, type RefObject } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTitle } from "~/components/ui/popover";

export function LatexLinkDialog(props: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  fallbackAnchor: RefObject<HTMLElement | null>;
  text: string;
  onClose: (restoreFocus: boolean) => void;
  onClosed: () => void;
  onInsert: (text: string, url: string) => void;
}) {
  const addressInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(props.text);
  const [url, setUrl] = useState("");
  const valid = /^(https?:\/\/|mailto:)/iu.test(url.trim()) && !/[{}\\\s]/u.test(url.trim());
  return (
    <Popover
      modal={false}
      open={props.open}
      onOpenChange={(open, details) => {
        if (!open)
          props.onClose(details.reason !== "outside-press" && details.reason !== "focus-out");
      }}
      onOpenChangeComplete={(open) => {
        if (!open) props.onClosed();
      }}
    >
      <PopoverPopup
        anchor={() => props.anchor.current ?? props.fallbackAnchor.current}
        align="start"
        width="sm"
        padding="tight"
        keepMounted
        initialFocus={addressInput}
        finalFocus={false}
        data-dock-command-scope="latex"
        data-keybinding-capture=""
      >
        <div className="grid gap-2">
          <PopoverTitle size="compact">Insert link</PopoverTitle>
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) props.onInsert(text || url.trim(), url.trim());
            }}
          >
            <label className="grid gap-1 text-xs">
              Text
              <Input
                aria-label="Link text"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs">
              Address
              <Input
                ref={addressInput}
                aria-label="Link destination"
                type="url"
                placeholder="https://"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button size="xs" type="button" variant="outline" onClick={() => props.onClose(true)}>
                Cancel
              </Button>
              <Button size="xs" type="submit" disabled={!valid}>
                Insert link
              </Button>
            </div>
          </form>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
