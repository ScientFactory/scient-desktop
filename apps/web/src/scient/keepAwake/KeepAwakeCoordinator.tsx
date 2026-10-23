import { useEffect } from "react";
import { requestKeepAwake } from "./state";
import { registerRemoteKeepAwakeObserver } from "./remote";

export function KeepAwakeCoordinator() {
  useEffect(() => {
    const unregister = registerRemoteKeepAwakeObserver();
    void requestKeepAwake({ type: "get" });
    const timer = setInterval(() => {
      void requestKeepAwake({ type: "get" });
    }, 15000);
    return () => {
      clearInterval(timer);
      unregister();
    };
  }, []);
  return null;
}
