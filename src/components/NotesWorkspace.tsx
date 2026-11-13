import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  PenLine,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import type { NoteDetail, NoteSummary } from "../types";
import type { LocaleMessages } from "../i18n";
import { formatRelativeTimestamp, formatTimestamp, noteRichText } from "../utils";

export type SaveState = "saved" | "unsaved" | "saving" | "failed";

export const TRASH_FOLDER = "trash";
export const INBOX_FOLDER = "inbox";

/** Folders are one level deep; notes in legacy nested directories belong to their top folder. */
export function topFolder(folderPath: string) {
  return folderPath.split("/")[0] || INBOX_FOLDER;
}

/**
 * Folders keep the order the user dragged them into. Folders missing from the
 * saved order (new or created outside MyVault) follow the ordered ones.
 */
export function orderFolders(folders: string[], order: string[]) {
  const rank = new Map(order.map((key, index) => [key, index]));
  return folders
    .filter((key) => key !== TRASH_FOLDER && key !== "drafts" && !key.includes("/"))
    .sort((left, right) => {
      const leftRank = rank.get(left) ?? Number.POSITIVE_INFINITY;
      const rightRank = rank.get(right) ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (left === INBOX_FOLDER) return -1;
      if (right === INBOX_FOLDER) return 1;
      return left.localeCompare(right);
    });
}

function moveFolder(folders: string[], draggedKey: string, targetKey: string, position: "before" | "after") {
  const next = folders.filter((key) => key !== draggedKey);
  const targetIndex = next.indexOf(targetKey);
  if (targetIndex === -1) return folders;
  next.splice(position === "before" ? targetIndex : targetIndex + 1, 0, draggedKey);
  return next;
}

type NotesListPanelProps = {
  messages: LocaleMessages;
  active: boolean;
  booting: boolean;
  folders: string[];
  currentFolder: string;
  onSelectFolder: (folderPath: string) => void;
  onReorderFolders: (order: string[]) => void;
  notes: NoteSummary[];
  searchText: string;
  onSearchTextChange: (value: string) => void;
  matchedFolders: string[];
  saveStatus: string;
  saveState: SaveState;
  onRetrySave: () => void;
  selectedNoteId: string;
  onSelectNote: (note: NoteSummary) => void;
  onCreateNote: () => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (fromPath: string, toPath: string) => void;
  onDeleteFolder: (path: string) => void;
  onMoveNoteToFolder: (noteId: string, folderPath: string) => void;
  onTrashNote: (noteId: string) => void;
  onRefreshNote: (noteId: string) => void;
  onRevealFolder: (folderPath: string) => void;
  onRevealNote: (note: NoteSummary) => void;
  onDeleteNote: (note: NoteSummary) => void;
  onOpenTrash: () => void;
  showTime: boolean;
};

type FolderModalState =
  | { mode: "create"; value: string }
  | { mode: "rename"; folderPath: string; value: string }
  | null;

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

export function folderDisplayName(messages: LocaleMessages, folderPath: string) {
  if (folderPath === INBOX_FOLDER) return messages.inboxLabel;
  if (folderPath === TRASH_FOLDER) return messages.trashLabel;
  if (folderPath === "drafts") return messages.draftsLabel;
  return folderPath;
}

const CJK_PATTERN = /[⺀-鿿가-힯豈-﫿]/;

/**
 * Tile text: CJK names show up to four characters (four as a 2x2 block);
 * Latin names show in full, shrinking and wrapping to at most two lines.
 */
function folderTileLabel(name: string): { lines: string[]; size: "lg" | "md" | "sm" } {
  const trimmed = name.trim() || "?";
  if (CJK_PATTERN.test(Array.from(trimmed)[0])) {
    const chars = Array.from(trimmed.replace(/\s+/g, "")).slice(0, 4);
    if (chars.length === 4) return { lines: [chars.slice(0, 2).join(""), chars.slice(2).join("")], size: "md" };
    return { lines: [chars.join("")], size: chars.length <= 2 ? "lg" : "md" };
  }
  const length = trimmed.length;
  return { lines: [trimmed], size: length <= 3 ? "lg" : length <= 6 ? "md" : "sm" };
}

export function NotesListPanel({
  messages,
  active,
  booting,
  folders,
  currentFolder,
  onSelectFolder,
  onReorderFolders,
  notes,
  searchText,
  onSearchTextChange,
  matchedFolders,
  saveStatus,
  saveState,
  onRetrySave,
  selectedNoteId,
  onSelectNote,
  onCreateNote,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveNoteToFolder,
  onTrashNote,
  onRefreshNote,
  onRevealFolder,
  onRevealNote,
  onDeleteNote,
  onOpenTrash,
  showTime,
}: NotesListPanelProps) {
  const noteIndex = new Map(notes.map((note) => [note.id, note]));
  const [tooltip, setTooltip] = useState<{ label: string; x: number; y: number } | null>(null);
  const [folderModal, setFolderModal] = useState<FolderModalState>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{
    folderPath: string;
    x: number;
    y: number;
  } | null>(null);
  const [noteContextMenu, setNoteContextMenu] = useState<{
    note: NoteSummary;
    x: number;
    y: number;
  } | null>(null);
  const [dragTargetFolder, setDragTargetFolder] = useState<string | null>(null);
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const [folderDrag, setFolderDrag] = useState<{
    key: string;
    targetKey: string | null;
    position: "before" | "after";
  } | null>(null);
  const dragTargetFolderRef = useRef<string | null>(null);
  const pointerDragRef = useRef<{
    noteId: string;
    pointerId: number;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);
  const folderPointerRef = useRef<{
    key: string;
    pointerId: number;
    startY: number;
    started: boolean;
    targetKey: string | null;
    position: "before" | "after";
  } | null>(null);
  const [dragGhost, setDragGhost] = useState<{ title: string; x: number; y: number } | null>(null);
  const autoScrollRef = useRef<{ frame: number; x: number; y: number } | null>(null);
  const notesListRef = useRef<HTMLDivElement | null>(null);
  const railListRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const folderContextMenuRef = useRef<HTMLDivElement | null>(null);
  const noteContextMenuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (!folderContextMenuRef.current?.contains(target)) setFolderContextMenu(null);
      if (!noteContextMenuRef.current?.contains(target)) setNoteContextMenu(null);
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!active) return;
    function handleShortcut(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setFolderContextMenu(null);
        setNoteContextMenu(null);
        return;
      }
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
  }, [active, onCreateNote]);

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

  function suppressNextClick(key: string) {
    suppressClickRef.current = key;
    window.setTimeout(() => {
      if (suppressClickRef.current === key) suppressClickRef.current = null;
    }, 0);
  }

  function consumeSuppressedClick(key: string) {
    if (suppressClickRef.current !== key) return false;
    suppressClickRef.current = null;
    return true;
  }

  // While dragging, a pointer near the top or bottom edge of the note list or
  // the folder rail scrolls it, also when the pointer holds still.
  function trackAutoScroll(clientX: number, clientY: number) {
    const current = autoScrollRef.current;
    if (current) {
      current.x = clientX;
      current.y = clientY;
      return;
    }
    const state = { frame: 0, x: clientX, y: clientY };
    const step = () => {
      for (const element of [notesListRef.current, railListRef.current]) {
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        if (state.x < rect.left || state.x > rect.right) continue;
        const edge = 32;
        if (state.y < rect.top + edge && state.y > rect.top - edge) {
          element.scrollTop -= Math.ceil((rect.top + edge - state.y) / 5);
        } else if (state.y > rect.bottom - edge && state.y < rect.bottom + edge) {
          element.scrollTop += Math.ceil((state.y - rect.bottom + edge) / 5);
        }
      }
      state.frame = window.requestAnimationFrame(step);
    };
    state.frame = window.requestAnimationFrame(step);
    autoScrollRef.current = state;
  }

  function stopAutoScroll() {
    if (autoScrollRef.current) window.cancelAnimationFrame(autoScrollRef.current.frame);
    autoScrollRef.current = null;
  }

  useEffect(() => stopAutoScroll, []);

  // Note -> folder drag. Pointer events are used because the native window
  // owns HTML drag-and-drop for file drops.
  function resetNoteDrag() {
    stopAutoScroll();
    setDragGhost(null);
    pointerDragRef.current = null;
    dragTargetFolderRef.current = null;
    setDragTargetFolder(null);
    setDraggingNoteId(null);
  }

  function updateNoteDrag(clientX: number, clientY: number) {
    const drag = pointerDragRef.current;
    if (!drag) return;
    if (!drag.started && Math.hypot(clientX - drag.startX, clientY - drag.startY) >= 5) {
      drag.started = true;
      setDraggingNoteId(drag.noteId);
    }
    if (!drag.started) return;
    trackAutoScroll(clientX, clientY);
    const dragged = noteIndex.get(drag.noteId);
    setDragGhost({ title: dragged?.title || messages.untitledNoteLabel, x: clientX, y: clientY });

    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-folder-drop]")
      ?.dataset.folderDrop;
    const draggedNote = noteIndex.get(drag.noteId);
    const nextTarget = target && target !== draggedNote?.folderPath ? target : null;
    dragTargetFolderRef.current = nextTarget;
    setDragTargetFolder(nextTarget);
  }

  function finishNoteDrag(noteId: string) {
    const drag = pointerDragRef.current;
    if (!drag?.started) {
      resetNoteDrag();
      return;
    }
    suppressNextClick(noteId);
    const target = dragTargetFolderRef.current;
    resetNoteDrag();
    if (!target) return;
    if (target === TRASH_FOLDER) {
      onTrashNote(noteId);
    } else {
      onMoveNoteToFolder(noteId, target);
    }
  }

  // Folder reordering among siblings keeps a stable, user-defined path.
  function updateFolderDrag(clientX: number, clientY: number) {
    const drag = folderPointerRef.current;
    if (!drag) return;
    if (!drag.started && Math.abs(clientY - drag.startY) >= 4) {
      drag.started = true;
      setTooltip(null);
    }
    if (!drag.started) return;
    trackAutoScroll(clientX, clientY);

    const row = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-folder-key]");
    const targetKey = row?.dataset.folderKey;
    if (row && targetKey && targetKey !== drag.key) {
      const rect = row.getBoundingClientRect();
      drag.targetKey = targetKey;
      drag.position = clientY < rect.top + rect.height / 2 ? "before" : "after";
    } else {
      drag.targetKey = null;
    }
    setFolderDrag({ key: drag.key, targetKey: drag.targetKey, position: drag.position });
  }

  function finishFolderDrag() {
    stopAutoScroll();
    const drag = folderPointerRef.current;
    folderPointerRef.current = null;
    setFolderDrag(null);
    if (!drag?.started) return;
    suppressNextClick(`folder:${drag.key}`);
    if (drag.targetKey) {
      onReorderFolders(moveFolder(folders, drag.key, drag.targetKey, drag.position));
    }
  }

  function openFolderMenu(event: ReactMouseEvent, folderPath: string) {
    event.preventDefault();
    setNoteContextMenu(null);
    const manageable = folderPath !== INBOX_FOLDER;
    const nextPosition = positionContextMenu(event.clientX, event.clientY, 190, manageable ? 118 : 46);
    setFolderContextMenu({ folderPath, x: nextPosition.x, y: nextPosition.y });
  }

  function showTooltip(event: ReactMouseEvent<HTMLElement>, label: string) {
    if (folderPointerRef.current?.started || pointerDragRef.current?.started) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({ label, x: rect.right + 8, y: rect.top + rect.height / 2 });
  }

  function focusFolderTile(key: string) {
    window.requestAnimationFrame(() =>
      railListRef.current?.querySelector<HTMLElement>(`[data-folder-key="${CSS.escape(key)}"]`)?.focus(),
    );
  }

  /** Up/Down moves focus between tiles; Alt+Up/Down moves the tile itself. */
  function handleFolderKeyDown(event: ReactKeyboardEvent<HTMLElement>, key: string) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const index = folders.indexOf(key);
    const neighbor = folders[event.key === "ArrowUp" ? index - 1 : index + 1];
    if (!neighbor) return;
    if (event.altKey) {
      onReorderFolders(moveFolder(folders, key, neighbor, event.key === "ArrowUp" ? "before" : "after"));
      focusFolderTile(key);
    } else {
      focusFolderTile(neighbor);
    }
  }

  function handleNoteListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-note-id]")?.dataset
      .noteId;
    const index = notes.findIndex((note) => note.id === (focusedId ?? selectedNoteId));
    const next = notes[event.key === "ArrowUp" ? Math.max(index - 1, 0) : index + 1];
    event.preventDefault();
    if (!next || next.id === focusedId) return;
    onSelectNote(next);
    notesListRef.current?.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(next.id)}"]`)?.focus();
  }

  function renderFolderTile(key: string) {
    const indicator =
      folderDrag?.targetKey === key
        ? folderDrag.position === "before"
          ? "is-insert-before"
          : "is-insert-after"
        : "";
    const label = folderDisplayName(messages, key);
    const tileLabel = folderTileLabel(label);
    return (
      <button
        key={key}
        type="button"
        className={`folder-tile is-${tileLabel.size} ${key === currentFolder ? "is-current" : ""} ${dragTargetFolder === key ? "is-drop-target" : ""} ${
          folderDrag?.key === key ? "is-dragging" : ""
        } ${indicator}`}
        data-folder-key={key}
        data-folder-drop={key}
        aria-label={label}
        aria-current={key === currentFolder ? "true" : undefined}
        onMouseEnter={(event) => showTooltip(event, label)}
        onMouseLeave={() => setTooltip(null)}
        onClick={() => {
          if (consumeSuppressedClick(`folder:${key}`)) return;
          onSelectFolder(key);
        }}
        onContextMenu={(event) => {
          setTooltip(null);
          openFolderMenu(event, key);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          folderPointerRef.current = {
            key: key,
            pointerId: event.pointerId,
            startY: event.clientY,
            started: false,
            targetKey: null,
            position: "before",
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (folderPointerRef.current?.pointerId !== event.pointerId) return;
          updateFolderDrag(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          if (folderPointerRef.current?.pointerId !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          finishFolderDrag();
        }}
        onPointerCancel={() => {
          stopAutoScroll();
          folderPointerRef.current = null;
          setFolderDrag(null);
        }}
        onKeyDown={(event) => handleFolderKeyDown(event, key)}
      >
        {key !== currentFolder && matchedFolders.includes(key) ? (
          <span className="folder-tile-dot" aria-hidden="true" />
        ) : null}
        <span className="folder-tile-label">
          {tileLabel.lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      </button>
    );
  }

  const currentLabel = folderDisplayName(messages, currentFolder);

  return (
    <div className="notes-sidebar">
      <nav className="folder-rail" aria-label={messages.foldersLabel}>
        <div ref={railListRef} className="folder-rail-list" title={messages.reorderFolderHint}>
          {folders.map(renderFolderTile)}
        </div>

        <button
          type="button"
          className="folder-tile is-tool"
          aria-label={messages.createFolderButton}
          onMouseEnter={(event) => showTooltip(event, messages.createFolderButton)}
          onMouseLeave={() => setTooltip(null)}
          onClick={() => setFolderModal({ mode: "create", value: "" })}
        >
          <FolderPlus size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={`folder-tile is-tool ${dragTargetFolder === TRASH_FOLDER ? "is-drop-target" : ""}`}
          data-folder-drop={TRASH_FOLDER}
          aria-label={messages.trashLabel}
          onMouseEnter={(event) => showTooltip(event, messages.trashLabel)}
          onMouseLeave={() => setTooltip(null)}
          onClick={onOpenTrash}
        >
          <Trash2 size={16} strokeWidth={1.8} />
        </button>
      </nav>

      <div className="note-column">
        <header className="note-column-header">
          <div
            className="note-column-title"
            onContextMenu={(event) => openFolderMenu(event, currentFolder)}
            title={currentLabel}
          >
            <span className="is-leaf">{currentLabel}</span>
          </div>
          {saveStatus && saveState === "failed" ? (
            <button type="button" className="note-column-status is-failed" onClick={onRetrySave}>
              {saveStatus}
            </button>
          ) : saveStatus ? (
            <span className={`note-column-status is-${saveState}`}>{saveStatus}</span>
          ) : null}
        </header>

        <button
          type="button"
          className="sidebar-action-button is-primary"
          onClick={onCreateNote}
          title={`${messages.createButton} (Ctrl N)`}
        >
          <PenLine size={17} strokeWidth={1.8} />
          <span>{messages.createButton}</span>
        </button>

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

        <div ref={notesListRef} className="notes-list" onKeyDown={handleNoteListKeyDown}>
          {booting ? <p className="empty-state">{messages.bootingLabel}</p> : null}

          {notes.map((note) => (
            <button
              key={note.id}
              type="button"
              data-note-id={note.id}
              className={`note-row ${selectedNoteId === note.id ? "is-selected" : ""} ${
                draggingNoteId === note.id ? "is-dragging" : ""
              }`}
              onClick={() => {
                if (consumeSuppressedClick(note.id)) return;
                onSelectNote(note);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setFolderContextMenu(null);
                onSelectNote(note);
                const nextPosition = positionContextMenu(event.clientX, event.clientY, 180, 118);
                setNoteContextMenu({ note, x: nextPosition.x, y: nextPosition.y });
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
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
                updateNoteDrag(event.clientX, event.clientY);
                if (pointerDragRef.current?.started) event.preventDefault();
              }}
              onPointerUp={(event) => {
                if (pointerDragRef.current?.pointerId !== event.pointerId) return;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                finishNoteDrag(note.id);
              }}
              onPointerCancel={(event) => {
                if (pointerDragRef.current?.pointerId === event.pointerId) resetNoteDrag();
              }}
            >
              <div className="note-row-header">
                <strong className={note.title ? "" : "is-untitled"}>{note.title || messages.untitledNoteLabel}</strong>
                {showTime ? <span>{formatTimestamp(note.updatedAt)}</span> : null}
              </div>
            </button>
          ))}

          {!booting && !notes.length ? (
            <p className="empty-state">
              {searchText.trim() ? messages.emptySearchLabel : messages.emptyFolderLabel}
            </p>
          ) : null}
        </div>

      </div>

      {dragGhost ? (
        <div className="note-drag-ghost" style={{ left: `${dragGhost.x + 14}px`, top: `${dragGhost.y + 10}px` }}>
          {dragGhost.title}
        </div>
      ) : null}

      {tooltip ? (
        <div className="folder-tooltip" style={{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }}>
          {tooltip.label}
        </div>
      ) : null}

      {folderModal ? (
        <div className="inline-modal-backdrop" onClick={() => setFolderModal(null)}>
          <div className="inline-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inline-modal-header">
              <h3>{folderModal.mode === "create" ? messages.createFolderTitle : messages.renameFolderTitle}</h3>
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
                  if (event.key === "Enter") submitFolderModal();
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setFolderModal(null);
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

      {folderContextMenu ? (
        <div
          ref={folderContextMenuRef}
          className="note-context-menu"
          style={{ left: `${folderContextMenu.x}px`, top: `${folderContextMenu.y}px` }}
        >
          <button
            type="button"
            className="note-context-menu-item"
            onClick={() => {
              onRevealFolder(folderContextMenu.folderPath);
              setFolderContextMenu(null);
            }}
          >
            <FolderOpen size={15} strokeWidth={1.8} />
            {messages.openFolderButton}
          </button>
          {folderContextMenu.folderPath !== INBOX_FOLDER ? (
            <>
              <button
                type="button"
                className="note-context-menu-item"
                onClick={() => {
                  setFolderModal({
                    mode: "rename",
                    folderPath: folderContextMenu.folderPath,
                    value: folderContextMenu.folderPath,
                  });
                  setFolderContextMenu(null);
                }}
              >
                <Pencil size={15} strokeWidth={1.8} />
                {messages.renameFolderButton}
              </button>
              <button
                type="button"
                className="note-context-menu-item is-danger"
                onClick={() => {
                  onDeleteFolder(folderContextMenu.folderPath);
                  setFolderContextMenu(null);
                }}
              >
                <Trash2 size={15} strokeWidth={1.8} />
                {messages.deleteFolderButton}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {noteContextMenu ? (
        <div
          ref={noteContextMenuRef}
          className="note-context-menu"
          style={{ left: `${noteContextMenu.x}px`, top: `${noteContextMenu.y}px` }}
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
    </div>
  );
}

type EditorWorkspaceProps = {
  messages: LocaleMessages;
  language: string;
  activeNote: NoteDetail | null;
  autoFocusTitleNoteId: string;
  onTitleChange: (value: string) => void;
  onContentChange: (value: string) => void;
  onRestore: () => void;
  onDeletePermanently: () => void;
  errorMessage?: string;
};

export function EditorWorkspace({
  messages,
  language,
  activeNote,
  autoFocusTitleNoteId,
  onTitleChange,
  onContentChange,
  onRestore,
  onDeletePermanently,
  errorMessage,
}: EditorWorkspaceProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const editorNoteIdRef = useRef<string | undefined>(undefined);
  const editorContentRef = useRef("");
  const isComposingRef = useRef(false);
  const selectionRangeRef = useRef<Range | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [wordCount, setWordCount] = useState(0);
  const activeContent = noteRichText(activeNote);

  useEffect(() => {
    const noteChanged = editorNoteIdRef.current !== activeNote?.id;
    if (!noteChanged && (isComposingRef.current || editorContentRef.current === activeContent)) {
      return;
    }
    if (noteChanged) {
      selectionRangeRef.current = null;
      isComposingRef.current = false;
    }
    editorNoteIdRef.current = activeNote?.id;
    editorContentRef.current = activeContent;
    const nextContent = toEditorHtml(activeContent);
    if (editorRef.current && editorRef.current.innerHTML !== nextContent) {
      editorRef.current.innerHTML = nextContent;
    }
    setWordCount((editorRef.current?.innerText ?? "").replace(/\s/g, "").length);
  }, [activeNote?.id, activeContent]);

  useEffect(() => {
    // Enter starts a new <p>, matching the HTML the notes are stored in.
    document.execCommand("defaultParagraphSeparator", false, "p");
  }, []);

  useEffect(() => {
    if (!activeNote || activeNote.id !== autoFocusTitleNoteId) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [activeNote?.id, autoFocusTitleNoteId]);

  useEffect(() => {
    setCopyState("idle");
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, [activeNote?.id]);

  function emitEditorContent() {
    const editor = editorRef.current;
    if (!editor || isComposingRef.current) return;
    setWordCount(editor.innerText.replace(/\s/g, "").length);
    const content = editor.innerHTML;
    // Local edits already live in the DOM. Their state echo must not replace
    // text nodes, which would reset the selection and interrupt the IME.
    if (editorContentRef.current === content) return;
    editorContentRef.current = content;
    onContentChange(content);
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

  function handleEditorInput(event: FormEvent<HTMLDivElement>) {
    if (isComposingRef.current || (event.nativeEvent as InputEvent).isComposing) return;
    rememberSelection();
    emitEditorContent();
  }

  // execCommand keeps paste and bold on the browser undo stack (Ctrl+Z).
  function handleEditorPaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (!text) return;
    const url = text.trim();
    if (/^https?:\/\/\S+$/i.test(url)) {
      const safe = escapeHtml(url);
      document.execCommand("insertHTML", false, `<a href="${safe}">${safe}</a>`);
    } else {
      document.execCommand("insertText", false, text);
    }
  }

  function applyBold() {
    if (!restoreEditorRange()) return;
    document.execCommand("bold");
    rememberSelection();
  }

  // Links: Ctrl/Cmd+click opens them; a read-only (trashed) note opens on click.
  function handleEditorClick(event: ReactMouseEvent<HTMLDivElement>) {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) return;
    if (event.ctrlKey || event.metaKey || activeNote?.isTrashed) void openUrl(href);
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

  const folderLabel = activeNote ? folderDisplayName(messages, topFolder(activeNote.folderPath)) : "";

  return (
    <section className="editor-shell">
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      {activeNote ? (
        <>
          <div className="editor-scroll">
            <div className="editor-panel">
              <input
                ref={titleInputRef}
                className="title-input"
                value={activeNote.title}
                disabled={activeNote.isTrashed}
                onChange={(event) => onTitleChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  editorRef.current?.focus();
                }}
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
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                  rememberSelection();
                  emitEditorContent();
                }}
                onPaste={handleEditorPaste}
                onClick={handleEditorClick}
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
                title={`${messages.boldButton} (Ctrl B)`}
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

            {activeNote.isTrashed ? (
              <div className="editor-file-actions">
                <button type="button" className="soft-button" onClick={onRestore}>
                  {messages.restoreButton}
                </button>
                <button type="button" className="danger-button" onClick={onDeletePermanently}>
                  {messages.deletePermanentlyButton}
                </button>
              </div>
            ) : null}
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
