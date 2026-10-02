import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LatexFigureArtwork as Artwork } from "./latexVisualDocument";

/** Reserve rotated bounds from the untransformed box; edits never resize an observed stage. */
export function LatexFigureArtwork({
  artwork,
  children,
}: {
  artwork: Artwork;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [rotatedHeight, setRotatedHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || artwork.angle === 0) {
      setRotatedHeight(null);
      return;
    }
    const measure = () => {
      const angle = (artwork.angle * Math.PI) / 180;
      const height =
        Math.abs(element.offsetWidth * Math.sin(angle)) +
        Math.abs(element.offsetHeight * Math.cos(angle));
      if (height > 0)
        setRotatedHeight((previous) =>
          previous !== null && Math.abs(previous - height) < 0.5 ? previous : height,
        );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [artwork.angle]);
  return (
    <div
      className="scient-latex-figure-artwork-stage"
      style={{ height: rotatedHeight ?? undefined }}
    >
      <div
        ref={box}
        className="scient-latex-figure-artwork"
        data-frame={artwork.frame || undefined}
        data-vertical={artwork.vertical}
        data-rotated={rotatedHeight !== null || undefined}
        style={{
          width: artwork.width ?? "max-content",
          minHeight: artwork.height ?? undefined,
          transform: artwork.angle
            ? `${rotatedHeight !== null ? "translate(-50%, -50%) " : ""}rotate(${-artwork.angle}deg)`
            : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}
