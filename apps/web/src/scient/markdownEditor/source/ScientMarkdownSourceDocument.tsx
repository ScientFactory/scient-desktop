import { useEffect, useRef, useState } from "react";

import { ScientMarkdownSourceView } from "./ScientMarkdownSourceView";

export interface ScientMarkdownSourceDocumentProps {
  readonly source: string;
  readonly editable: boolean;
  readonly ariaLabel: string;
  readonly onUserSourceChange: (source: string) => void;
}

export function ScientMarkdownSourceDocument(props: ScientMarkdownSourceDocumentProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onUserSourceChangeRef = useRef(props.onUserSourceChange);
  onUserSourceChangeRef.current = props.onUserSourceChange;
  const [controller] = useState(
    () =>
      new ScientMarkdownSourceView({
        source: props.source,
        editable: props.editable,
        ariaLabel: props.ariaLabel,
        onUserSourceChange: (source) => onUserSourceChangeRef.current(source),
      }),
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    controller.mount(host);
    return () => controller.destroy();
  }, [controller]);

  useEffect(() => controller.setEditable(props.editable), [controller, props.editable]);
  useEffect(() => controller.replaceExternalSource(props.source), [controller, props.source]);

  return <div ref={hostRef} className="scient-markdown-source-document" />;
}
