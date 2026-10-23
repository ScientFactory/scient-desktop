import { useEffect } from "react";
import { requestKeepAwake } from "./state";

export function KeepAwakeCoordinator() {
  useEffect(() => {
    void requestKeepAwake({ type: "get" });
    const timer = setInterval(() => {
      void requestKeepAwake({ type: "get" });
    }, 15000);
    return () => clearInterval(timer);
  }, []);
  return null;
}
