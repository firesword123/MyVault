import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Minus, Moon, Settings, Square, Sun, X } from "lucide-react";
import appIconUrl from "../../src-tauri/icons/128x128.png";
import type { LocaleMessages } from "../i18n";
import type { ModuleItem } from "../ui-spec";

type TitleBarProps = {
  brand: string;
  messages: LocaleMessages;
  modules: ModuleItem[];
  activeModule: string;
  onSelectModule: (moduleId: string) => void;
  onOpenSettings: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
  showSettings?: boolean;
  showMemory?: boolean;
  memoryBytes?: number | null;
  processCount?: number | null;
};

export function TitleBar({
  brand,
  messages,
  modules,
  activeModule,
  onSelectModule,
  onOpenSettings,
  onMinimize,
  onClose,
  showSettings = true,
  showMemory = false,
  memoryBytes = null,
  processCount = null,
}: TitleBarProps) {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return window.localStorage.getItem("myvault-theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const moduleLabels: Record<string, string> = {
    notes: messages.moduleNotesLabel,
    asmr: messages.moduleAsmrLabel,
    gallery: messages.moduleGalleryLabel,
    player: messages.modulePlayerLabel,
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("myvault-theme", theme);
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
  }, [theme]);

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <span className="titlebar-mark" aria-hidden="true">
          <img src={appIconUrl} alt="" />
        </span>
        <span>{brand}</span>
      </div>

      <nav className="titlebar-modules">
        {modules.map((module) => (
          <button
            key={module.id}
            type="button"
            className={`module-tab ${activeModule === module.id ? "is-active" : ""}`}
            disabled={!module.enabled}
            onClick={() => onSelectModule(module.id)}
          >
            <span>{moduleLabels[module.id] ?? module.id}</span>
          </button>
        ))}
      </nav>

      <div
        className="titlebar-dragzone"
        onMouseDown={(event) => {
          if (event.button === 0) {
            void invoke("start_window_dragging");
          }
        }}
      >
        {showMemory ? (
          <span className="titlebar-memory">
            MyVault · {messages.titlebarMemoryLabel} {memoryBytes === null ? "--" : `${(memoryBytes / 1024 / 1024).toFixed(0)} MB`}
            {processCount === null ? "" : ` · ${processCount} ${messages.titlebarProcessLabel}`}
          </span>
        ) : null}
      </div>

      <div className="window-controls">
        <button
          type="button"
          className="titlebar-theme-toggle"
          aria-label={messages.themeToggleButton}
          title={messages.themeToggleButton}
          onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        >
          {theme === "dark" ? <Sun size={16} strokeWidth={1.8} /> : <Moon size={16} strokeWidth={1.8} />}
        </button>
        {showSettings ? (
          <button type="button" aria-label={messages.settingsTitle} title={messages.settingsTitle} onClick={onOpenSettings}>
            <Settings size={16} strokeWidth={1.75} />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => (onMinimize ? onMinimize() : void invoke("minimize_window"))}
        >
          <Minus size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Maximize"
          title="Maximize"
          onClick={() => void invoke("toggle_maximize_window")}
        >
          <Square size={13} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          className="is-close"
          onClick={() => (onClose ? onClose() : void invoke("close_window"))}
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}
