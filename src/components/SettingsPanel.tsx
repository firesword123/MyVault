import { Activity, ArrowLeft, Globe2, ListMusic, Palette, RotateCcw, Search, Settings2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { LocaleMessages } from "../i18n";
import type { NoteSummary, ResourceUsage } from "../types";
import { formatTimestamp } from "../utils";

type SettingsPanelProps = {
  open: boolean;
  messages: LocaleMessages;
  version: string;
  updateStatus: string;
  updateActionLabel: string;
  updateActionDisabled: boolean;
  language: string;
  showNoteTime: boolean;
  showMemoryInTitlebar: boolean;
  closePlayerOnPause: boolean;
  closeBehavior: "quit" | "tray";
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  noProxy: string;
  vaultPath: string;
  colorPresets: string[];
  colorPresetCount: number;
  resourceUsage: ResourceUsage | null;
  trashNotes: NoteSummary[];
  onLanguageChange: (language: string) => void;
  onShowNoteTimeChange: (checked: boolean) => void;
  onShowMemoryInTitlebarChange: (checked: boolean) => void;
  onClosePlayerOnPauseChange: (checked: boolean) => void;
  onCloseBehaviorChange: (behavior: "quit" | "tray") => void;
  onHttpProxyChange: (value: string) => void;
  onHttpsProxyChange: (value: string) => void;
  onAllProxyChange: (value: string) => void;
  onNoProxyChange: (value: string) => void;
  onColorPresetsChange: (colors: string[]) => void;
  onColorPresetCountChange: (count: number) => void;
  onUpdateAction: () => void;
  onRestoreTrashNote: (noteId: string) => void;
  onDeleteTrashNote: (noteId: string) => void;
  onClose: () => void;
};

type SettingsSection = "general" | "appearance" | "player" | "network" | "resources" | "trash";

export function SettingsPanel({
  open,
  messages,
  version,
  updateStatus,
  updateActionLabel,
  updateActionDisabled,
  language,
  showNoteTime,
  showMemoryInTitlebar,
  closePlayerOnPause,
  closeBehavior,
  httpProxy,
  httpsProxy,
  allProxy,
  noProxy,
  vaultPath,
  colorPresets,
  colorPresetCount,
  resourceUsage,
  trashNotes,
  onLanguageChange,
  onShowNoteTimeChange,
  onShowMemoryInTitlebarChange,
  onClosePlayerOnPauseChange,
  onCloseBehaviorChange,
  onHttpProxyChange,
  onHttpsProxyChange,
  onAllProxyChange,
  onNoProxyChange,
  onColorPresetsChange,
  onColorPresetCountChange,
  onUpdateAction,
  onRestoreTrashNote,
  onDeleteTrashNote,
  onClose,
}: SettingsPanelProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [searchText, setSearchText] = useState("");
  const [pendingDelete, setPendingDelete] = useState<NoteSummary | null>(null);

  const sections = useMemo(
    () => [
      { id: "general" as const, label: messages.settingsGeneralSection, icon: Settings2 },
      { id: "appearance" as const, label: messages.settingsAppearanceSection, icon: Palette },
      { id: "player" as const, label: messages.settingsPlayerSection, icon: ListMusic },
      { id: "network" as const, label: messages.networkSectionLabel, icon: Globe2 },
      { id: "resources" as const, label: messages.settingsResourcesSection, icon: Activity },
      { id: "trash" as const, label: messages.trashLabel, icon: Trash2 },
    ],
    [messages],
  );
  const normalizedSearch = searchText.trim().toLocaleLowerCase();
  const visibleSections = sections.filter((section) =>
    section.label.toLocaleLowerCase().includes(normalizedSearch),
  );
  const activeLabel = sections.find((section) => section.id === activeSection)?.label ?? messages.settingsTitle;
  const visiblePresets = Array.from(
    { length: colorPresetCount },
    (_, index) => colorPresets[index] || "#3b82f6",
  );
  const formatMemory = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const formatCpu = (value: number) => `${value.toFixed(1)}%`;

  if (!open) return null;

  return (
    <div className="module-body settings-workspace">
      <aside className="settings-sidebar">
        <button type="button" className="settings-back-button" onClick={onClose}>
          <ArrowLeft size={17} strokeWidth={1.8} />
          <span>{messages.settingsBackLabel}</span>
        </button>

        <label className="settings-search">
          <Search size={17} strokeWidth={1.7} />
          <input
            type="search"
            value={searchText}
            placeholder={messages.settingsSearchPlaceholder}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </label>

        <div className="settings-nav-group">
          <span className="settings-nav-heading">{messages.settingsTitle}</span>
          <nav className="settings-nav">
            {visibleSections.map((section) => {
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  type="button"
                  className={activeSection === section.id ? "is-active" : ""}
                  onClick={() => setActiveSection(section.id)}
                >
                  <Icon size={18} strokeWidth={1.7} />
                  <span>{section.label}</span>
                </button>
              );
            })}
            {!visibleSections.length ? (
              <p className="settings-nav-empty">{messages.settingsEmptySearch}</p>
            ) : null}
          </nav>
        </div>
      </aside>

      <main className="settings-content">
        <div className="settings-content-inner">
          <header className="settings-content-header">
            <span className="section-label">{messages.settingsTitle}</span>
            <h1>{activeLabel}</h1>
          </header>

          {activeSection === "general" ? (
            <section className="settings-section">
              <h2>{messages.settingsGeneralSection}</h2>
              <div className="settings-card">
                <label className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{messages.showMemoryInTitlebarLabel}</strong>
                    <small>{messages.showMemoryInTitlebarHint}</small>
                  </span>
                  <input
                    className="settings-switch"
                    type="checkbox"
                    checked={showMemoryInTitlebar}
                    onChange={(event) => onShowMemoryInTitlebarChange(event.target.checked)}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{messages.languageLabel}</strong>
                  </span>
                  <select value={language} onChange={(event) => onLanguageChange(event.target.value)}>
                    <option value="zh-CN">{messages.languageZhCn}</option>
                    <option value="en-US">{messages.languageEnUs}</option>
                  </select>
                </label>
                <div className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{messages.vaultLabel}</strong>
                  </span>
                  <span className="settings-row-value is-path">{vaultPath || "Resolving..."}</span>
                </div>
                <label className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{messages.showTimeLabel}</strong>
                  </span>
                  <input
                    className="settings-switch"
                    type="checkbox"
                    checked={showNoteTime}
                    onChange={(event) => onShowNoteTimeChange(event.target.checked)}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{messages.closeBehaviorLabel}</strong>
                    <small>{messages.closeBehaviorHint}</small>
                  </span>
                  <select
                    value={closeBehavior}
                    onChange={(event) => onCloseBehaviorChange(event.target.value as "quit" | "tray")}
                  >
                    <option value="quit">{messages.closeBehaviorQuit}</option>
                    <option value="tray">{messages.closeBehaviorTray}</option>
                  </select>
                </label>
              </div>
            </section>
          ) : null}

          {activeSection === "appearance" ? (
            <section className="settings-section">
              <h2>{messages.settingsAppearanceSection}</h2>
              <div className="settings-card">
                <label className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{messages.colorPresetCountLabel}</strong>
                  </span>
                  <input
                    className="settings-number-input"
                    type="number"
                    min={1}
                    max={8}
                    value={colorPresetCount}
                    onChange={(event) => onColorPresetCountChange(Number(event.target.value) || 1)}
                  />
                </label>
                <div className="settings-row settings-colors-row">
                  <span className="settings-row-copy">
                    <strong>{messages.colorPresetsLabel}</strong>
                  </span>
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
              </div>
            </section>
          ) : null}

          {activeSection === "player" ? (
            <section className="settings-section">
              <h2>{messages.settingsPlayerSection}</h2>
              <div className="settings-card">
                <label className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{messages.closePlayerOnPauseLabel}</strong>
                    <small>{messages.closePlayerOnPauseHint}</small>
                  </span>
                  <input
                    className="settings-switch"
                    type="checkbox"
                    checked={closePlayerOnPause}
                    onChange={(event) => onClosePlayerOnPauseChange(event.target.checked)}
                  />
                </label>
              </div>
            </section>
          ) : null}

          {activeSection === "network" ? (
            <section className="settings-section">
              <h2>{messages.networkSectionLabel}</h2>
              <p className="settings-section-hint">{messages.networkHint}</p>
              <div className="settings-card">
                {[
                  [messages.httpProxyLabel, httpProxy, "http://127.0.0.1:7890", onHttpProxyChange],
                  [messages.httpsProxyLabel, httpsProxy, "http://127.0.0.1:7890", onHttpsProxyChange],
                  [messages.allProxyLabel, allProxy, "socks5://127.0.0.1:7891", onAllProxyChange],
                  [messages.noProxyLabel, noProxy, "localhost,127.0.0.1,.corp.local", onNoProxyChange],
                ].map(([label, value, placeholder, onChange]) => (
                  <label className="settings-row" key={label as string}>
                    <span className="settings-row-copy"><strong>{label as string}</strong></span>
                    <input
                      className="settings-text-input"
                      type="text"
                      value={value as string}
                      placeholder={placeholder as string}
                      onChange={(event) => (onChange as (value: string) => void)(event.target.value)}
                    />
                  </label>
                ))}
              </div>
            </section>
          ) : null}

          {activeSection === "resources" ? (
            <section className="settings-section">
              <h2>{messages.settingsResourcesSection}</h2>
              <div className="settings-resource-summary">
                {resourceUsage ? (
                  <>
                    <div>
                      <span>{messages.settingsTotalMemoryLabel}</span>
                      <strong>{formatMemory(resourceUsage.totalMemoryBytes)}</strong>
                    </div>
                    <div>
                      <span>CPU</span>
                      <strong>{formatCpu(resourceUsage.totalCpuPercent)}</strong>
                    </div>
                    <small>
                      App {formatMemory(resourceUsage.appMemoryBytes)} / WebView{" "}
                      {formatMemory(resourceUsage.webviewMemoryBytes)} ({resourceUsage.webviewProcesses})
                    </small>
                  </>
                ) : (
                  <small>{messages.settingsWaitingSample}</small>
                )}
              </div>
              <h2>{messages.settingsApplicationSection}</h2>
              <div className="settings-card">
                <div className="settings-row">
                  <span className="settings-row-copy"><strong>{messages.versionLabel}</strong></span>
                  <span className="settings-row-value">{version}</span>
                </div>
                <div className="settings-row">
                  <span className="settings-row-copy">
                    <strong>{messages.updateLabel}</strong>
                    <small>{updateStatus}</small>
                  </span>
                  <button
                    type="button"
                    className="soft-button settings-update-button"
                    disabled={updateActionDisabled}
                    onClick={onUpdateAction}
                  >
                    {updateActionLabel}
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {activeSection === "trash" ? (
            <section className="settings-section settings-trash-section">
              <h2>{messages.trashLabel}</h2>
              {trashNotes.length ? (
                <div className="settings-trash-list">
                  {trashNotes.map((note) => (
                    <article className="settings-trash-item" key={note.id}>
                      <div className="settings-trash-copy">
                        <strong>{note.title}</strong>
                        <span>{note.relativePath}</span>
                        {note.deletedAt ? (
                          <small>{messages.trashDeletedAtLabel.replace("{time}", formatTimestamp(note.deletedAt))}</small>
                        ) : null}
                      </div>
                      <div className="settings-trash-actions">
                        <button type="button" className="soft-button" onClick={() => onRestoreTrashNote(note.id)}>
                          <RotateCcw size={15} strokeWidth={1.8} />
                          {messages.restoreButton}
                        </button>
                        <button type="button" className="danger-button" onClick={() => setPendingDelete(note)}>
                          <Trash2 size={15} strokeWidth={1.8} />
                          {messages.deleteButton}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="settings-trash-empty">
                  <Trash2 size={24} strokeWidth={1.6} />
                  <span>{messages.trashEmptyLabel}</span>
                </div>
              )}
            </section>
          ) : null}
        </div>
      </main>

      {pendingDelete ? (
        <div className="inline-modal-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="inline-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inline-modal-header">
              <h3>{messages.deleteNotePermanentConfirmTitle}</h3>
            </div>
            <p className="settings-confirm-copy">
              {messages.deleteNotePermanentConfirmBody}
            </p>
            <strong className="settings-confirm-note">{pendingDelete.title}</strong>
            <div className="inline-modal-actions">
              <button type="button" className="soft-button" onClick={() => setPendingDelete(null)}>
                {messages.cancelButton}
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  onDeleteTrashNote(pendingDelete.id);
                  setPendingDelete(null);
                }}
              >
                {messages.confirmButton}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
