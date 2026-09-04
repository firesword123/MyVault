import { useEffect } from "react";

export function useStoredTheme() {
  useEffect(() => {
    const applyTheme = () => {
      try {
        document.documentElement.dataset.theme =
          window.localStorage.getItem("myvault-theme") === "dark" ? "dark" : "light";
      } catch {
        document.documentElement.dataset.theme = "light";
      }
    };

    applyTheme();
    window.addEventListener("storage", applyTheme);
    return () => window.removeEventListener("storage", applyTheme);
  }, []);
}
