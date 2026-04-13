import { type ClipboardEvent, type FormEvent, useEffect, useRef, useState } from "react";
import {
  Bold,
  ChevronRight,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Palette,
  PenLine,
  Pencil,
  Trash2,
} from "lucide-react";
import type { NoteDetail, NoteSummary } from "../types";
import type { LocaleMessages } from "../i18n";
import { formatTimestamp } from "../utils";

type NotesListPanelProps = {
  messages: LocaleMessages;
  onCreateNote: () => void;
  searchText: string;
  onSearchTextChange: (value: string) => void;
  booting: boolean;
  folders: string[];
  filteredNotes: NoteSummary[];
  selectedNoteId: string;
  activeFolderPath: string;
  onSelectNote: (noteId: string) => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (fromPath: string, toPath: string) => void;
  onDeleteFolder: (path: string) => void;
  onMoveNoteToFolder: (noteId: string, folderPath: string) => void;
  onTrashNote: (noteId: string) => void;
  onRefreshNote: (noteId: string) => void;
  onRevealNote: (note: NoteSummary) => void;
  onDeleteNote: (note: NoteSummary) => void;
  onEmptyTrash: () => void;
  showTime: boolean;
  openFolders: Record<string, boolean>;
  onToggleFolder: (folderPath: string) => void;
};

type FolderModalState =
  | { mode: "create"; value: string }
  | { mode: "rename"; folderPath: string; value: string }
  | null;

type NoteGroup = {
  key: string;
  label: string;
  notes: NoteSummary[];
  allowManage: boolean;
};

function positionContextMenu(clientX: number, clientY: number, menuWidth: number, menuHeight: number) {
  const padding = 12;
  return {
    x: Math.min(clientX, window.innerWidth - menuWidth - padding),
    y: Math.min(clientY, window.innerHeight - menuHeight - padding),
  };
}

function escapeHtml(content: string) {
  return content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeUrl(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("mailto:") ||
    normalized.startsWith("tel:") ||
    normalized.startsWith("#") ||
    normalized.startsWith("/")
  );
}

function sanitizeStyleAttribute(value: string) {
  const allowedProperties = new Set([
    "color",
    "background-color",
    "font-weight",
    "font-style",
    "text-decoration",
  ]);

  return value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .map((declaration) => {
      const [property, ...rest] = declaration.split(":");
      if (!property || !rest.length) return null;
      const normalizedProperty = property.trim().toLowerCase();
      const normalizedValue = rest.join(":").trim();
      const lowerValue = normalizedValue.toLowerCase();
      if (!allowedProperties.has(normalizedProperty)) return null;
      if (
        !normalizedValue ||
        lowerValue.includes("url(") ||
        lowerValue.includes("expression(") ||
        lowerValue.includes("@import")
      ) {
        return null;
      }
      return `${normalizedProperty}: ${normalizedValue}`;
    })
    .filter((declaration): declaration is string => Boolean(declaration))
    .join("; ");
}

function sanitizeEditorHtml(content: string) {
  const template = document.createElement("template");
  template.innerHTML = content;

  const allowedTags = new Set([
    "A",
    "B",
    "BLOCKQUOTE",
    "BR",
    "CODE",
    "DIV",
    "EM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "I",
    "LI",
    "OL",
    "P",
    "PRE",
    "S",
    "SPAN",
    "STRONG",
    "U",
    "UL",
  ]);
  const dropWithContents = new Set(["IFRAME", "META", "OBJECT", "SCRIPT", "STYLE"]);

  function sanitizeNode(node: Node) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as HTMLElement;
    const tagName = element.tagName;

    if (dropWithContents.has(tagName)) {
      element.remove();
      return;
    }

    if (!allowedTags.has(tagName)) {
      const fragment = document.createDocumentFragment();
      while (element.firstChild) {
        fragment.appendChild(element.firstChild);
      }
      element.replaceWith(fragment);
      Array.from(fragment.childNodes).forEach(sanitizeNode);
      return;
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style") {
        const sanitizedStyle = sanitizeStyleAttribute(value);
        if (sanitizedStyle) {
          element.setAttribute("style", sanitizedStyle);
        } else {
          element.removeAttribute("style");
        }
        continue;
      }
      if (tagName === "A" && name === "href") {
        if (!isSafeUrl(value)) {
          element.removeAttribute("href");
        }
        continue;
      }
      if (!["href", "rel", "target"].includes(name)) {
        element.removeAttribute(attribute.name);
      }
    }

    if (tagName === "A") {
      element.setAttribute("rel", "noopener noreferrer");
      const href = element.getAttribute("href");
      if (href && /^https?:/i.test(href)) {
        element.setAttribute("target", "_blank");
      } else {
        element.removeAttribute("target");
      }
    }

    Array.from(element.childNodes).forEach(sanitizeNode);
  }

  Array.from(template.content.childNodes).forEach(sanitizeNode);
  return template.innerHTML;
}

function toEditorHtml(content: string) {
  if (!content.trim()) return "";
  if (/<[a-z][\s\S]*>/i.test(content)) return sanitizeEditorHtml(content);

  return escapeHtml(content)
    .split(/\n{2,}/)
    .map((block: string) => `<p>${block.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function groupNotes(messages: LocaleMessages, folders: string[], notes: NoteSummary[]): NoteGroup[] {
  const groups = new Map<string, NoteSummary[]>();

  for (const folder of folders) {
    groups.set(folder, groups.get(folder) ?? []);
  }

  for (const note of notes) {
    const current = groups.get(note.folderPath) ?? [];
    current.push(note);
    groups.set(note.folderPath, current);
  }

  const orderedKeys = Array.from(groups.keys()).sort((left, right) => {
    const rank = (value: string) => {
      if (value === "drafts") return 0;
      if (value === "inbox") return 1;
      if (value === "trash") return 3;
      return 2;
    };

    return rank(left) - rank(right) || left.localeCompare(right);
  });

  return orderedKeys.map((key) => ({
    key,
    label:
      key === "drafts"
        ? messages.draftsLabel
        : key === "inbox"
          ? messages.inboxLabel
          : key === "trash"
            ? messages.trashLabel
            : key,
    notes: groups.get(key) ?? [],
    allowManage: key !== "drafts" && key !== "inbox" && key !== "trash",
  }));
}

export function NotesListPanel({
  messages,
  onCreateNote,
  searchText,
  onSearchTextChange,
  booting,
  folders,
  filteredNotes,
  selectedNoteId,
  activeFolderPath,
  onSelectNote,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveNoteToFolder,
  onTrashNote,
  onRefreshNote,
  onRevealNote,
  onDeleteNote,
  onEmptyTrash,
  showTime,
  openFolders,
  onToggleFolder,
}: NotesListPanelProps) {
  const groups = groupNotes(messages, folders, filteredNotes).filter((group) => group.key !== "drafts");
  const noteIndex = new Map(filteredNotes.map((note) => [note.id, note]));
  const pinnedTrashGroup = groups.find((group) => group.key === "trash") ?? null;
  const mainGroups = groups.filter((group) => group.key !== "trash");
  const [folderModal, setFolderModal] = useState<FolderModalState>(null);
  const [activeMenuFolder, setActiveMenuFolder] = useState<string | null>(null);
  const [dragTargetFolder, setDragTargetFolder] = useState<string | null>(null);
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const draggingNoteIdRef = useRef<string | null>(null);
  const [noteContextMenu, setNoteContextMenu] = useState<{
    note: NoteSummary;
    x: number;
    y: number;
  } | null>(null);
  const [trashContextMenu, setTrashContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const menuShellRef = useRef<HTMLDivElement | null>(null);
  const noteContextMenuRef = useRef<HTMLDivElement | null>(null);
  const trashContextMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!menuShellRef.current?.contains(event.target as Node)) {
        setActiveMenuFolder(null);
      }
      if (!noteContextMenuRef.current?.contains(event.target as Node)) {
        setNoteContextMenu(null);
      }
      if (!trashContextMenuRef.current?.contains(event.target as Node)) {
        setTrashContextMenu(null);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  function submitFolderModal() {
    if (!folderModal) return;

    const value = folderModal.value.trim();
    if (!value) return;

    if (folderModal.mode === "create") {
      onCreateFolder(value);
    } else {
      onRenameFolder(folderModal.folderPath, value);
    }

    setFolderModal(null);
  }

  function handleFolderDrop(noteId: string, folderPath: string) {
    const draggedNote = noteIndex.get(noteId);
    if (!draggedNote || draggedNote.folderPath === folderPath) {
      setDragTargetFolder(null);
      setDraggingNoteId(null);
      return;
    }

    if (folderPath === "trash") {
      onTrashNote(noteId);
    } else {
      onMoveNoteToFolder(noteId, folderPath);
    }
    setDragTargetFolder(null);
    setDraggingNoteId(null);
    draggingNoteIdRef.current = null;
  }

  function renderGroup(group: NoteGroup, options?: { pinnedTrash?: boolean }) {
    const isPinnedTrash = options?.pinnedTrash === true;

    return (
      <section
        key={group.key}
        className={`note-group ${isPinnedTrash ? "note-group-trash-dock" : ""}`}
      >
        <div
          className="folder-row"
          onDragOver={(event) => {
            const draggedNoteId =
              event.dataTransfer.getData("text/plain") || draggingNoteIdRef.current || draggingNoteId;
            if (!draggedNoteId) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDragTargetFolder(group.key);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragTargetFolder((current) => (current === group.key ? null : current));
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            const noteId = event.dataTransfer.getData("text/plain");
            if (noteId) {
              handleFolderDrop(noteId, group.key);
            }
          }}
        >
          <button
            type="button"
            className={`note-group-header ${activeFolderPath === group.key ? "is-active" : ""} ${
              dragTargetFolder === group.key ? "is-drop-target" : ""
            } ${isPinnedTrash ? "is-trash-folder" : ""}`}
            onClick={() => onToggleFolder(group.key)}
            onContextMenu={(event) => {
              if (!isPinnedTrash) return;
              event.preventDefault();
              const nextPosition = positionContextMenu(event.clientX, event.clientY, 180, 52);
              setTrashContextMenu({
                x: nextPosition.x,
                y: nextPosition.y,
              });
            }}
          >
            <span className={`folder-caret ${openFolders[group.key] !== false ? "is-open" : ""}`}>
              <ChevronRight size={14} strokeWidth={1.8} />
            </span>
            <span className="folder-glyph">
              {isPinnedTrash ? <Trash2 size={15} strokeWidth={1.8} /> : <Folder size={15} strokeWidth={1.8} />}
            </span>
            <span>{group.label}</span>
          </button>

          {group.allowManage ? (
            <div className="folder-menu-shell" ref={activeMenuFolder === group.key ? menuShellRef : null}>
              <button
                type="button"
                className="icon-button folder-menu-trigger"
                aria-label={messages.renameFolderButton}
                title={messages.renameFolderButton}
                onClick={() =>
                  setActiveMenuFolder((current) => (current === group.key ? null : group.key))
                }
              >
                <MoreHorizontal size={15} strokeWidth={1.8} />
              </button>

              {activeMenuFolder === group.key ? (
                <div className="folder-inline-actions">
                  <button
                    type="button"
                    className="icon-button folder-inline-action"
                    aria-label={messages.renameFolderButton}
                    title={messages.renameFolderButton}
                    onClick={() => {
                      setFolderModal({
                        mode: "rename",
                        folderPath: group.key,
                        value: group.key,
                      });
                      setActiveMenuFolder(null);
                    }}
                  >
                    <Pencil size={14} strokeWidth={1.8} />
                  </button>
                  <button
                    type="button"
                    className="icon-button folder-inline-action is-danger"
                    aria-label={messages.deleteFolderButton}
                    title={messages.deleteFolderButton}
                    onClick={() => {
                      onDeleteFolder(group.key);
                      setActiveMenuFolder(null);
                    }}
                  >
                    <Trash2 size={14} strokeWidth={1.8} />
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className={`note-group-items ${openFolders[group.key] === false ? "is-collapsed" : ""}`}>
          {group.notes.map((note) => (
            <button
              key={note.id}
              type="button"
              draggable={!note.isTrashed}
              className={`note-row ${selectedNoteId === note.id ? "is-selected" : ""} ${
                draggingNoteId === note.id ? "is-dragging" : ""
              } ${
                note.isTrashed ? "is-trashed" : ""
              }`}
              onClick={() => onSelectNote(note.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                onSelectNote(note.id);
                const nextPosition = positionContextMenu(event.clientX, event.clientY, 180, 118);
                setNoteContextMenu({
                  note,
                  x: nextPosition.x,
                  y: nextPosition.y,
                });
              }}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/plain", note.id);
                event.dataTransfer.effectAllowed = "move";
                setDraggingNoteId(note.id);
                draggingNoteIdRef.current = note.id;
              }}
              onDragEnd={() => {
                setDragTargetFolder(null);
                setDraggingNoteId(null);
                draggingNoteIdRef.current = null;
              }}
            >
              <div className="note-row-header">
                <strong>{note.title}</strong>
                {showTime ? <span>{formatTimestamp(note.deletedAt ?? note.updatedAt)}</span> : null}
              </div>
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <>
      <div className="sidebar-action-stack">
        <button
          type="button"
          className="sidebar-action-button"
          onClick={onCreateNote}
          aria-label={messages.createButton}
          title={messages.createButton}
        >
          <PenLine size={17} strokeWidth={1.8} />
          <span>{messages.createButton}</span>
        </button>
        <button
          type="button"
          className="sidebar-action-button"
          onClick={() => setFolderModal({ mode: "create", value: "" })}
          aria-label={messages.createFolderButton}
          title={messages.createFolderButton}
        >
          <FolderPlus size={17} strokeWidth={1.8} />
          <span>{messages.createFolderButton}</span>
        </button>
      </div>

      <div className="list-toolbar sidebar-search-section">
        <input
          type="search"
          value={searchText}
          placeholder={messages.searchPlaceholder}
          onChange={(event) => onSearchTextChange(event.target.value)}
        />
      </div>

      <div className="notes-tree">
        <div className="notes-list">
          {booting ? <p className="empty-state">{messages.bootingLabel}</p> : null}

          {!booting && !filteredNotes.length ? (
            <p className="empty-state">{messages.emptySearchLabel}</p>
          ) : null}

          {mainGroups.map((group) => renderGroup(group))}
        </div>

        {pinnedTrashGroup ? <div className="notes-trash-dock">{renderGroup(pinnedTrashGroup, { pinnedTrash: true })}</div> : null}
      </div>

      {folderModal ? (
        <div className="inline-modal-backdrop" onClick={() => setFolderModal(null)}>
          <div className="inline-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inline-modal-header">
              <h3>
                {folderModal.mode === "create"
                  ? messages.createFolderTitle
                  : messages.renameFolderTitle}
              </h3>
            </div>

            <label className="settings-field">
              <span>{messages.folderNameLabel}</span>
              <input
                autoFocus
                type="text"
                value={folderModal.value}
                onChange={(event) =>
                  setFolderModal((current) => (current ? { ...current, value: event.target.value } : current))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    submitFolderModal();
                  }
                }}
              />
            </label>

            <div className="inline-modal-actions">
              <button type="button" className="soft-button" onClick={() => setFolderModal(null)}>
                {messages.cancelButton}
              </button>
              <button type="button" className="soft-button" onClick={submitFolderModal}>
                {messages.confirmButton}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {noteContextMenu ? (
        <div
          ref={noteContextMenuRef}
          className="note-context-menu"
          style={{
            left: `${noteContextMenu.x}px`,
            top: `${noteContextMenu.y}px`,
          }}
        >
          <button
            type="button"
            className="note-context-menu-item"
            onClick={() => {
              onRefreshNote(noteContextMenu.note.id);
              setNoteContextMenu(null);
            }}
          >
            {messages.refreshButton}
          </button>
          <button
            type="button"
            className="note-context-menu-item"
            onClick={() => {
              onRevealNote(noteContextMenu.note);
              setNoteContextMenu(null);
            }}
          >
            {messages.revealNoteButton}
          </button>
          <button
            type="button"
            className="note-context-menu-item is-danger"
            onClick={() => {
              onDeleteNote(noteContextMenu.note);
              setNoteContextMenu(null);
            }}
          >
            {messages.deleteButton}
          </button>
        </div>
      ) : null}

      {trashContextMenu ? (
        <div
          ref={trashContextMenuRef}
          className="note-context-menu"
          style={{
            left: `${trashContextMenu.x}px`,
            top: `${trashContextMenu.y}px`,
          }}
        >
          <button
            type="button"
            className="note-context-menu-item is-danger"
            onClick={() => {
              onEmptyTrash();
              setTrashContextMenu(null);
            }}
          >
            {messages.emptyTrashButton}
          </button>
        </div>
      ) : null}
    </>
  );
}

type EditorWorkspaceProps = {
  messages: LocaleMessages;
  activeNote: NoteDetail | null;
  colorPresets: string[];
  draftMoveTargets: string[];
  draftTargetFolder: string;
  onTitleChange: (value: string) => void;
  onContentChange: (value: string) => void;
  onSave: () => void;
  onDraftTargetFolderChange: (folderPath: string) => void;
  onSaveDraftToFolder: (folderPath: string) => void;
  onClearDraft: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onDeletePermanently: () => void;
  onEmptyTrash: () => void;
  errorMessage?: string;
};

export function EditorWorkspace({
  messages,
  activeNote,
  colorPresets,
  draftMoveTargets,
  draftTargetFolder,
  onTitleChange,
  onContentChange,
  onSave,
  onDraftTargetFolderChange,
  onSaveDraftToFolder,
  onClearDraft,
  onDelete,
  onRestore,
  onDeletePermanently,
  onEmptyTrash,
  errorMessage,
}: EditorWorkspaceProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const colorInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const nextContent = toEditorHtml(activeNote?.content ?? "");
    if (editorRef.current && editorRef.current.innerHTML !== nextContent) {
      editorRef.current.innerHTML = nextContent;
    }
  }, [activeNote?.id, activeNote?.content]);

  function emitEditorContent() {
    onContentChange(editorRef.current?.innerHTML ?? "");
  }

  function handleEditorInput(_event: FormEvent<HTMLDivElement>) {
    emitEditorContent();
  }

  function handleEditorPaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
    emitEditorContent();
  }

  function applyCommand(command: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    emitEditorContent();
  }

  return (
    <section className="editor-shell">
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      {activeNote ? (
        <div className="editor-panel">
          <input
            className="title-input"
            value={activeNote.title}
            disabled={activeNote.isTrashed}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder={messages.titlePlaceholder}
          />

          <div
            ref={editorRef}
            className={`note-editor ${activeNote.isTrashed ? "is-readonly" : ""}`}
            contentEditable={!activeNote.isTrashed}
            suppressContentEditableWarning
            data-placeholder={messages.editorPlaceholder}
            onInput={handleEditorInput}
            onPaste={handleEditorPaste}
          />

          <div className="editor-bottom-bar">
            <div className="editor-format-actions">
              <button
                type="button"
                className="soft-button"
                disabled={activeNote.isTrashed}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyCommand("bold")}
                aria-label={messages.boldButton}
                title={messages.boldButton}
              >
                <Bold size={16} strokeWidth={2} />
              </button>

              {colorPresets.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="color-swatch-button"
                  disabled={activeNote.isTrashed}
                  style={{ ["--swatch-color" as string]: color }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyCommand("foreColor", color)}
                  aria-label={messages.applyColorLabel.replace("{color}", color)}
                  title={color}
                />
              ))}

              <button
                type="button"
                className="soft-button"
                disabled={activeNote.isTrashed}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => colorInputRef.current?.click()}
                aria-label={messages.customColorButton}
                title={messages.customColorButton}
              >
                <Palette size={16} strokeWidth={1.9} />
              </button>

              <input
                ref={colorInputRef}
                className="visually-hidden"
                type="color"
                defaultValue={colorPresets[0] || "#3b82f6"}
                onChange={(event) => applyCommand("foreColor", event.target.value)}
              />
            </div>

            <div className="editor-file-actions">
              {!activeNote.isTrashed ? (
                activeNote.folderPath === "drafts" ? (
                  <>
                    <label className="move-note-field">
                      <span>{messages.moveTargetLabel}</span>
                      <select
                        value={draftTargetFolder}
                        onChange={(event) => onDraftTargetFolderChange(event.target.value)}
                      >
                        {draftMoveTargets.map((folder) => (
                          <option key={folder} value={folder}>
                            {folder === "inbox" ? messages.inboxLabel : folder}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="soft-button"
                      onClick={() => onSaveDraftToFolder(draftTargetFolder)}
                    >
                      {messages.saveToFolderButton}
                    </button>
                    <button type="button" className="danger-button" onClick={onClearDraft}>
                      {messages.clearDraftButton}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="soft-button" onClick={onSave}>
                      {messages.saveButton}
                    </button>
                    <button type="button" className="danger-button" onClick={onDelete}>
                      {messages.deleteButton}
                    </button>
                  </>
                )
              ) : (
                <>
                  <button type="button" className="soft-button" onClick={onRestore}>
                    {messages.restoreButton}
                  </button>
                  <button type="button" className="soft-button" onClick={onEmptyTrash}>
                    {messages.emptyTrashButton}
                  </button>
                  <button type="button" className="danger-button" onClick={onDeletePermanently}>
                    {messages.deletePermanentlyButton}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="empty-editor">
          <h3>{messages.emptyEditorTitle}</h3>
          <p>{messages.emptyEditorBody}</p>
        </div>
      )}
    </section>
  );
}
