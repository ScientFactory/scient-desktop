import { useEffect, useState } from "react";

export function useNearViewport(): {
  readonly ref: (node: HTMLDivElement | null) => void;
  readonly isNearViewport: boolean;
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [isNearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    if (element == null || isNearViewport) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }

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
