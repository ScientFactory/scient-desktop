import { useEffect, useState } from "react";

export function useNearViewport(): {
  readonly ref: (node: HTMLDivElement | null) => void;
  readonly isNearViewport: boolean;
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [observedNearViewport, setNearViewport] = useState(false);
  const isNearViewport =
    observedNearViewport || (element !== null && typeof IntersectionObserver === "undefined");
  if (isNearViewport && !observedNearViewport) setNearViewport(true);

  useEffect(() => {
    if (element == null || isNearViewport) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, isNearViewport]);

  return { ref: setElement, isNearViewport };
}
