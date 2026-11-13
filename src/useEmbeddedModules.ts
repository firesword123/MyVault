import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { LocaleMessages } from "./i18n";

export type EmbeddedModule = "asmr" | "gallery";

function contentBounds(messages?: LocaleMessages) {
  const element = document.querySelector(".window-shell > .app-body");
  if (!element) throw new Error(messages?.embeddedBoundsMissing ?? "Module content area not found");
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

/** `messagesRef` is read at call time so the hook can run before the shell resolves its language. */
export function useEmbeddedModules(messagesRef: RefObject<LocaleMessages>) {
  const [active, setActive] = useState<EmbeddedModule | null>(null);
  const [busy, setBusy] = useState(false);
  const switching = useRef(false);

  const select = useCallback(async (module: EmbeddedModule | null) => {
    if (switching.current) return false;
    switching.current = true;
    setBusy(true);
    try {
      await invoke("switch_embedded_module", { module, bounds: contentBounds(messagesRef.current) });
      setActive(module);
      // Resizing can happen while WebView2 is starting. Apply the latest bounds.
      await invoke("resize_embedded_module", { bounds: contentBounds() });
      return true;
    } catch (error) {
      // If creating the next child failed after closing the previous one,
      // reconcile the shell instead of leaving it on a nonexistent module.
      const actual = await invoke<EmbeddedModule | null>("embedded_module_status").catch(() => null);
      setActive(actual);
      window.alert(messagesRef.current.embeddedSwitchFailed.replace("{error}", String(error)));
      return false;
    } finally {
      switching.current = false;
      setBusy(false);
    }
  }, [messagesRef]);

  useEffect(() => {
    const element = document.querySelector(".window-shell > .app-body");
    if (!element) return;
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = contentBounds();
        if (bounds.width > 0 && bounds.height > 0) {
          void invoke("resize_embedded_module", { bounds }).catch(console.error);
        }
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(frame);
    };
  }, []);

  return { active, busy, select };
}
