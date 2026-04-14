import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
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
import { GalleryWorkspace } from "./components/GalleryWorkspace";
import { EditorWorkspace, NotesListPanel } from "./components/NotesWorkspace";
import { SettingsPanel } from "./components/SettingsPanel";
import { ShellFrame } from "./components/ShellFrame";
import { resolveMessages } from "./i18n";
import type {
  AppSettings,
  BootstrapPayload,
  GalleryFolderIndex,
  GalleryBootstrapPayload,
  GalleryImageEntry,
  GalleryWorkspacePayload,
  NoteDetail,
  NoteSummary,
  WorkspacePayload,
} from "./types";
import { appUiSpec } from "./ui-spec";
import { noteSignature, previewText } from "./utils";
import "./App.css";

type ModuleId = "notes" | "gallery";

function normalizeFolderInput(folderPath: string) {
  return folderPath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function App() {
  const [activeModule, setActiveModule] = useState<ModuleId>("notes");
  const [settings, setSettings] = useState<AppSettings>({
    language: "zh-CN",
    showNoteTime: false,
    colorPresets: ["#ef4444", "#eab308", "#3b82f6", "#22c55e"],
    colorPresetCount: 4,
    closeBehavior: "quit",
    httpProxy: "",
    httpsProxy: "",
    allProxy: "",
    noProxy: "",
  });
  const [vaultPath, setVaultPath] = useState("");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [activeNote, setActiveNote] = useState<NoteDetail | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState("");
  const [searchText, setSearchText] = useState("");
  const [notesBooting, setNotesBooting] = useState(true);
  const [noteErrorMessage, setNoteErrorMessage] = useState("");
  const [draftTargetFolders, setDraftTargetFolders] = useState<Record<string, string>>({});
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [galleryImagesRootPath, setGalleryImagesRootPath] = useState("");
  const [galleryImages, setGalleryImages] = useState<GalleryImageEntry[]>([]);
  const [galleryFolders, setGalleryFolders] = useState<string[]>([]);
  const [selectedGalleryFolderPath, setSelectedGalleryFolderPath] = useState("");
  const [selectedGalleryImageId, setSelectedGalleryImageId] = useState("");
  const [galleryPreviewOpen, setGalleryPreviewOpen] = useState(false);
  const [gallerySearchText, setGallerySearchText] = useState("");
  const [galleryBooting, setGalleryBooting] = useState(true);
  const [galleryImporting, setGalleryImporting] = useState(false);
  const [galleryErrorMessage, setGalleryErrorMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(290);
  const [sidebarResizeActive, setSidebarResizeActive] = useState(false);
  const [appVersion, setAppVersion] = useState("Resolving...");
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);

  const activeNoteRef = useRef<NoteDetail | null>(null);
  const isResizingSidebar = useRef(false);
  const lastSavedSignature = useRef("");
  const autosaveTimer = useRef<number | null>(null);

  const deferredSearch = useDeferredValue(searchText);
  const deferredGallerySearch = useDeferredValue(gallerySearchText);
  const messages = resolveMessages(settings.language);
  const activeFolderPath = activeNote?.folderPath ?? "";
  const draftNotes = useMemo(
    () => notes.filter((note) => note.isDraft).sort((left, right) => right.updatedAt - left.updatedAt),
    [notes],
  );

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

  function mapGalleryErrorMessage(message: string) {
    switch (message) {
      case "only empty gallery folders can be deleted":
        return messages.errorGalleryFolderDeleteNotEmpty;
      case "gallery folder not found":
        return messages.errorGalleryFolderNotFound;
      case "gallery folder already exists":
        return messages.errorGalleryFolderExists;
      case "invalid gallery folder path":
        return messages.errorGalleryFolderInvalid;
      case "unsupported image format":
        return messages.errorGalleryImageFormat;
      case "image not found":
        return messages.errorGalleryImageNotFound;
      case "target gallery folder is not allowed":
        return messages.errorGalleryMoveTargetMissing;
      default:
        return message;
    }
  }

  function isProtectedFolderPath(folderPath: string) {
    return folderPath === "drafts" || folderPath === "inbox" || folderPath === "trash";
  }

  async function flushPendingDraft(note: NoteDetail | null) {
    if (!note) return;
    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    if (noteSignature(note) === lastSavedSignature.current) {
      return;
    }
    await persistNote(note, "draft");
  }

  const filteredNotes = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) return notes;
    return notes.filter((note) => {
      const haystacks = [note.title, note.preview, note.relativePath, note.folderPath];
      return haystacks.some((value) => value.toLowerCase().includes(query));
    });
  }, [deferredSearch, notes]);

  const filteredGalleryImages = useMemo(() => {
    const query = deferredGallerySearch.trim().toLowerCase();
    return galleryImages.filter((image) => {
      if (selectedGalleryFolderPath === "trash") {
        return image.isTrashed && [image.fileName, image.folderPath, image.note]
          .some((value) => value.toLowerCase().includes(query));
      }
      if (image.isTrashed) {
        return false;
      }
      if (selectedGalleryFolderPath) {
        if (
          image.folderPath !== selectedGalleryFolderPath &&
          !image.folderPath.startsWith(`${selectedGalleryFolderPath}/`)
        ) {
          return false;
        }
      }
      if (!query) return true;
      return [image.fileName, image.folderPath, image.note]
        .some((value) => value.toLowerCase().includes(query));
    });
  }, [deferredGallerySearch, galleryImages, selectedGalleryFolderPath]);

  useEffect(() => {
    activeNoteRef.current = activeNote;
  }, [activeNote]);

  useEffect(() => {
    setUpdateStatus((current) => current || messages.updateIdleLabel);
  }, [messages]);

  useEffect(() => {
    setOpenFolders((current) => {
      const next = { ...current };
      for (const folder of folders) {
        if (!(folder in next)) {
          next[folder] = true;
        }
      }
      return next;
    });
  }, [folders]);

  async function openNote(noteId: string) {
    setNoteErrorMessage("");
    try {
      const currentNote = activeNoteRef.current;
      if (currentNote && currentNote.id !== noteId) {
        await flushPendingDraft(currentNote);
      }
      const detail = await invoke<NoteDetail>("load_note", { id: noteId });
      startTransition(() => {
        setActiveNote(detail);
        setSelectedNoteId(detail.id);
        lastSavedSignature.current = noteSignature(detail);
        if (detail.folderPath === "drafts") {
          setDraftTargetFolders((current) => ({
            ...current,
            [detail.id]: current[detail.id] ?? "inbox",
          }));
        }
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

  async function refreshGalleryWorkspace() {
    const payload = await invoke<GalleryWorkspacePayload>("list_gallery_workspace");
    setGalleryImages(payload.images);
    setGalleryFolders(payload.folders);
    return payload;
  }

  async function bootstrap() {
    try {
      const version = await getVersion();
      const [notesPayload, galleryPayload] = await Promise.all([
        invoke<BootstrapPayload>("bootstrap_app"),
        invoke<GalleryBootstrapPayload>("bootstrap_gallery"),
      ]);
      setAppVersion(`v${version}`);
      setSettings(notesPayload.settings);
      setVaultPath(notesPayload.vaultPath);
      setNotes(notesPayload.notes);
      setFolders(notesPayload.folders);
      setGalleryImagesRootPath(galleryPayload.imagesRootPath);
      setGalleryImages(galleryPayload.images);
      setGalleryFolders(galleryPayload.folders);
      const firstNote = notesPayload.notes.find((note) => !note.isDraft);
      if (firstNote) {
        await openNote(firstNote.id);
      } else {
        setActiveNote(null);
        setSelectedNoteId("");
      }
      const firstGalleryImage = galleryPayload.images.find((image) => !image.isTrashed) ?? galleryPayload.images[0];
      if (firstGalleryImage) {
        setSelectedGalleryImageId(firstGalleryImage.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(message);
      setGalleryErrorMessage(message);
    } finally {
      setNotesBooting(false);
      setGalleryBooting(false);
    }
  }

  async function createNote() {
    const existingDraft = draftNotes[0];
    if (existingDraft) {
      await openNote(existingDraft.id);
      return;
    }
    try {
      const detail = await invoke<NoteDetail>("create_note", {
        input: { title: "Untitled Note" },
      });
      await refreshWorkspace();
      setDraftTargetFolders((current) => ({ ...current, [detail.id]: current[detail.id] ?? "inbox" }));
      await openNote(detail.id);
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
      setOpenFolders((current) => ({ ...current, [normalizedPath]: true }));
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
      setOpenFolders((current) => {
        const next = { ...current };
        for (const [folderPath, isOpen] of Object.entries(current)) {
          if (!isFolderPathWithin(folderPath, fromPath)) continue;
          delete next[folderPath];
          next[replaceFolderPrefix(folderPath, fromPath, nextPath)] = isOpen;
        }
        return next;
      });
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
      if (!window.confirm(`${messages.deleteFolderConfirmTitle}\n\n${messages.deleteFolderConfirmBody}`)) {
        return;
      }
      const nextFolders = await invoke<string[]>("delete_folder", { input: { path } });
      setFolders(nextFolders);
      setOpenFolders((current) => {
        const next = { ...current };
        for (const folderPath of Object.keys(current)) {
          if (isFolderPathWithin(folderPath, path)) {
            delete next[folderPath];
          }
        }
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function persistNote(note: NoteDetail, mode: "draft" | "commit") {
    try {
      const saved = await invoke<NoteDetail>("save_note", {
        input: { id: note.id, title: note.title, content: note.content, mode },
      });
      setActiveNote(saved);
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
                  preview: previewText(saved.content),
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
      if (saved.folderPath !== "drafts") {
        setDraftTargetFolders((current) => {
          const next = { ...current };
          delete next[saved.id];
          return next;
        });
      }
      lastSavedSignature.current = noteSignature(saved);
      autosaveTimer.current = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function trashActiveNote() {
    if (!activeNote) return;
    try {
      await invoke<NoteSummary[]>("trash_note", { id: activeNote.id });
      const workspace = await refreshWorkspace();
      const next =
        workspace.notes.find((note) => note.id === activeNote.id) ??
        workspace.notes.find((note) => !note.isTrashed && !note.isDraft) ??
        workspace.notes[0];
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
      if (!window.confirm(`${messages.restoreNoteConfirmTitle}\n\n${messages.restoreNoteConfirmBody}`)) {
        return;
      }
      const restored = await invoke<NoteDetail>("restore_note", { id: activeNote.id });
      await refreshWorkspace();
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
        !window.confirm(
          `${messages.deleteNotePermanentConfirmTitle}\n\n${messages.deleteNotePermanentConfirmBody}`,
        )
      ) {
        return;
      }
      await invoke<NoteSummary[]>("delete_note", { id: activeNote.id });
      const workspace = await refreshWorkspace();
      const next = workspace.notes.find((note) => note.folderPath === "trash") ?? workspace.notes[0];
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

  async function moveActiveNote(folderPath: string) {
    if (!activeNote || !folderPath) return;
    try {
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

  async function saveDraftToFolder(folderPath: string) {
    if (!activeNote) return;
    try {
      const saved = await invoke<NoteDetail>("save_note", {
        input: { id: activeNote.id, title: activeNote.title, content: activeNote.content, mode: "commit" },
      });
      let nextDetail = saved;
      if (folderPath && folderPath !== "inbox") {
        nextDetail = await invoke<NoteDetail>("move_note", {
          input: { id: saved.id, folderPath },
        });
      }
      await refreshWorkspace();
      await openNote(nextDetail.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNoteErrorMessage(mapNoteErrorMessage(message));
    }
  }

  async function emptyTrash() {
    try {
      if (!window.confirm(`${messages.emptyTrashConfirmTitle}\n\n${messages.emptyTrashConfirmBody}`)) {
        return;
      }
      await invoke<NoteSummary[]>("empty_trash");
      const workspace = await refreshWorkspace();
      const next = workspace.notes.find((note) => !note.isTrashed && !note.isDraft) ?? workspace.notes[0];
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

  function updateActiveNote(patch: Partial<Pick<NoteDetail, "title" | "content">>) {
    setActiveNote((current) => (current ? { ...current, ...patch } : current));
  }

  async function clearDraft() {
    if (!activeNote || activeNote.folderPath !== "drafts") return;
    try {
      await invoke<NoteSummary[]>("delete_note", { id: activeNote.id });
      const workspace = await refreshWorkspace();
      setDraftTargetFolders((current) => {
        const next = { ...current };
        delete next[activeNote.id];
        return next;
      });
      const next = workspace.notes.find((note) => !note.isDraft && !note.isTrashed) ?? workspace.notes[0];
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

  function handleEditorKeyDown(event: KeyboardEvent<HTMLElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (activeModule === "notes" && activeNote) {
        if (activeNote.folderPath === "drafts") {
          void saveDraftToFolder(draftTargetFolders[activeNote.id] ?? "inbox");
        } else {
          void persistNote(activeNote, "commit");
        }
      }
    }
  }

  async function createImageFolder(folderPath: string) {
    const normalizedPath = normalizeFolderInput(folderPath);
    if (!normalizedPath) return;
    try {
      const nextFolders = await invoke<string[]>("create_image_folder", {
        input: { path: normalizedPath },
      });
      setGalleryFolders(nextFolders);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGalleryErrorMessage(mapGalleryErrorMessage(message));
    }
  }

  async function renameImageFolder(fromPath: string, toPath: string) {
    const normalizedPath = normalizeFolderInput(toPath);
    if (!normalizedPath || normalizedPath === fromPath) return;
    try {
      const nextFolders = await invoke<string[]>("rename_image_folder", {
        input: { fromPath, toPath: normalizedPath },
      });
      setGalleryFolders(nextFolders);
      await refreshGalleryWorkspace();
      if (selectedGalleryFolderPath === fromPath) {
        setSelectedGalleryFolderPath(normalizedPath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGalleryErrorMessage(mapGalleryErrorMessage(message));
    }
  }

  async function deleteImageFolder(path: string) {
    try {
      if (!window.confirm(`${messages.deleteFolderConfirmTitle}\n\n${messages.deleteFolderConfirmBody}`)) {
        return;
      }
      const nextFolders = await invoke<string[]>("delete_image_folder", { input: { path } });
      setGalleryFolders(nextFolders);
      if (selectedGalleryFolderPath === path) {
        setSelectedGalleryFolderPath("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGalleryErrorMessage(mapGalleryErrorMessage(message));
    }
  }

  async function importGalleryFiles(items: { file: File; relativeParentPath: string }[]) {
    if (!items.length) return;
    setGalleryImporting(true);
    setGalleryErrorMessage("");
    try {
      let lastImportedId = "";
      for (const item of items) {
        const bytes = Array.from(new Uint8Array(await item.file.arrayBuffer()));
        const imported = await invoke<GalleryImageEntry>("import_gallery_file", {
          input: {
            fileName: item.file.name,
            folderPath: selectedGalleryFolderPath === "trash" ? "" : selectedGalleryFolderPath,
            relativeParentPath: item.relativeParentPath,
            bytes,
          },
        });
        lastImportedId = imported.id;
      }
      await refreshGalleryWorkspace();
      if (lastImportedId) {
        setSelectedGalleryImageId(lastImportedId);
        setGalleryPreviewOpen(true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGalleryErrorMessage(mapGalleryErrorMessage(message));
    } finally {
      setGalleryImporting(false);
    }
  }

  async function readGalleryFolderIndex(folderPath: string) {
    try {
      return await invoke<GalleryFolderIndex>("read_folder_index", { folderPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGalleryErrorMessage(mapGalleryErrorMessage(message));
      return { version: 1, images: {} };
    }
  }

  async function writeGalleryImageNote(folderPath: string, fileName: string, note: string) {
    try {
      await invoke<GalleryFolderIndex>("write_image_note", { folderPath, fileName, note });
      setGalleryImages((current) =>
        current.map((image) =>
          image.folderPath === folderPath && image.fileName === fileName ? { ...image, note } : image,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGalleryErrorMessage(mapGalleryErrorMessage(message));
    }
  }

  async function moveGalleryImage(id: string, folderPath: string) {
    try {
      const moved = await invoke<GalleryImageEntry>("move_gallery_image", {
        input: { id, folderPath },
      });
      await refreshGalleryWorkspace();
      setSelectedGalleryImageId(moved.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGalleryErrorMessage(mapGalleryErrorMessage(message));
    }
  }

  async function deleteGalleryImage(id: string) {
    try {
      const nextImages = await invoke<GalleryImageEntry[]>("trash_gallery_image", { id });
      setGalleryImages(nextImages);
      if (!nextImages.find((image) => image.id === selectedGalleryImageId)) {
        const next = nextImages.find((image) => !image.isTrashed) ?? nextImages[0];
        setSelectedGalleryImageId(next?.id ?? "");
        if (!next) {
          setGalleryPreviewOpen(false);
        }
      }
      await refreshGalleryWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGalleryErrorMessage(mapGalleryErrorMessage(message));
    }
  }

  async function restoreGalleryImage(id: string) {
    try {
      const restored = await invoke<GalleryImageEntry>("restore_gallery_image", { id });
      await refreshGalleryWorkspace();
      setSelectedGalleryFolderPath("");
      setSelectedGalleryImageId(restored.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGalleryErrorMessage(mapGalleryErrorMessage(message));
    }
  }

  async function deleteGalleryImagePermanently(id: string) {
    try {
      if (
        !window.confirm(`${messages.galleryDeleteImageConfirmTitle}\n\n${messages.galleryDeleteImageConfirmBody}`)
      ) {
        return;
      }
      const nextImages = await invoke<GalleryImageEntry[]>("delete_gallery_image", { id });
      await refreshGalleryWorkspace();
      if (!nextImages.find((image) => image.id === selectedGalleryImageId)) {
        const next = nextImages.find((image) => image.isTrashed) ?? nextImages.find((image) => !image.isTrashed) ?? nextImages[0];
        setSelectedGalleryImageId(next?.id ?? "");
        if (!next) {
          setGalleryPreviewOpen(false);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGalleryErrorMessage(mapGalleryErrorMessage(message));
    }
  }

  async function emptyGalleryTrash() {
    try {
      if (!window.confirm(`${messages.emptyTrashConfirmTitle}\n\n${messages.emptyTrashConfirmBody}`)) {
        return;
      }
      const nextImages = await invoke<GalleryImageEntry[]>("empty_gallery_trash");
      await refreshGalleryWorkspace();
      if (selectedGalleryFolderPath === "trash") {
        const next = nextImages.find((image) => image.isTrashed);
        setSelectedGalleryImageId(next?.id ?? "");
        if (!next) {
          setGalleryPreviewOpen(false);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGalleryErrorMessage(mapGalleryErrorMessage(message));
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
      void persistNote(activeNote, "draft");
    }, 900);
    return () => {
      if (autosaveTimer.current) {
        window.clearTimeout(autosaveTimer.current);
      }
    };
  }, [activeNote]);

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
      const nextWidth = Math.min(Math.max(event.clientX, 220), 460);
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

  const notesModuleBody = (
    <div
      className="module-body notes-module-body"
      style={{ ["--sidebar-width" as string]: `${sidebarWidth}px` }}
      onKeyDown={handleEditorKeyDown}
    >
      <aside className="sidebar">
        <NotesListPanel
          messages={messages}
          onCreateNote={() => void createNote()}
          searchText={searchText}
          onSearchTextChange={setSearchText}
          booting={notesBooting}
          folders={folders}
          filteredNotes={filteredNotes}
          selectedNoteId={selectedNoteId}
          activeFolderPath={activeFolderPath}
          onSelectNote={(noteId) => void openNote(noteId)}
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
          onEmptyTrash={() => void emptyTrash()}
          showTime={settings.showNoteTime}
          openFolders={openFolders}
          onToggleFolder={(folderPath) =>
            setOpenFolders((current) => ({
              ...current,
              [folderPath]: current[folderPath] === false,
            }))
          }
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
        activeNote={activeNote}
        colorPresets={settings.colorPresets.slice(0, settings.colorPresetCount)}
        draftMoveTargets={folders.filter((folder) => folder !== "drafts" && folder !== "trash")}
        draftTargetFolder={activeNote ? draftTargetFolders[activeNote.id] ?? "inbox" : "inbox"}
        onTitleChange={(title) => updateActiveNote({ title })}
        onContentChange={(content) => updateActiveNote({ content })}
        onSave={() => activeNote && void persistNote(activeNote, "commit")}
        onDraftTargetFolderChange={(folderPath) =>
          activeNote &&
          setDraftTargetFolders((current) => ({
            ...current,
            [activeNote.id]: folderPath,
          }))
        }
        onSaveDraftToFolder={(folderPath) => void saveDraftToFolder(folderPath)}
        onClearDraft={() => void clearDraft()}
        onDelete={() => void trashActiveNote()}
        onRestore={() => void restoreActiveNote()}
        onDeletePermanently={() => void deleteActiveNotePermanently()}
        onEmptyTrash={() => void emptyTrash()}
        errorMessage={noteErrorMessage}
      />
    </div>
  );

  const galleryModuleBody = (
    <GalleryWorkspace
      messages={messages}
      sidebarWidth={sidebarWidth}
      sidebarResizeActive={sidebarResizeActive}
      booting={galleryBooting}
      searchText={gallerySearchText}
      onSearchTextChange={setGallerySearchText}
      allImages={galleryImages}
      images={filteredGalleryImages}
      folders={galleryFolders}
      selectedFolderPath={selectedGalleryFolderPath}
      selectedImageId={selectedGalleryImageId}
      previewOpen={galleryPreviewOpen}
      importing={galleryImporting}
      onSelectFolder={setSelectedGalleryFolderPath}
      onSelectImage={(imageId) => {
        setSelectedGalleryImageId(imageId);
        setGalleryPreviewOpen(true);
      }}
      onClosePreview={() => setGalleryPreviewOpen(false)}
      onCreateFolder={(folderPath) => void createImageFolder(folderPath)}
      onRenameFolder={(fromPath, toPath) => void renameImageFolder(fromPath, toPath)}
      onDeleteFolder={(folderPath) => void deleteImageFolder(folderPath)}
      onImportFiles={importGalleryFiles}
      onReadFolderIndex={readGalleryFolderIndex}
      onWriteImageNote={writeGalleryImageNote}
      onMoveImage={moveGalleryImage}
      onDeleteImage={deleteGalleryImage}
      onRestoreImage={restoreGalleryImage}
      onDeleteImagePermanently={deleteGalleryImagePermanently}
      onEmptyTrash={() => void emptyGalleryTrash()}
      onRevealImage={(absolutePath) => void revealItemInDir(absolutePath)}
      onOpenImageFolder={(absolutePath) => void openPath(absolutePath.replace(/[/\\][^/\\]+$/, ""))}
      onStartSidebarResize={() => {
        isResizingSidebar.current = true;
        setSidebarResizeActive(true);
      }}
      errorMessage={galleryErrorMessage}
    />
  );

  return (
    <div className="app-shell">
      <ShellFrame
        spec={appUiSpec}
        messages={messages}
        activeModule={activeModule}
        bodyContent={activeModule === "notes" ? notesModuleBody : galleryModuleBody}
        settingsPanel={
          <SettingsPanel
            open={settingsOpen}
            messages={messages}
            version={appVersion}
            updateStatus={updateStatus}
            updateActionLabel={
              availableUpdate ? messages.updateInstallButton : messages.updateCheckButton
            }
            updateActionDisabled={updateBusy}
            language={settings.language}
            showNoteTime={settings.showNoteTime}
            closeBehavior={settings.closeBehavior}
            httpProxy={settings.httpProxy}
            httpsProxy={settings.httpsProxy}
            allProxy={settings.allProxy}
            noProxy={settings.noProxy}
            vaultPath={activeModule === "gallery" ? galleryImagesRootPath || vaultPath : vaultPath}
            colorPresets={settings.colorPresets}
            colorPresetCount={settings.colorPresetCount}
            onLanguageChange={(language) => void updateSettings({ ...settings, language })}
            onShowNoteTimeChange={(showNoteTime) => void updateSettings({ ...settings, showNoteTime })}
            onCloseBehaviorChange={(closeBehavior) => void updateSettings({ ...settings, closeBehavior })}
            onHttpProxyChange={(httpProxy) => void updateSettings({ ...settings, httpProxy })}
            onHttpsProxyChange={(httpsProxy) => void updateSettings({ ...settings, httpsProxy })}
            onAllProxyChange={(allProxy) => void updateSettings({ ...settings, allProxy })}
            onNoProxyChange={(noProxy) => void updateSettings({ ...settings, noProxy })}
            onColorPresetsChange={(colorPresets) => void updateSettings({ ...settings, colorPresets })}
            onColorPresetCountChange={(colorPresetCount) =>
              void updateSettings({ ...settings, colorPresetCount })
            }
            onUpdateAction={() => void handleUpdateAction()}
            onClose={() => setSettingsOpen(false)}
          />
        }
        onSelectModule={(moduleId) => {
          if (moduleId === "notes" || moduleId === "gallery") {
            setActiveModule(moduleId);
          }
        }}
        onOpenSettings={() => setSettingsOpen((current) => !current)}
      />
    </div>
  );
}

export default App;
