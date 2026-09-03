import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

export const isEmbeddedModule = new URLSearchParams(window.location.search).get("embedded") === "1";

// Native child WebViews are destroyed on tab changes; don't discard edits or
// detach an import halfway through just because the titlebar lives elsewhere.
export function useEmbeddedGuard(reason: string | null) {
  useEffect(() => {
    if (!isEmbeddedModule) return;
    void invoke("set_embedded_module_guard", { reason }).catch(console.error);
  }, [reason]);
}
