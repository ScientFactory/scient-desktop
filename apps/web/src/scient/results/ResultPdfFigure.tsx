import { T, useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { startPdfDocumentLoad } from "../pdf/pdfRuntime";

function PdfPage(props: {
  readonly url: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  const { url, width, height } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the PDF task and rendered page belong to this canvas.
  useEffect(() => {
    const target = canvas.current;
    const context = target?.getContext("2d");
    if (!target || !context) return;
    let current = true;
    let cancel = () => {};
    const loader = startPdfDocumentLoad(url, {
      onPassword: () => setFailed(true),
      onProgress: () => {},
    });
    void loader.promise
      .then((document) => document.getPage(1))
      .then((page) => {
        if (!current) return;
        const size = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(width / size.width, height / size.height),
        });
        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        const render = page.render({ canvas: target, canvasContext: context, viewport });
        cancel = () => render.cancel();
        return render.promise;
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
      cancel();
      void loader.destroy().catch(() => undefined);
    };
  }, [height, url, width]);

  return failed ? (
    <span>
      <T>The PDF preview could not be read.</T>
    </span>
  ) : (
    <canvas
      ref={canvas}
      role="img"
      aria-label={props.name}
      className="h-auto max-h-full max-w-full object-contain"
    />
  );
}

export default function ResultPdfFigure(props: { readonly url: string; readonly name: string }) {
  const [open, setOpen] = useState(false);
  const gt = useGT();
  return (
    <>
      <div className="flex min-w-0 flex-col items-center gap-1 rounded-lg bg-muted/40 p-2">
        <PdfPage key={props.url} {...props} width={480} height={288} />
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setOpen(true)}
          aria-label={gt("Enlarge {name}", { name: props.name })}
        >
          <T>Enlarge</T>
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogPopup
            layout="visual"
            bottomStickOnMobile={false}
            className="w-full max-w-[960px] max-sm:w-full"
          >
            <DialogHeader>
              <DialogTitle>{props.name}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <div className="flex justify-center">
                <PdfPage key={props.url} {...props} width={1200} height={1200} />
              </div>
            </DialogPanel>
          </DialogPopup>
        ) : null}
      </Dialog>
    </>
  );
}
