import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "~/components/ui/dialog";

export function LatexLinkDialog(props: {
  open: boolean;
  text: string;
  onClose: () => void;
  onClosed: () => void;
  onInsert: (text: string, url: string) => void;
}) {
  const [text, setText] = useState(props.text);
  const [url, setUrl] = useState("");
  const valid = /^(https?:\/\/|mailto:)/iu.test(url.trim()) && !/[{}\\\s]/u.test(url.trim());
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) props.onClosed();
      }}
    >
      <DialogPopup finalFocus={false} data-dock-command-scope="latex">
        <DialogHeader>
          <DialogTitle>Insert link</DialogTitle>
          <DialogDescription>Choose the text and web or email address.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) props.onInsert(text || url.trim(), url.trim());
            }}
          >
            <label>
              Text
              <Input value={text} onChange={(event) => setText(event.target.value)} />
            </label>
            <label>
              Address
              <Input
                autoFocus
                type="url"
                placeholder="https://"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={props.onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid}>
                Insert link
              </Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
