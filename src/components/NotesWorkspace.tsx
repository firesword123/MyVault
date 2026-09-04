import { type ClipboardEvent, type FormEvent, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pause,
  PenLine,
  Pencil,
  Search,
  Settings,
  Trash2,
  XCircle,
} from "lucide-react";
import type { NoteDetail, NoteSummary } from "../types";
import type { LocaleMessages } from "../i18n";
import { formatClockTime, formatRelativeTimestamp, formatTimestamp, noteRichText } from "../utils";

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
  onRevealFolder: (folderPath: string) => void;
  onRevealNote: (note: NoteSummary) => void;
  onDeleteNote: (note: NoteSummary) => void;
  onOpenSettings: () => void;
  onPlayerQuickAction: () => void;
  closePlayerOnPause: boolean;
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
  onRevealFolder,
  onRevealNote,
  onDeleteNote,
  onOpenSettings,
  onPlayerQuickAction,
  closePlayerOnPause,
  showTime,
  openFolders,
  onToggleFolder,
}: NotesListPanelProps) {
  const groups = groupNotes(messages, folders, filteredNotes);
  const noteIndex = new Map(filteredNotes.map((note) => [note.id, note]));
  const mainGroups = groups.filter((group) => group.key !== "trash");
  const [folderModal, setFolderModal] = useState<FolderModalState>(null);
  const [activeMenuFolder, setActiveMenuFolder] = useState<string | null>(null);
  const [dragTargetFolder, setDragTargetFolder] = useState<string | null>(null);
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const dragTargetFolderRef = useRef<string | null>(null);
  const pointerDragRef = useRef<{
    noteId: string;
    pointerId: number;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);
  const suppressNoteClickRef = useRef<string | null>(null);
  const [noteContextMenu, setNoteContextMenu] = useState<{
    note: NoteSummary;
    x: number;
    y: number;
  } | null>(null);
  const menuShellRef = useRef<HTMLDivElement | null>(null);
  const noteContextMenuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!menuShellRef.current?.contains(event.target as Node)) {
        setActiveMenuFolder(null);
      }
      if (!noteContextMenuRef.current?.contains(event.target as Node)) {
        setNoteContextMenu(null);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (key === "n") {
        event.preventDefault();
        onCreateNote();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [onCreateNote]);

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
      dragTargetFolderRef.current = null;
      setDraggingNoteId(null);
      return;
    }

    if (folderPath === "trash") {
      onTrashNote(noteId);
    } else {
      onMoveNoteToFolder(noteId, folderPath);
    }
    setDragTargetFolder(null);
    dragTargetFolderRef.current = null;
    setDraggingNoteId(null);
  }

  function resetPointerDrag() {
    pointerDragRef.current = null;
    dragTargetFolderRef.current = null;
    setDragTargetFolder(null);
    setDraggingNoteId(null);
  }

  function updatePointerDrag(clientX: number, clientY: number) {
    const drag = pointerDragRef.current;
    if (!drag) return;
    if (!drag.started && Math.hypot(clientX - drag.startX, clientY - drag.startY) >= 5) {
      drag.started = true;
      setDraggingNoteId(drag.noteId);
    }
    if (!drag.started) return;

    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-folder-drop]")
      ?.dataset.folderDrop;
    const draggedNote = noteIndex.get(drag.noteId);
    const nextTarget = target && target !== draggedNote?.folderPath ? target : null;
    dragTargetFolderRef.current = nextTarget;
    setDragTargetFolder(nextTarget);
  }

  function finishPointerDrag(noteId: string) {
    const drag = pointerDragRef.current;
    if (!drag?.started) {
      resetPointerDrag();
      return;
    }

    suppressNoteClickRef.current = noteId;
    window.setTimeout(() => {
      if (suppressNoteClickRef.current === noteId) suppressNoteClickRef.current = null;
    }, 0);
    const target = dragTargetFolderRef.current;
    resetPointerDrag();
    if (target) {
      handleFolderDrop(noteId, target);
    }
  }

  function renderGroup(group: NoteGroup) {
    return (
      <section
        key={group.key}
        className="note-group"
        data-folder-drop={group.key}
      >
        <div className="folder-row">
          <button
            type="button"
            className={`note-group-header ${activeFolderPath === group.key ? "is-active" : ""} ${
              dragTargetFolder === group.key ? "is-drop-target" : ""
            }`}
            onClick={() => onToggleFolder(group.key)}
            aria-expanded={openFolders[group.key] !== false}
          >
            <span className={`folder-chevron ${openFolders[group.key] !== false ? "is-open" : ""}`}>
              <ChevronRight size={14} strokeWidth={2.1} />
            </span>
            <span className="folder-glyph">
              {openFolders[group.key] !== false ? (
                <FolderOpen size={16} strokeWidth={1.8} />
              ) : (
                <Folder size={16} strokeWidth={1.8} />
              )}
            </span>
            <span className="folder-label">{group.label}</span>
            <span className="folder-count">{group.notes.length}</span>
          </button>

          {group.allowManage ? (
            <div className="folder-menu-shell" ref={activeMenuFolder === group.key ? menuShellRef : null}>
              {activeMenuFolder === group.key ? (
                <div className="folder-inline-actions">
                  <button
                    type="button"
                    className="icon-button folder-inline-action"
                    aria-label={messages.openFolderButton}
                    title={messages.openFolderButton}
                    onClick={() => {
                      onRevealFolder(group.key);
                      setActiveMenuFolder(null);
                    }}
                  >
                    <FolderOpen size={14} strokeWidth={1.8} />
                  </button>
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
              ) : (
                <button
                  type="button"
                  className="icon-button folder-menu-trigger"
                  aria-label={messages.folderOptionsButton}
                  title={messages.folderOptionsButton}
                  onClick={() => setActiveMenuFolder(group.key)}
                >
                  <MoreHorizontal size={15} strokeWidth={1.8} />
                </button>
              )}
            </div>
          ) : null}
        </div>

        <div className={`note-group-items ${openFolders[group.key] === false ? "is-collapsed" : ""}`}>
          {group.notes.map((note) => (
            <button
              key={note.id}
              type="button"
              className={`note-row ${selectedNoteId === note.id ? "is-selected" : ""} ${
                draggingNoteId === note.id ? "is-dragging" : ""
              } ${
                note.isTrashed ? "is-trashed" : ""
              }`}
              onClick={() => {
                if (suppressNoteClickRef.current === note.id) {
                  suppressNoteClickRef.current = null;
                  return;
                }
                onSelectNote(note.id);
              }}
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
              onPointerDown={(event) => {
                if (event.button !== 0 || note.isTrashed) return;
                pointerDragRef.current = {
                  noteId: note.id,
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  started: false,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (pointerDragRef.current?.pointerId !== event.pointerId) return;
                updatePointerDrag(event.clientX, event.clientY);
                if (pointerDragRef.current?.started) event.preventDefault();
              }}
              onPointerUp={(event) => {
                if (pointerDragRef.current?.pointerId !== event.pointerId) return;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                finishPointerDrag(note.id);
              }}
              onPointerCancel={(event) => {
                if (pointerDragRef.current?.pointerId === event.pointerId) resetPointerDrag();
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
          className="sidebar-action-button is-primary"
          onClick={onCreateNote}
          aria-label={messages.createButton}
          title={messages.createButton}
        >
          <PenLine size={17} strokeWidth={1.8} />
          <span>{messages.createButton}</span>
          <kbd>Ctrl N</kbd>
        </button>
        <button
          type="button"
          className="sidebar-action-button is-folder"
          onClick={() => setFolderModal({ mode: "create", value: "" })}
          aria-label={messages.createFolderButton}
          title={messages.createFolderButton}
        >
          <FolderPlus size={17} strokeWidth={1.8} />
        </button>
      </div>

      <label className="list-toolbar sidebar-search-section">
        <Search size={14} strokeWidth={2} />
        <input
          ref={searchInputRef}
          type="search"
          value={searchText}
          placeholder={messages.searchPlaceholder}
          onChange={(event) => onSearchTextChange(event.target.value)}
        />
        <kbd>Ctrl K</kbd>
      </label>

      <div className="notes-tree">
        <div className="notes-list">
          {booting ? <p className="empty-state">{messages.bootingLabel}</p> : null}

          {!booting && !filteredNotes.length ? (
            <p className="empty-state">{messages.emptySearchLabel}</p>
          ) : null}

          {mainGroups.map((group) => renderGroup(group))}
        </div>

      </div>

      <div className="notes-settings-dock">
        <button type="button" className="notes-settings-button" onClick={onOpenSettings}>
          <Settings size={17} strokeWidth={1.8} />
          <span>{messages.settingsTitle}</span>
        </button>
        <button type="button" className="notes-player-button" onClick={onPlayerQuickAction}>
          {closePlayerOnPause ? <XCircle size={17} strokeWidth={1.8} /> : <Pause size={17} strokeWidth={1.8} />}
          <span>{closePlayerOnPause ? messages.closePlayerButton : messages.pausePlayerButton}</span>
        </button>
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

    </>
  );
}

type EditorWorkspaceProps = {
  messages: LocaleMessages;
  language: string;
  activeNote: NoteDetail | null;
  draftMoveTargets: string[];
  draftTargetFolder: string;
  saveState: "saved" | "saving";
  onTitleChange: (value: string) => void;
  onContentChange: (value: string) => void;
  onSave: () => void;
  onDraftTargetFolderChange: (folderPath: string) => void;
  onSaveDraftToFolder: (folderPath: string) => void;
  onReveal: () => void;
  onDeleteDraft: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onDeletePermanently: () => void;
  errorMessage?: string;
};

export function EditorWorkspace({
  messages,
  language,
  activeNote,
  draftMoveTargets,
  draftTargetFolder,
  saveState,
  onTitleChange,
  onContentChange,
  onSave,
  onDraftTargetFolderChange,
  onSaveDraftToFolder,
  onReveal,
  onDeleteDraft,
  onDelete,
  onRestore,
  onDeletePermanently,
  errorMessage,
}: EditorWorkspaceProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const selectionRangeRef = useRef<Range | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const editorMoreRef = useRef<HTMLDivElement | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [editorMoreOpen, setEditorMoreOpen] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const activeContent = noteRichText(activeNote);

  useEffect(() => {
    const nextContent = toEditorHtml(activeContent);
    if (editorRef.current && editorRef.current.innerHTML !== nextContent) {
      editorRef.current.innerHTML = nextContent;
    }
    setWordCount((editorRef.current?.innerText ?? "").replace(/\s/g, "").length);
  }, [activeNote?.id, activeContent]);

  useEffect(() => {
    setCopyState("idle");
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, [activeNote?.id]);

  useEffect(() => {
    function closeEditorMore(event: MouseEvent) {
      if (!editorMoreRef.current?.contains(event.target as Node)) {
        setEditorMoreOpen(false);
      }
    }

    document.addEventListener("mousedown", closeEditorMore);
    return () => document.removeEventListener("mousedown", closeEditorMore);
  }, []);

  function emitEditorContent() {
    onContentChange(editorRef.current?.innerHTML ?? "");
  }

  function editorSelectionRange() {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return editor.contains(range.commonAncestorContainer) ? range : null;
  }

  function rememberSelection() {
    selectionRangeRef.current = editorSelectionRange()?.cloneRange() ?? null;
  }

  function restoreEditorRange() {
    const range = editorSelectionRange() ?? selectionRangeRef.current;
    const editor = editorRef.current;
    if (!range || !editor || !editor.contains(range.commonAncestorContainer)) return null;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return range;
  }

  function selectAfter(node: Node) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    selectionRangeRef.current = range.cloneRange();
  }

  function handleEditorInput(_event: FormEvent<HTMLDivElement>) {
    rememberSelection();
    setWordCount((editorRef.current?.innerText ?? "").replace(/\s/g, "").length);
    emitEditorContent();
  }

  function handleEditorPaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    const range = restoreEditorRange();
    if (!range) return;
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    lines.forEach((line, index) => {
      if (index > 0) fragment.appendChild(document.createElement("br"));
      fragment.appendChild(document.createTextNode(line));
    });
    const lastNode = fragment.lastChild;
    range.insertNode(fragment);
    if (lastNode) selectAfter(lastNode);
    emitEditorContent();
  }

  function applyBold() {
    const range = restoreEditorRange();
    if (!range || range.collapsed) return;
    const wrapper = document.createElement("strong");
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
    const selection = window.getSelection();
    range.selectNodeContents(wrapper);
    selection?.removeAllRanges();
    selection?.addRange(range);
    selectionRangeRef.current = range.cloneRange();
    emitEditorContent();
  }

  function showCopyState(state: "copied" | "failed") {
    setCopyState(state);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      copyResetTimerRef.current = null;
    }, 1600);
  }

  async function copyAllContent() {
    const editor = editorRef.current;
    if (!editor) return;
    const plainText = editor.innerText;
    const richText = editor.innerHTML;

    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([plainText], { type: "text/plain" }),
            "text/html": new Blob([richText], { type: "text/html" }),
          }),
        ]);
      } else if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard is unavailable");
      } else {
        await navigator.clipboard.writeText(plainText);
      }
      showCopyState("copied");
    } catch {
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("clipboard is unavailable");
        }
        await navigator.clipboard.writeText(plainText);
        showCopyState("copied");
      } catch {
        showCopyState("failed");
      }
    }
  }

  const folderLabel = activeNote
    ? activeNote.folderPath === "drafts"
      ? messages.draftsLabel
      : activeNote.folderPath === "inbox"
        ? messages.inboxLabel
        : activeNote.folderPath
    : "";

  return (
    <section className="editor-shell">
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      {activeNote ? (
        <>
          <header className="editor-topbar">
            <div className="editor-breadcrumb">
              <Folder size={14} strokeWidth={1.8} />
              <span>{folderLabel}</span>
              <span aria-hidden="true">/</span>
              <strong>{activeNote.title || messages.titlePlaceholder}</strong>
            </div>
            <div className="editor-top-actions">
              <span className={`editor-save-state ${saveState === "saving" ? "is-saving" : ""}`}>
                {saveState === "saving"
                  ? messages.saving
                  : `${messages.savedStatus} · ${formatClockTime(activeNote.updatedAt, language)}`}
              </span>
              <div className="editor-more-shell" ref={editorMoreRef}>
                <button
                  type="button"
                  className="editor-more-button"
                  aria-label={messages.folderOptionsButton}
                  title={messages.folderOptionsButton}
                  onClick={() => setEditorMoreOpen((current) => !current)}
                >
                  <MoreHorizontal size={17} strokeWidth={2} />
                </button>
                {editorMoreOpen ? (
                  <div className="editor-more-menu">
                    <button
                      type="button"
                      onClick={() => {
                        void copyAllContent();
                        setEditorMoreOpen(false);
                      }}
                    >
                      {messages.copyContentButton}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onReveal();
                        setEditorMoreOpen(false);
                      }}
                    >
                      {messages.revealNoteButton}
                    </button>
                    {!activeNote.isTrashed ? (
                      <button
                        type="button"
                        className="is-danger"
                        onClick={() => {
                          activeNote.folderPath === "drafts" ? onDeleteDraft() : onDelete();
                          setEditorMoreOpen(false);
                        }}
                      >
                        {messages.deleteButton}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <div className="editor-scroll">
            <div className="editor-panel">
              <input
                className="title-input"
                value={activeNote.title}
                disabled={activeNote.isTrashed}
                onChange={(event) => onTitleChange(event.target.value)}
                placeholder={messages.titlePlaceholder}
              />

              <div className="editor-meta">
                <span className="editor-meta-chip">
                  <Folder size={13} strokeWidth={1.8} />
                  {folderLabel}
                </span>
                <span>{messages.wordCountLabel.replace("{count}", String(wordCount))}</span>
                <span>
                  {messages.updatedRelativeLabel.replace(
                    "{time}",
                    formatRelativeTimestamp(activeNote.updatedAt, language),
                  )}
                </span>
              </div>

              <div
                ref={editorRef}
                className={`note-editor ${activeNote.isTrashed ? "is-readonly" : ""}`}
                contentEditable={!activeNote.isTrashed}
                suppressContentEditableWarning
                data-placeholder={messages.editorPlaceholder}
                onInput={handleEditorInput}
                onPaste={handleEditorPaste}
                onSelect={rememberSelection}
              />
            </div>
          </div>

          <div className="editor-bottom-bar">
            <div className="editor-format-actions">
              <button
                type="button"
                className="soft-button"
                disabled={activeNote.isTrashed}
                onMouseDown={(event) => event.preventDefault()}
                onClick={applyBold}
                aria-label={messages.boldButton}
                title={messages.boldButton}
              >
                <span className="bold-glyph">B</span>
              </button>

              <span className="toolbar-divider" aria-hidden="true" />

              <button
                type="button"
                className="soft-button"
                onClick={() => void copyAllContent()}
                aria-label={messages.copyContentButton}
                title={messages.copyContentButton}
              >
                {copyState === "copied" ? <Check size={16} strokeWidth={2} /> : <Copy size={16} strokeWidth={1.9} />}
                <span>
                  {copyState === "copied"
                    ? messages.contentCopiedLabel
                    : copyState === "failed"
                      ? messages.copyFailedLabel
                      : messages.copyContentButton}
                </span>
              </button>

            </div>

            <div className="editor-file-actions">
              {!activeNote.isTrashed ? (
                activeNote.folderPath === "drafts" ? (
                  <>
                    <select
                      className="draft-folder-select"
                      value={draftTargetFolder}
                      aria-label={messages.saveToFolderButton}
                      onChange={(event) => onDraftTargetFolderChange(event.target.value)}
                    >
                      {draftMoveTargets.map((folder) => (
                        <option key={folder} value={folder}>
                          {folder === "inbox" ? messages.inboxLabel : folder}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => onSaveDraftToFolder(draftTargetFolder)}
                    >
                      <span>{messages.saveToFolderButton}</span>
                      <kbd>Ctrl S</kbd>
                    </button>
                    <button type="button" className="danger-button" onClick={onDeleteDraft}>
                      {messages.deleteButton}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="primary-button" onClick={onSave}>
                      <span>{messages.saveButton}</span>
                      <kbd>Ctrl S</kbd>
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
                  <button type="button" className="danger-button" onClick={onDeletePermanently}>
                    {messages.deletePermanentlyButton}
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="empty-editor">
          <h3>{messages.emptyEditorTitle}</h3>
          <p>{messages.emptyEditorBody}</p>
        </div>
      )}
    </section>
  );
}
