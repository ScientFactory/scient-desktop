import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { requestKeepAwake } from "./state";
import { keepAwakeObservationsAtom } from "./work";

export function KeepAwakeCoordinator() {
  const observations = useAtomValue(keepAwakeObservationsAtom);
  useEffect(() => {
    void requestKeepAwake({ type: "get" });
    const timer = setInterval(() => {
      void requestKeepAwake({ type: "get" });
    }, 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (observations.length > 0) void requestKeepAwake({ type: "report", observations });
  }, [observations]);
  return null;
}
