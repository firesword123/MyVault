import { invoke } from "@tauri-apps/api/core";
import { Maximize2, Minus, Settings, X } from "lucide-react";
import type { LocaleMessages } from "../i18n";
import type { ModuleItem } from "../ui-spec";

type TitleBarProps = {
  brand: string;
  messages: LocaleMessages;
  modules: ModuleItem[];
  activeModule: string;
  onSelectModule: (moduleId: string) => void;
  onOpenSettings: () => void;
};

export function TitleBar({
  brand,
  messages,
  modules,
  activeModule,
  onSelectModule,
  onOpenSettings,
}: TitleBarProps) {
  const moduleLabels: Record<string, string> = {
    notes: messages.moduleNotesLabel,
    gallery: messages.moduleGalleryLabel,
    private: messages.modulePrivateLabel,
  };

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
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
            {moduleLabels[module.id] ?? module.id}
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
      />

      <div className="window-controls">
        <button type="button" aria-label={messages.settingsTitle} title={messages.settingsTitle} onClick={onOpenSettings}>
          <Settings size={16} strokeWidth={1.75} />
        </button>
        <button type="button" aria-label="Minimize" title="Minimize" onClick={() => void invoke("minimize_window")}>
          <Minus size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Maximize"
          title="Maximize"
          onClick={() => void invoke("toggle_maximize_window")}
        >
          <Maximize2 size={15} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          className="is-close"
          onClick={() => void invoke("close_window")}
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}
