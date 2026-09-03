import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

export type EmbeddedModule = "asmr" | "gallery";

function contentBounds() {
  const element = document.querySelector(".window-shell > .app-body");
  if (!element) throw new Error("找不到模块内容区域");
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

export function useEmbeddedModules() {
  const [experiment, setExperiment] = useState<boolean | null>(null);
  const [active, setActive] = useState<EmbeddedModule | null>(null);
  const [busy, setBusy] = useState(false);
  const switching = useRef(false);

  useEffect(() => {
    let alive = true;
    void invoke<boolean>("is_experiment_build").then((value) => {
      if (alive) setExperiment(value);
    }).catch((error) => {
      if (alive) window.alert(`无法读取应用运行模式：${String(error)}`);
    });
    return () => { alive = false; };
  }, []);

  const select = useCallback(async (module: EmbeddedModule | null) => {
    if (switching.current) return false;
    switching.current = true;
    setBusy(true);
    try {
      await invoke("switch_embedded_module", { module, bounds: contentBounds() });
      setActive(module);
      // Resizing can happen while WebView2 is starting. Apply the latest bounds.
      await invoke("resize_embedded_module", { bounds: contentBounds() });
      return true;
    } catch (error) {
      // If creating the next child failed after closing the previous one,
      // reconcile the shell instead of leaving it on a nonexistent module.
      const actual = await invoke<EmbeddedModule | null>("embedded_module_status").catch(() => null);
      setActive(actual);
      window.alert(`模块切换未完成：${String(error)}`);
      return false;
    } finally {
      switching.current = false;
      setBusy(false);
    }
  }, []);

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

  return { experiment, active, busy, select };
}
