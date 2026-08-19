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
  const moduleLabels: Record<string, string> = {
    notes: messages.moduleNotesLabel,
    asmr: messages.moduleAsmrLabel,
    gallery: messages.moduleGalleryLabel,
    player: messages.modulePlayerLabel,
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
          <Maximize2 size={15} strokeWidth={1.75} />
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
