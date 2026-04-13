import { X } from "lucide-react";
import type { LocaleMessages } from "../i18n";

type SettingsPanelProps = {
  open: boolean;
  messages: LocaleMessages;
  version: string;
  updateStatus: string;
  updateActionLabel: string;
  updateActionDisabled: boolean;
  language: string;
  showNoteTime: boolean;
  closeBehavior: "quit" | "tray";
  vaultPath: string;
  colorPresets: string[];
  colorPresetCount: number;
  onLanguageChange: (language: string) => void;
  onShowNoteTimeChange: (checked: boolean) => void;
  onCloseBehaviorChange: (behavior: "quit" | "tray") => void;
  onColorPresetsChange: (colors: string[]) => void;
  onColorPresetCountChange: (count: number) => void;
  onUpdateAction: () => void;
  onClose: () => void;
};

export function SettingsPanel({
  open,
  messages,
  version,
  updateStatus,
  updateActionLabel,
  updateActionDisabled,
  language,
  showNoteTime,
  closeBehavior,
  vaultPath,
  colorPresets,
  colorPresetCount,
  onLanguageChange,
  onShowNoteTimeChange,
  onCloseBehaviorChange,
  onColorPresetsChange,
  onColorPresetCountChange,
  onUpdateAction,
  onClose,
}: SettingsPanelProps) {
  if (!open) return null;

  const visiblePresets = Array.from(
    { length: colorPresetCount },
    (_, index) => colorPresets[index] || "#3b82f6",
  );

  return (
    <aside className="settings-panel">
      <div className="settings-panel-header">
        <div>
          <span className="section-label">{messages.settingsTitle}</span>
          <h3>{messages.settingsTitle}</h3>
        </div>
        <button type="button" className="icon-button" onClick={onClose}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>

      <label className="settings-field">
        <span>{messages.languageLabel}</span>
        <select value={language} onChange={(event) => onLanguageChange(event.target.value)}>
          <option value="zh-CN">{messages.languageZhCn}</option>
          <option value="en-US">{messages.languageEnUs}</option>
        </select>
      </label>

      <div className="settings-field">
        <span>{messages.versionLabel}</span>
        <div className="settings-static-value">{version}</div>
      </div>

      <div className="settings-field">
        <span>{messages.updateLabel}</span>
        <div className="settings-static-value">{updateStatus}</div>
        <button
          type="button"
          className="soft-button"
          disabled={updateActionDisabled}
          onClick={onUpdateAction}
        >
          {updateActionLabel}
        </button>
      </div>

      <div className="settings-field">
        <span>{messages.vaultLabel}</span>
        <div className="settings-static-value">{vaultPath || "Resolving..."}</div>
      </div>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={showNoteTime}
          onChange={(event) => onShowNoteTimeChange(event.target.checked)}
        />
        <span>{messages.showTimeLabel}</span>
      </label>

      <label className="settings-field">
        <span>{messages.closeBehaviorLabel}</span>
        <select
          value={closeBehavior}
          onChange={(event) => onCloseBehaviorChange(event.target.value as "quit" | "tray")}
        >
          <option value="quit">{messages.closeBehaviorQuit}</option>
          <option value="tray">{messages.closeBehaviorTray}</option>
        </select>
      </label>

      <label className="settings-field">
        <span>{messages.colorPresetCountLabel}</span>
        <input
          type="number"
          min={1}
          max={8}
          value={colorPresetCount}
          onChange={(event) => onColorPresetCountChange(Number(event.target.value) || 1)}
        />
      </label>

      <div className="settings-field">
        <span>{messages.colorPresetsLabel}</span>
        <div className="settings-color-grid">
          {visiblePresets.map((color, index) => (
            <label key={`${index}-${color}`} className="settings-color-item">
              <span>{messages.colorPresetItemLabel.replace("{index}", String(index + 1))}</span>
              <input
                type="color"
                value={color}
                onChange={(event) => {
                  const next = [...colorPresets];
                  next[index] = event.target.value;
                  onColorPresetsChange(next);
                }}
              />
            </label>
          ))}
        </div>
      </div>
    </aside>
  );
}
