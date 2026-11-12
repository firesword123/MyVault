import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
  KeyboardEvent,
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorWorkspace, NotesListPanel, orderFolders, topFolder, type SaveState } from "./components/NotesWorkspace";
import { PlayerWorkspace } from "./components/PlayerWorkspace";
import { SettingsPanel } from "./components/SettingsPanel";
import { ShellFrame } from "./components/ShellFrame";
import { resolveMessages } from "./i18n";
import type { AppSettings, BootstrapPayload, NoteDetail, NoteSummary, ResourceUsage, WorkspacePayload } from "./types";
import { appUiSpec } from "./ui-spec";
import { formatClockTime, noteRichText, noteSignature, previewText, searchTextFromHtml } from "./utils";
import { useEmbeddedModules } from "./useEmbeddedModules";
import "./styles/global.css";
import "./styles/notes.css";
import "./styles/player.css";

function normalizeFolderInput(folderPath: string) {
  return folderPath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

const FOLDER_RAIL_WIDTH = 62;

function firstNoteInFolder(notes: NoteSummary[], folderPath: string) {
  return notes.find((note) => !note.isTrashed && topFolder(note.folderPath) === folderPath);
}

function isBlankNoteBody(html: string) {
  return !html.replace(/<[^>]*>/g, "").replace(/&nbsp;| /g, "").trim();
}

type ConfirmRequest = {
  title: string;
  body: string;
  danger: boolean;
  resolve: (confirmed: boolean) => void;
};

function App() {
  const embedded = useEmbeddedModules();
  const selectEmbeddedRef = useRef(embedded.select);
  selectEmbeddedRef.current = embedded.select;
  const [settings, setSettings] = useState<AppSettings>({
    language: "zh-CN",
    showNoteTime: false,
    closeBehavior: "quit",
    httpProxy: "",
    httpsProxy: "",
    allProxy: "",
    noProxy: "",
    notesState: {
      selectedNoteId: "",
      currentFolder: "",
      folderOrder: [],
    },
    persistentModules: [],
    closePlayerOnPause: false,
    showMemoryInTitlebar: false,
  });
  const [vaultPath, setVaultPath] = useState("");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [activeNote, setActiveNote] = useState<NoteDetail | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState("");
  const [searchText, setSearchText] = useState("");
  const [notesBooting, setNotesBooting] = useState(true);
  const [noteErrorMessage, setNoteErrorMessage] = useState("");
  const [currentFolder, setCurrentFolder] = useState("inbox");
  const [folderOrder, setFolderOrder] = useState<string[]>([]);
  const [autoFocusTitleNoteId, setAutoFocusTitleNoteId] = useState("");
  const [saveInFlight, setSaveInFlight] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "trash">("general");
  const [playerOpen, setPlayerOpen] = useState(false);
  const [playerHasQueue, setPlayerHasQueue] = useState(false);
  const [resourceUsage, setResourceUsage] = useState<ResourceUsage | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(258 - FOLDER_RAIL_WIDTH);
  const [sidebarResizeActive, setSidebarResizeActive] = useState(false);
  const [appVersion, setAppVersion] = useState("Resolving...");
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);

  const activeNoteRef = useRef<NoteDetail | null>(null);
  const isResizingSidebar = useRef(false);
  const lastSavedSignature = useRef("");
  const autosaveTimer = useRef<number | null>(null);
  // A note created in this session that is discarded if left untouched.
  const freshNoteIdRef = useRef<string | null>(null);
  // Saves run one at a time so an older write never lands after a newer one.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  const deferredSearch = useDeferredValue(searchText);
  const messages = resolveMessages(settings.language);
  const orderedFolders = useMemo(() => orderFolders(folders, folderOrder), [folders, folderOrder]);
  const effectiveFolder = orderedFolders.includes(currentFolder) ? currentFolder : "inbox";

  function isFolderPathWithin(folderPath: string, rootFolder: string) {
    return folderPath === rootFolder || folderPath.startsWith(`${rootFolder}/`);
  }

  function replaceFolderPrefix(folderPath: string, fromPath: string, toPath: string) {
    return isFolderPathWithin(folderPath, fromPath)
      ? `${toPath}${folderPath.slice(fromPath.length)}`
      : folderPath;
  }

  function replaceRelativeFolderPrefix(relativePath: string, fromPath: string, toPath: string) {
    const fromPrefix = `notes/${fromPath}/`;
    const toPrefix = `notes/${toPath}/`;
    return relativePath.startsWith(fromPrefix)
      ? `${toPrefix}${relativePath.slice(fromPrefix.length)}`
      : relativePath;
  }

  function mapNoteErrorMessage(message: string) {
    switch (message) {
      case "only empty folders can be deleted":
      case "folder is not empty":
        return messages.errorFolderDeleteNotEmpty;
      case "folder not found":
        return messages.errorFolderNotFound;
      case "target folder already exists":
        return messages.errorFolderExists;
      case "invalid folder path":
        return messages.errorFolderInvalid;
      case "system folders cannot be renamed":
      case "system folders cannot be deleted":
        return messages.errorFolderSystemProtected;
      case "target folder not found":
      case "target folder is not allowed":
        return messages.errorMoveTargetMissing;
      default:
        return message;
    }
  }

  function isProtectedFolderPath(folderPath: string) {
    return folderPath === "drafts" || folderPath === "trash";
  }

  async function flushPendingDraft(note: NoteDetail | null) {
    if (!note) return;
    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    if (noteSignature(note) !== lastSavedSignature.current) {
      await persistNote(note, "draft");
    }
    await saveChainRef.current;
  }

  // Window close and hide-to-tray: write pending edits first.
  const flushBeforeExitRef = useRef<(closing: boolean) => Promise<void>>(async () => {});
  flushBeforeExitRef.current = async (closing) => {
    const note = activeNoteRef.current;
    if (closing) await leaveNote(note);
    else await flushPendingDraft(note);
  };

  useEffect(() => {
    const cleanups = [
      listen("app:before-close", () => {
        void flushBeforeExitRef.current(true)
          .catch(() => undefined)
          .finally(() => void invoke("confirm_close"));
      }),
      listen("app:flush", () => {
        void flushBeforeExitRef.current(false).catch(() => undefined);
      }),
    ];
    return () => {
      cleanups.forEach((cleanup) => void cleanup.then((unlisten) => unlisten()));
    };
  }, []);

  // Search covers every folder: the list shows hits in the current folder and
  // the rail marks other folders that also have hits.
  const { filteredNotes, matchedFolders } = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    const live = notes.filter((note) => !note.isTrashed);
    const hits = query
      ? live.filter((note) => [note.title, note.searchText].some((value) => value.toLowerCase().includes(query)))
      : live;
    return {
      filteredNotes: hits.filter((note) => topFolder(note.folderPath) === effectiveFolder),
      matchedFolders: query ? Array.from(new Set(hits.map((note) => topFolder(note.folderPath)))) : [],
    };
  }, [deferredSearch, notes, effectiveFolder]);
  const activeNoteUnsaved = Boolean(activeNote && noteSignature(activeNote) !== lastSavedSignature.current);
  const saveState: SaveState = saveFailed
    ? "failed"
    : saveInFlight > 0
      ? "saving"
      : activeNoteUnsaved
        ? "unsaved"
        : "saved";
  const saveStatus = !activeNote
    ? ""
    : saveState === "failed"
      ? messages.saveFailedStatus
      : saveState === "saving"
        ? messages.saving
        : saveState === "unsaved"
          ? messages.unsavedStatus
          : `${messages.savedStatus} · ${formatClockTime(activeNote.updatedAt, settings.language)}`;

  function askConfirm(title: string, body: string, danger = false) {
    return new Promise<boolean>((resolve) => setConfirmRequest({ title, body, danger, resolve }));
  }

  function answerConfirm(confirmed: boolean) {
    confirmRequest?.resolve(confirmed);
    setConfirmRequest(null);
  }

  function persistNotesState(patch: {
    selectedNoteId?: string;
    currentFolder?: string;
    folderOrder?: string[];
  }) {
    void invoke<AppSettings>("update_notes_state", { input: patch }).then(setSettings, (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    });
  }

  function changeCurrentFolder(folderPath: string) {
    setCurrentFolder(folderPath);
    persistNotesState({ currentFolder: folderPath });
  }

  function isUntouchedFreshNote(note: NoteDetail) {
    if (freshNoteIdRef.current !== note.id) return false;
    const title = note.title.trim();
    return (!title || title === messages.newNoteFallbackLabel) && isBlankNoteBody(noteRichText(note));
  }

  /** Saves pending edits, or discards a new note that was never written in. */
  async function leaveNote(note: NoteDetail | null) {
    if (!note) return;
    if (isUntouchedFreshNote(note)) {
      freshNoteIdRef.current = null;
      if (autosaveTimer.current) {
        window.clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
      try {
        await invoke<NoteSummary[]>("discard_empty_note", { id: note.id });
        await refreshWorkspace();
      } catch {
        // The backend refuses non-empty notes; keeping the note is the safe fallback.
      }
      return;
    }
    if (freshNoteIdRef.current === note.id) freshNoteIdRef.current = null;
    await flushPendingDraft(note);
  }

  async function selectFolder(folderPath: string) {
    setSearchText("");
    if (folderPath === effectiveFolder) return;
    changeCurrentFolder(folderPath);
    const first = firstNoteInFolder(notes, folderPath);
    if (first) {
      await openNote(first.id);
    } else {
      await leaveNote(activeNoteRef.current);
      setActiveNote(null);
      setSelectedNoteId("");
    }
  }

  function selectNoteFromList(note: NoteSummary) {
    // Opening a search hit from another folder moves the list context with it.
    if (topFolder(note.folderPath) !== effectiveFolder) {
      changeCurrentFolder(topFolder(note.folderPath));
      setSearchText("");
    }
    void openNote(note.id);
  }

  function reorderFolders(order: string[]) {
    setFolderOrder(order);
    persistNotesState({ folderOrder: order });
  }

  useEffect(() => {
    activeNoteRef.current = activeNote;
  }, [activeNote]);

  useEffect(() => {
    setUpdateStatus((current) => current || messages.updateIdleLabel);
  }, [messages]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("player:replace-queue", () => {
      if (!disposed) {
        void selectEmbeddedRef.current(null).then((switched) => {
          if (!disposed && switched) setPlayerOpen(true);
        });
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function openNote(noteId: string) {
    setNoteErrorMessage("");
    try {
      const currentNote = activeNoteRef.current;
      if (currentNote && currentNote.id !== noteId) {
        await leaveNote(currentNote);
      }
      const detail = await invoke<NoteDetail>("load_note", { id: noteId });
      startTransition(() => {
        setActiveNote(detail);
        setSelectedNoteId(detail.id);
        lastSavedSignature.current = noteSignature(detail);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(message);
    }
  }

  async function refreshWorkspace() {
    const payload = await invoke<WorkspacePayload>("list_workspace");
    setNotes(payload.notes);
    setFolders(payload.folders);
    return payload;
  }

  async function bootstrap() {
    try {
      const version = await getVersion();
      setAppVersion(`v${version}`);

      const notesPayload = await invoke<BootstrapPayload>("bootstrap_app");
      setSettings(notesPayload.settings);
      setVaultPath(notesPayload.vaultPath);
      setNotes(notesPayload.notes);
      setFolders(notesPayload.folders);
      const notesState = notesPayload.settings.notesState;
      setFolderOrder(notesState.folderOrder ?? []);

      const liveNotes = notesPayload.notes.filter((note) => !note.isTrashed);
      const preferredNote = liveNotes.find((note) => note.id === notesState.selectedNoteId);
      const savedFolder =
        notesState.currentFolder && notesState.currentFolder !== "trash" && notesPayload.folders.includes(notesState.currentFolder)
          ? notesState.currentFolder
          : "";
      const startFolder = savedFolder || (preferredNote ? topFolder(preferredNote.folderPath) : "inbox");
      setCurrentFolder(startFolder);
      const firstNote =
        (preferredNote && topFolder(preferredNote.folderPath) === startFolder ? preferredNote : undefined) ??
        firstNoteInFolder(liveNotes, startFolder);
      if (firstNote) {
        await openNote(firstNote.id);
      } else {
        setActiveNote(null);
        setSelectedNoteId("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(message);
    } finally {
      setNotesBooting(false);
    }
  }

  async function createNote() {
    const current = activeNoteRef.current;
    if (current && isUntouchedFreshNote(current) && current.folderPath === effectiveFolder) {
      // Reuse the untouched new note instead of stacking empty files.
      setAutoFocusTitleNoteId("");
      window.setTimeout(() => setAutoFocusTitleNoteId(current.id), 0);
      return;
    }
    try {
      setSearchText("");
      const detail = await invoke<NoteDetail>("create_note", {
        input: { title: "", folderPath: effectiveFolder },
      });
      await refreshWorkspace();
      await openNote(detail.id);
      freshNoteIdRef.current = detail.id;
      setAutoFocusTitleNoteId(detail.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(message);
    }
  }

  async function createFolder(folderPath: string) {
    const normalizedPath = normalizeFolderInput(folderPath);
    if (!normalizedPath) return;
    try {
      if (isProtectedFolderPath(normalizedPath)) {
        setNoteErrorMessage(messages.errorFolderSystemProtected);
        return;
      }
      if (folders.includes(normalizedPath)) {
        setNoteErrorMessage(messages.errorFolderExists);
        return;
      }
      const nextFolders = await invoke<string[]>("create_folder", {
        input: { path: normalizedPath },
      });
      setFolders(nextFolders);
      await selectFolder(normalizedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function renameFolder(fromPath: string, toPath: string) {
    const nextPath = normalizeFolderInput(toPath);
    if (!nextPath || nextPath === fromPath) return;
    try {
      if (isProtectedFolderPath(nextPath)) {
        setNoteErrorMessage(messages.errorFolderSystemProtected);
        return;
      }
      if (folders.includes(nextPath)) {
        setNoteErrorMessage(messages.errorFolderExists);
        return;
      }
      const nextFolders = await invoke<string[]>("rename_folder", {
        input: { fromPath, toPath: nextPath },
      });
      setFolders(nextFolders);
      const nextOrder = folderOrder.map((folderPath) => replaceFolderPrefix(folderPath, fromPath, nextPath));
      setFolderOrder(nextOrder);
      persistNotesState({ folderOrder: nextOrder });
      if (isFolderPathWithin(effectiveFolder, fromPath)) {
        changeCurrentFolder(replaceFolderPrefix(effectiveFolder, fromPath, nextPath));
      }
      setNotes((current) =>
        current.map((note) =>
          isFolderPathWithin(note.folderPath, fromPath)
            ? {
                ...note,
                folderPath: replaceFolderPrefix(note.folderPath, fromPath, nextPath),
                relativePath: replaceRelativeFolderPrefix(note.relativePath, fromPath, nextPath),
              }
            : note,
        ),
      );
      setActiveNote((current) =>
        current && isFolderPathWithin(current.folderPath, fromPath)
          ? {
              ...current,
              folderPath: replaceFolderPrefix(current.folderPath, fromPath, nextPath),
              relativePath: replaceRelativeFolderPrefix(current.relativePath, fromPath, nextPath),
            }
          : current,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function deleteFolder(path: string) {
    try {
      if (!(await askConfirm(messages.deleteFolderConfirmTitle, messages.deleteFolderConfirmBody, true))) {
        return;
      }
      const nextFolders = await invoke<string[]>("delete_folder", { input: { path } });
      setFolders(nextFolders);
      const nextOrder = folderOrder.filter((folderPath) => !isFolderPathWithin(folderPath, path));
      setFolderOrder(nextOrder);
      persistNotesState({ folderOrder: nextOrder });
      if (isFolderPathWithin(effectiveFolder, path)) await selectFolder("inbox");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  function applySavedNote(note: NoteDetail, saved: NoteDetail) {
    if (activeNoteRef.current?.id === saved.id) {
      lastSavedSignature.current = noteSignature(saved);
    }
    setActiveNote((current) => {
      if (current?.id !== saved.id) return current;
      // Saving is asynchronous; keep any edits made since this request began.
      return noteSignature(current) === noteSignature(note)
        ? saved
        : { ...saved, title: current.title, blocks: current.blocks };
    });
  }

  function persistNote(note: NoteDetail, mode: "draft" | "commit") {
    setSaveInFlight((count) => count + 1);
    const run = saveChainRef.current.then(() => writeNote(note, mode));
    saveChainRef.current = run.finally(() => setSaveInFlight((count) => count - 1));
    return saveChainRef.current;
  }

  async function writeNote(note: NoteDetail, mode: "draft" | "commit") {
    try {
      const saved = await invoke<NoteDetail>("save_note", {
        input: { id: note.id, title: note.title, blocks: note.blocks, mode },
      });
      applySavedNote(note, saved);
      setNotes((currentNotes) =>
        currentNotes
          .map((item) =>
            item.id === saved.id
              ? {
                  ...item,
                  title: saved.title,
                  relativePath: saved.relativePath,
                  folderPath: saved.folderPath,
                  isDraft: saved.isDraft,
                  isTrashed: saved.isTrashed,
                  preview: previewText(noteRichText(saved)),
                  searchText: searchTextFromHtml(noteRichText(saved)),
                  updatedAt: saved.updatedAt,
                  originalFolderPath: saved.originalFolderPath,
                  deletedAt: saved.deletedAt,
                }
              : item,
          )
          .sort((left, right) => right.updatedAt - left.updatedAt),
      );
      setFolders((currentFolders) =>
        currentFolders.includes(saved.folderPath) ? currentFolders : [...currentFolders, saved.folderPath],
      );
      setSaveFailed(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
      setSaveFailed(true);
    }
  }

  function retrySave() {
    const note = activeNoteRef.current;
    if (!note || note.isTrashed) return;
    setNoteErrorMessage("");
    void persistNote(note, "commit");
  }

  async function trashActiveNote() {
    if (!activeNote) return;
    try {
      const siblings = notes.filter(
        (note) => !note.isTrashed && topFolder(note.folderPath) === topFolder(activeNote.folderPath),
      );
      const currentIndex = siblings.findIndex((note) => note.id === activeNote.id);
      const nextSiblingId =
        currentIndex >= 0
          ? siblings[currentIndex + 1]?.id ?? siblings[currentIndex - 1]?.id
          : undefined;
      await invoke<NoteSummary[]>("trash_note", { id: activeNote.id });
      const workspace = await refreshWorkspace();
      const next =
        workspace.notes.find((note) => note.id === nextSiblingId && !note.isTrashed) ??
        firstNoteInFolder(workspace.notes, effectiveFolder);
      if (next) {
        await openNote(next.id);
      } else {
        setActiveNote(null);
        setSelectedNoteId("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function restoreActiveNote() {
    if (!activeNote) return;
    try {
      if (!(await askConfirm(messages.restoreNoteConfirmTitle, messages.restoreNoteConfirmBody))) {
        return;
      }
      const restored = await invoke<NoteDetail>("restore_note", { id: activeNote.id });
      await refreshWorkspace();
      changeCurrentFolder(topFolder(restored.folderPath));
      await openNote(restored.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function deleteActiveNotePermanently() {
    if (!activeNote) return;
    try {
      if (
        !(await askConfirm(messages.deleteNotePermanentConfirmTitle, messages.deleteNotePermanentConfirmBody, true))
      ) {
        return;
      }
      await invoke<NoteSummary[]>("delete_note", { id: activeNote.id });
      const workspace = await refreshWorkspace();
      const next = firstNoteInFolder(workspace.notes, effectiveFolder);
      if (next) {
        await openNote(next.id);
      } else {
        setActiveNote(null);
        setSelectedNoteId("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function restoreTrashedNote(noteId: string) {
    try {
      const restored = await invoke<NoteDetail>("restore_note", { id: noteId });
      await refreshWorkspace();
      if (activeNoteRef.current?.id === noteId) {
        await openNote(restored.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function deleteTrashedNote(noteId: string) {
    try {
      await invoke<NoteSummary[]>("delete_note", { id: noteId });
      const workspace = await refreshWorkspace();
      if (activeNoteRef.current?.id === noteId) {
        const next = firstNoteInFolder(workspace.notes, effectiveFolder);
        if (next) await openNote(next.id);
        else {
          setActiveNote(null);
          setSelectedNoteId("");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function moveActiveNote(folderPath: string) {
    if (!activeNote || !folderPath) return;
    try {
      await flushPendingDraft(activeNote);
      const moved = await invoke<NoteDetail>("move_note", {
        input: { id: activeNote.id, folderPath },
      });
      await refreshWorkspace();
      await openNote(moved.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function emptyTrash() {
    try {
      if (!(await askConfirm(messages.emptyTrashConfirmTitle, messages.emptyTrashConfirmBody, true))) {
        return;
      }
      await invoke<NoteSummary[]>("empty_trash");
      const workspace = await refreshWorkspace();
      const next = firstNoteInFolder(workspace.notes, effectiveFolder);
      if (next) {
        await openNote(next.id);
      } else {
        setActiveNote(null);
        setSelectedNoteId("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function updateSettings(nextSettings: AppSettings) {
    const savedSettings = await invoke<AppSettings>("update_settings", { settings: nextSettings });
    setSettings(savedSettings);
  }

  function runPlayerQuickAction() {
    const action = settings.closePlayerOnPause ? "close" : "pause";
    window.dispatchEvent(new CustomEvent("player:quick-action", { detail: action }));
    if (action === "close") setPlayerOpen(false);
  }

  async function handleUpdateAction() {
    if (updateBusy) return;

    if (availableUpdate) {
      setUpdateBusy(true);
      setUpdateStatus(messages.updateInstallingLabel.replace("{version}", `v${availableUpdate.version}`));
      try {
        await availableUpdate.downloadAndInstall((event) => {
          if (event.event === "Started") {
            setUpdateStatus(messages.updateDownloadingLabel);
          } else if (event.event === "Progress") {
            setUpdateStatus(messages.updateDownloadingLabel);
          } else if (event.event === "Finished") {
            setUpdateStatus(messages.updateRestartingLabel);
          }
        });
        await relaunch();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setUpdateStatus(`${messages.updateFailedLabel}: ${message}`);
      } finally {
        setUpdateBusy(false);
      }
      return;
    }

    setUpdateBusy(true);
    setUpdateStatus(messages.updateCheckingLabel);
    try {
      const update = await check();
      if (update) {
        setAvailableUpdate(update);
        setUpdateStatus(messages.updateAvailableLabel.replace("{version}", `v${update.version}`));
      } else {
        setAvailableUpdate(null);
        setUpdateStatus(messages.updateUpToDateLabel);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateStatus(`${messages.updateFailedLabel}: ${message}`);
    } finally {
      setUpdateBusy(false);
    }
  }

  function updateActiveNote(patch: Partial<Pick<NoteDetail, "title">>) {
    setActiveNote((current) => (current ? { ...current, ...patch } : current));
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!activeNote || activeNote.isTrashed) return;
      void persistNote(activeNote, "commit");
    }
  }

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!activeNote) return;
    const nextSignature = noteSignature(activeNote);
    if (nextSignature === lastSavedSignature.current) return;
    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
    }
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null;
      void persistNote(activeNote, "draft");
    }, 900);
    return () => {
      if (autosaveTimer.current) {
        window.clearTimeout(autosaveTimer.current);
      }
    };
  }, [activeNote]);

  useEffect(() => {
    if (notesBooting) return;
    if (settings.notesState.selectedNoteId === selectedNoteId) return;
    persistNotesState({ selectedNoteId });
  }, [notesBooting, selectedNoteId]);

  useEffect(() => {
    if (!settingsOpen && !settings.showMemoryInTitlebar) return;
    let alive = true;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const usage = await invoke<ResourceUsage>("get_resource_usage");
        if (alive) setResourceUsage(usage);
      } catch {
        if (alive) setResourceUsage(null);
      } finally {
        if (alive) timer = window.setTimeout(() => void refresh(), 3000);
      }
    };
    void refresh();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [settingsOpen, settings.showMemoryInTitlebar]);

  useEffect(() => {
    const theme = appUiSpec.theme;
    const layout = appUiSpec.layout;
    const root = document.documentElement;
    root.style.setProperty("--font-body", theme.bodyFont);
    root.style.setProperty("--font-display", theme.displayFont);
    root.style.setProperty("--bg-shell", theme.shellBackground);
    root.style.setProperty("--bg-panel", theme.panelBackground);
    root.style.setProperty("--border-panel", theme.panelBorder);
    root.style.setProperty("--accent-gradient", theme.accentGradient);
    root.style.setProperty("--accent-soft", theme.accentSoft);
    root.style.setProperty("--accent-strong", theme.accentStrong);
    root.style.setProperty("--text-primary", theme.textPrimary);
    root.style.setProperty("--text-muted", theme.textMuted);
    root.style.setProperty("--danger-soft", theme.dangerSoft);
    root.style.setProperty("--danger-text", theme.dangerText);
    root.style.setProperty("--shadow-panel", theme.shadow);
    root.style.setProperty("--titlebar-height", layout.titlebarHeight);
    root.style.setProperty("--rail-width", layout.railWidth);
    root.style.setProperty("--shell-gap", layout.shellGap);
    root.style.setProperty("--shell-padding", layout.shellPadding);
    root.style.setProperty("--panel-radius", layout.panelRadius);
    root.style.setProperty("--control-radius", layout.controlRadius);
  }, []);

  useEffect(() => {
    function handleMouseMove(event: MouseEvent) {
      if (!isResizingSidebar.current) return;
      const nextWidth = Math.min(Math.max(event.clientX - FOLDER_RAIL_WIDTH, 170), 400);
      setSidebarWidth(nextWidth);
    }

    function handleMouseUp() {
      isResizingSidebar.current = false;
      setSidebarResizeActive(false);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const notesBodyContent = (
    <div
      className={`module-body notes-module-body workspace-view ${playerOpen || embedded.active ? "is-hidden" : "is-active"}`}
      style={{
        ["--sidebar-width" as string]: `${sidebarWidth + FOLDER_RAIL_WIDTH}px`,
        ["--folder-rail-width" as string]: `${FOLDER_RAIL_WIDTH}px`,
      }}
      onKeyDown={handleEditorKeyDown}
    >
      <aside className="sidebar">
        <NotesListPanel
          messages={messages}
          active={!playerOpen && !embedded.active && !settingsOpen}
          booting={notesBooting}
          folders={orderedFolders}
          currentFolder={effectiveFolder}
          onSelectFolder={(folderPath) => void selectFolder(folderPath)}
          onReorderFolders={reorderFolders}
          notes={filteredNotes}
          searchText={searchText}
          onSearchTextChange={setSearchText}
          matchedFolders={matchedFolders}
          saveStatus={saveStatus}
          saveState={saveState}
          onRetrySave={retrySave}
          selectedNoteId={selectedNoteId}
          onSelectNote={selectNoteFromList}
          onCreateNote={() => void createNote()}
          onCreateFolder={(name) => void createFolder(name)}
          onRenameFolder={(fromPath, toPath) => void renameFolder(fromPath, toPath)}
          onDeleteFolder={(path) => void deleteFolder(path)}
          onMoveNoteToFolder={(noteId, folderPath) =>
            noteId === activeNote?.id
              ? void moveActiveNote(folderPath)
              : void invoke<NoteDetail>("move_note", { input: { id: noteId, folderPath } }).then(
                  async (moved) => {
                    await refreshWorkspace();
                    if (selectedNoteId === moved.id) {
                      await openNote(moved.id);
                    }
                  },
                  (error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    setNoteErrorMessage(mapNoteErrorMessage(message));
                  },
                )
          }
          onTrashNote={(noteId) =>
            noteId === activeNote?.id
              ? void trashActiveNote()
              : void invoke<NoteSummary[]>("trash_note", { id: noteId }).then(
                  async () => {
                    await refreshWorkspace();
                  },
                  (error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    setNoteErrorMessage(mapNoteErrorMessage(message));
                  },
                )
          }
          onRefreshNote={(noteId) =>
            void refreshWorkspace().then(
              async () => {
                await openNote(noteId);
              },
              (error) => {
                const message = error instanceof Error ? error.message : String(error);
                setNoteErrorMessage(mapNoteErrorMessage(message));
              },
            )
          }
          onRevealFolder={(folderPath) => void openPath(`${vaultPath}/Notes/${folderPath}`)}
          onRevealNote={(note) => void revealItemInDir(`${vaultPath}/${note.relativePath}`)}
          onDeleteNote={(note) =>
            note.isTrashed
              ? void invoke<NoteSummary[]>("delete_note", { id: note.id }).then(
                  async () => {
                    const workspace = await refreshWorkspace();
                    if (selectedNoteId === note.id) {
                      const next = workspace.notes.find((item) => item.folderPath === "trash") ?? workspace.notes[0];
                      if (next) {
                        await openNote(next.id);
                      } else {
                        setActiveNote(null);
                        setSelectedNoteId("");
                      }
                    }
                  },
                  (error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    setNoteErrorMessage(mapNoteErrorMessage(message));
                  },
                )
              : note.id === activeNote?.id
                ? void trashActiveNote()
                : void invoke<NoteSummary[]>("trash_note", { id: note.id }).then(
                    async () => {
                      await refreshWorkspace();
                    },
                    (error) => {
                      const message = error instanceof Error ? error.message : String(error);
                      setNoteErrorMessage(mapNoteErrorMessage(message));
                    },
                  )
          }
          onOpenTrash={() => {
            setSettingsSection("trash");
            setSettingsOpen(true);
          }}
          showTime={settings.showNoteTime}
        />
      </aside>

      <div
        className={`sidebar-resizer ${sidebarResizeActive ? "is-active" : ""}`}
        onMouseDown={(event) => {
          if (event.button === 0) {
            isResizingSidebar.current = true;
            setSidebarResizeActive(true);
          }
        }}
      />

      <EditorWorkspace
        messages={messages}
        language={settings.language}
        activeNote={activeNote}
        autoFocusTitleNoteId={autoFocusTitleNoteId}
        onTitleChange={(title) => updateActiveNote({ title })}
        onContentChange={(html) =>
          setActiveNote((current) =>
            current
              ? {
                  ...current,
                  blocks: current.blocks.map((block) =>
                    block.type === "richText" ? { ...block, html } : block,
                  ),
                }
              : current,
          )
        }
        onRestore={() => void restoreActiveNote()}
        onDeletePermanently={() => void deleteActiveNotePermanently()}
        errorMessage={noteErrorMessage}
      />

    </div>
  );

  return (
    <div className="app-shell">
      <ShellFrame
        spec={appUiSpec}
        messages={messages}
        activeModule={embedded.active ?? (playerOpen ? "player" : "notes")}
        modulesDisabled={embedded.busy}
        bodyContent={
          <>
            {notesBodyContent}
            <PlayerWorkspace
              active={playerOpen && !embedded.active}
              onBack={() => setPlayerOpen(false)}
              onQueueChange={setPlayerHasQueue}
            />
            {embedded.active && <div className="embedded-placeholder">正在加载独立 WebView…</div>}
          </>
        }
        settingsPanel={
          <SettingsPanel
            open={settingsOpen}
            messages={messages}
            version={appVersion}
            updateStatus={updateStatus}
            updateActionLabel={availableUpdate ? messages.updateInstallButton : messages.updateCheckButton}
            updateActionDisabled={updateBusy}
            language={settings.language}
            showNoteTime={settings.showNoteTime}
            showMemoryInTitlebar={settings.showMemoryInTitlebar}
            closePlayerOnPause={settings.closePlayerOnPause}
            closeBehavior={settings.closeBehavior}
            httpProxy={settings.httpProxy}
            httpsProxy={settings.httpsProxy}
            allProxy={settings.allProxy}
            noProxy={settings.noProxy}
            vaultPath={vaultPath}
            resourceUsage={resourceUsage}
            trashNotes={notes
              .filter((note) => note.isTrashed)
              .sort((left, right) => (right.deletedAt ?? right.updatedAt) - (left.deletedAt ?? left.updatedAt))}
            initialSection={settingsSection}
            onLanguageChange={(language) => void updateSettings({ ...settings, language })}
            onShowNoteTimeChange={(showNoteTime) => void updateSettings({ ...settings, showNoteTime })}
            onShowMemoryInTitlebarChange={(showMemoryInTitlebar) => void updateSettings({ ...settings, showMemoryInTitlebar })}
            onClosePlayerOnPauseChange={(closePlayerOnPause) => void updateSettings({ ...settings, closePlayerOnPause })}
            onCloseBehaviorChange={(closeBehavior) => void updateSettings({ ...settings, closeBehavior })}
            onHttpProxyChange={(httpProxy) => void updateSettings({ ...settings, httpProxy })}
            onHttpsProxyChange={(httpsProxy) => void updateSettings({ ...settings, httpsProxy })}
            onAllProxyChange={(allProxy) => void updateSettings({ ...settings, allProxy })}
            onNoProxyChange={(noProxy) => void updateSettings({ ...settings, noProxy })}
            onUpdateAction={() => void handleUpdateAction()}
            onRestoreTrashNote={restoreTrashedNote}
            onDeleteTrashNote={deleteTrashedNote}
            onViewTrashNote={async (noteId) => {
              try {
                return await invoke<NoteDetail>("load_note", { id: noteId });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setNoteErrorMessage(mapNoteErrorMessage(message));
                return null;
              }
            }}
            onEmptyTrash={() => void emptyTrash()}
            onClose={() => setSettingsOpen(false)}
          />
        }
        playerAction={
          playerHasQueue
            ? {
                label: settings.closePlayerOnPause ? messages.closePlayerButton : messages.pausePlayerButton,
                kind: settings.closePlayerOnPause ? "close" : "pause",
                onClick: runPlayerQuickAction,
              }
            : null
        }
        showMemory={settings.showMemoryInTitlebar}
        memoryBytes={resourceUsage?.totalMemoryBytes ?? null}
        processCount={resourceUsage?.totalProcesses ?? null}
        onSelectModule={(moduleId) => {
          if (!["notes", "player", "asmr", "gallery"].includes(moduleId)) return;
          void embedded.select(moduleId === "asmr" || moduleId === "gallery" ? moduleId : null)
            .then((switched) => {
              if (!switched) return;
              setSettingsOpen(false);
              setPlayerOpen(moduleId === "player");
            });
        }}
        onOpenSettings={() => {
          if (settingsOpen) {
            setSettingsOpen(false);
            return;
          }
          // Child WebViews sit above the shell page, so return to the shell first.
          void (embedded.active ? embedded.select(null) : Promise.resolve(true)).then((switched) => {
            if (!switched) return;
            setSettingsSection("general");
            setSettingsOpen(true);
          });
        }}
      />
      {confirmRequest ? (
        <div
          className="inline-modal-backdrop app-confirm-backdrop"
          onClick={() => answerConfirm(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              answerConfirm(false);
            }
          }}
        >
          <div className="inline-modal" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="inline-modal-header">
              <h3>{confirmRequest.title}</h3>
            </div>
            <p className="inline-modal-body">{confirmRequest.body}</p>
            <div className="inline-modal-actions">
              <button type="button" className="soft-button" onClick={() => answerConfirm(false)}>
                {messages.cancelButton}
              </button>
              <button
                type="button"
                autoFocus
                className={confirmRequest.danger ? "danger-button" : "primary-button"}
                onClick={() => answerConfirm(true)}
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

export default App;
