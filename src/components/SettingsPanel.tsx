import { Activity, ArrowLeft, Eye, Globe2, ListMusic, RotateCcw, Search, Settings2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LocaleMessages } from "../i18n";
import type { NoteDetail, NoteSummary, ResourceUsage } from "../types";
import { formatTimestamp, noteRichText } from "../utils";

type SettingsSection = "general" | "player" | "network" | "resources" | "trash";

type SettingsPanelProps = {
  open: boolean;
  initialSection: SettingsSection;
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
  onUpdateAction: () => void;
  onViewTrashNote: (noteId: string) => Promise<NoteDetail | null>;
  onRestoreTrashNote: (noteId: string) => Promise<void>;
  onDeleteTrashNote: (noteId: string) => Promise<void>;
  onEmptyTrash: () => void;
  onClose: () => void;
};

export function SettingsPanel({
  open,
  initialSection,
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
  onUpdateAction,
  onViewTrashNote,
  onRestoreTrashNote,
  onDeleteTrashNote,
  onEmptyTrash,
  onClose,
}: SettingsPanelProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [searchText, setSearchText] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Pick<NoteSummary, "id" | "title"> | null>(null);
  const [viewedTrashNote, setViewedTrashNote] = useState<NoteDetail | null>(null);
  const [trashNoteLoading, setTrashNoteLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setActiveSection(initialSection);
      setViewedTrashNote(null);
    }
  }, [open, initialSection]);

  async function viewTrashNote(noteId: string) {
    setTrashNoteLoading(true);
    try {
      const detail = await onViewTrashNote(noteId);
      if (detail?.isTrashed) setViewedTrashNote(detail);
    } finally {
      setTrashNoteLoading(false);
    }
  }

  const sections = useMemo(
    () => [
      { id: "general" as const, label: messages.settingsGeneralSection, icon: Settings2 },
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
                  onClick={() => {
                    setActiveSection(section.id);
                    setViewedTrashNote(null);
                  }}
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
            <div className="settings-content-title">
              <span className="section-label">{messages.settingsTitle}</span>
              <h1>{activeLabel}</h1>
            </div>
            {activeSection === "trash" && !viewedTrashNote && trashNotes.length ? (
              <button type="button" className="danger-button settings-empty-trash-button" onClick={onEmptyTrash}>
                <Trash2 size={15} strokeWidth={1.8} />
                {messages.emptyTrashButton}
              </button>
            ) : null}
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
                      MyVault {formatMemory(resourceUsage.appMemoryBytes)} ({resourceUsage.appProcesses}) / MyVault WebView{" "}
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
              {viewedTrashNote ? (
                <div className="settings-trash-view">
                  <div className="settings-trash-document">
                    <h2>{viewedTrashNote.title}</h2>
                    <div className="editor-meta">
                      <span className="editor-meta-chip">
                        <Trash2 size={14} strokeWidth={1.7} />
                        {messages.trashLabel}
                      </span>
                      {viewedTrashNote.deletedAt ? (
                        <span>{messages.trashDeletedAtLabel.replace("{time}", formatTimestamp(viewedTrashNote.deletedAt))}</span>
                      ) : null}
                    </div>
                    <div
                      className="note-editor is-readonly settings-trash-note-body"
                      dangerouslySetInnerHTML={{ __html: noteRichText(viewedTrashNote) }}
                    />
                  </div>
                  <div className="settings-trash-view-actions">
                    <button
                      type="button"
                      className="soft-button"
                      onClick={async () => {
                        await onRestoreTrashNote(viewedTrashNote.id);
                        setViewedTrashNote(null);
                      }}
                    >
                      <RotateCcw size={15} strokeWidth={1.8} />
                      {messages.restoreButton}
                    </button>
                    <button type="button" className="danger-button" onClick={() => setPendingDelete(viewedTrashNote)}>
                      <Trash2 size={15} strokeWidth={1.8} />
                      {messages.deletePermanentlyButton}
                    </button>
                  </div>
                </div>
              ) : trashNoteLoading ? (
                <div className="settings-trash-empty">{messages.bootingLabel}</div>
              ) : trashNotes.length ? (
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
                        <button type="button" className="soft-button" onClick={() => void viewTrashNote(note.id)}>
                          <Eye size={15} strokeWidth={1.8} />
                          {messages.viewButton}
                        </button>
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
                  void onDeleteTrashNote(pendingDelete.id).then(() => {
                    if (viewedTrashNote?.id === pendingDelete.id) setViewedTrashNote(null);
                  });
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
