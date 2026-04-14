import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderPlus,
  FolderSearch,
  ImagePlus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import type { LocaleMessages } from "../i18n";
import type { GalleryFolderIndex, GalleryImageEntry } from "../types";
import { formatFileSize } from "../utils";

type PendingImportItem = {
  file: File;
  key: string;
  previewUrl: string;
  relativeParentPath: string;
};

type ImportSource = "files" | "folder";
type FolderImportMode = "preserve" | "flatten";

type FolderModalState =
  | { mode: "create"; value: string }
  | { mode: "rename"; folderPath: string; value: string }
  | null;

type GalleryWorkspaceProps = {
  messages: LocaleMessages;
  sidebarWidth: number;
  sidebarResizeActive: boolean;
  booting: boolean;
  searchText: string;
  onSearchTextChange: (value: string) => void;
  allImages: GalleryImageEntry[];
  images: GalleryImageEntry[];
  folders: string[];
  selectedFolderPath: string;
  selectedImageId: string;
  previewOpen: boolean;
  importing: boolean;
  onSelectFolder: (folderPath: string) => void;
  onSelectImage: (imageId: string) => void;
  onClosePreview: () => void;
  onCreateFolder: (folderPath: string) => void;
  onRenameFolder: (fromPath: string, toPath: string) => void;
  onDeleteFolder: (folderPath: string) => void;
  onImportFiles: (items: { file: File; relativeParentPath: string }[]) => Promise<void>;
  onReadFolderIndex: (folderPath: string) => Promise<GalleryFolderIndex>;
  onWriteImageNote: (folderPath: string, fileName: string, note: string) => Promise<void>;
  onMoveImage: (id: string, folderPath: string) => Promise<void>;
  onDeleteImage: (id: string) => Promise<void>;
  onRestoreImage: (id: string) => Promise<void>;
  onDeleteImagePermanently: (id: string) => Promise<void>;
  onEmptyTrash: () => void;
  onRevealImage: (absolutePath: string) => void;
  onOpenImageFolder: (absolutePath: string) => void;
  onStartSidebarResize: () => void;
  errorMessage?: string;
};

function folderDepth(folderPath: string) {
  if (!folderPath) return 0;
  return folderPath.split("/").length - 1;
}

function buildAssetUrl(absolutePath: string) {
  return convertFileSrc(absolutePath);
}

function positionContextMenu(clientX: number, clientY: number, menuWidth: number, menuHeight: number) {
  const padding = 12;
  return {
    x: Math.min(clientX, window.innerWidth - menuWidth - padding),
    y: Math.min(clientY, window.innerHeight - menuHeight - padding),
  };
}

export function GalleryWorkspace({
  messages,
  sidebarWidth,
  sidebarResizeActive,
  booting,
  searchText,
  onSearchTextChange,
  allImages,
  images,
  folders,
  selectedFolderPath,
  selectedImageId,
  previewOpen,
  importing,
  onSelectFolder,
  onSelectImage,
  onClosePreview,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onImportFiles,
  onReadFolderIndex,
  onWriteImageNote,
  onMoveImage,
  onDeleteImage,
  onRestoreImage,
  onDeleteImagePermanently,
  onEmptyTrash,
  onRevealImage,
  onOpenImageFolder,
  onStartSidebarResize,
  errorMessage,
}: GalleryWorkspaceProps) {
  const importFilesRef = useRef<HTMLInputElement | null>(null);
  const importFolderRef = useRef<HTMLInputElement | null>(null);
  const menuShellRef = useRef<HTMLDivElement | null>(null);
  const workspaceRootRef = useRef<HTMLDivElement | null>(null);

  const [folderModal, setFolderModal] = useState<FolderModalState>(null);
  const [activeMenuFolder, setActiveMenuFolder] = useState<string | null>(null);
  const [pendingImports, setPendingImports] = useState<PendingImportItem[]>([]);
  const [draftNote, setDraftNote] = useState("");
  const [moveTarget, setMoveTarget] = useState("");
  const [pendingImportSource, setPendingImportSource] = useState<ImportSource>("files");
  const [folderImportMode, setFolderImportMode] = useState<FolderImportMode>("preserve");
  const [folderIndexCache, setFolderIndexCache] = useState<Record<string, GalleryFolderIndex>>({});
  const [trashContextMenu, setTrashContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [gotoPageInput, setGotoPageInput] = useState("");
  const [imagesSuspended, setImagesSuspended] = useState(false);
  const trashContextMenuRef = useRef<HTMLDivElement | null>(null);

  const activeImage = images.find((image) => image.id === selectedImageId) ?? null;
  const activeIndex = activeImage ? images.findIndex((image) => image.id === activeImage.id) : -1;
  const moveTargets = folders.filter((folder) => folder !== activeImage?.folderPath);
  const libraryImages = useMemo(() => allImages.filter((image) => !image.isTrashed), [allImages]);
  const trashImages = useMemo(() => allImages.filter((image) => image.isTrashed), [allImages]);

  useEffect(() => {
    const folderInput = importFolderRef.current;
    if (folderInput) {
      folderInput.setAttribute("webkitdirectory", "");
      folderInput.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!menuShellRef.current?.contains(event.target as Node)) {
        setActiveMenuFolder(null);
      }
      if (!trashContextMenuRef.current?.contains(event.target as Node)) {
        setTrashContextMenu(null);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    return () => {
      for (const item of pendingImports) {
        URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, [pendingImports]);

  useEffect(() => {
    if (!activeImage) {
      setDraftNote("");
      setMoveTarget("");
      return;
    }
    const note = folderIndexCache[activeImage.folderPath]?.images?.[activeImage.fileName]?.note ?? activeImage.note;
    setDraftNote(note);
    setMoveTarget(moveTargets[0] ?? "");
  }, [activeImage?.id, activeImage?.note, activeImage?.fileName, activeImage?.folderPath, folderIndexCache, moveTargets]);

  useEffect(() => {
    async function loadFolderIndex(folderPath: string) {
      if (folderPath in folderIndexCache) return;
      const index = await onReadFolderIndex(folderPath);
      setFolderIndexCache((current) => ({ ...current, [folderPath]: index }));
    }

    const folderPath = activeImage ? activeImage.folderPath : selectedFolderPath;
    if (folderPath === "trash" || folderPath.startsWith("trash/")) return;
    if (!activeImage && !folderPath) return;
    void loadFolderIndex(folderPath);
  }, [activeImage?.folderPath, folderIndexCache, onReadFolderIndex, selectedFolderPath]);

  useEffect(() => {
    setCurrentPage(1);
  }, [images.length, searchText, selectedFolderPath, pageSize]);

  const folderItems = useMemo(
    () =>
      folders
        .slice()
        .sort((left, right) => left.localeCompare(right))
        .map((folderPath) => ({
          path: folderPath,
          depth: folderDepth(folderPath),
          count: libraryImages.filter(
            (image) => image.folderPath === folderPath || image.folderPath.startsWith(`${folderPath}/`),
          ).length,
        })),
    [folders, libraryImages],
  );

  const totalPages = Math.max(1, Math.ceil(images.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const visibleImages = images.slice((safeCurrentPage - 1) * pageSize, safeCurrentPage * pageSize);

  function releaseRenderedImages() {
    workspaceRootRef.current?.querySelectorAll("img").forEach((node) => {
      node.removeAttribute("src");
    });
  }

  useEffect(() => {
    async function bindMinimizeListener() {
      const unlisten = await listen("app:minimize", () => {
        releaseRenderedImages();
        setImagesSuspended(true);
      });
      return unlisten;
    }

    let dispose: (() => void) | undefined;
    void bindMinimizeListener().then((unlisten) => {
      dispose = unlisten;
    });

    function resumeImages() {
      setImagesSuspended(false);
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        resumeImages();
      }
    }

    window.addEventListener("focus", resumeImages);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      releaseRenderedImages();
      dispose?.();
      window.removeEventListener("focus", resumeImages);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  function openImportDialog(mode: "files" | "folder") {
    setPendingImportSource(mode);
    if (mode === "folder") {
      setFolderImportMode("preserve");
    }
    if (mode === "files") {
      importFilesRef.current?.click();
    } else {
      importFolderRef.current?.click();
    }
  }

  function replacePendingImports(files: FileList | null) {
    if (!files?.length) return;
    setPendingImports((current) => {
      for (const item of current) {
        URL.revokeObjectURL(item.previewUrl);
      }
      return Array.from(files)
        .filter((file) => file.type.startsWith("image/"))
        .map((file, index) => {
          const relativePath =
            (file as File & { webkitRelativePath?: string }).webkitRelativePath?.replace(/\\/g, "/") ?? "";
          const slashIndex = relativePath.lastIndexOf("/");
          return {
            file,
            key: `${file.name}-${index}-${file.size}`,
            previewUrl: URL.createObjectURL(file),
            relativeParentPath: slashIndex > -1 ? relativePath.slice(0, slashIndex) : "",
          };
        });
    });
  }

  async function confirmImport() {
    if (!pendingImports.length) return;
    await onImportFiles(
      pendingImports.map((item) => ({
        file: item.file,
        relativeParentPath:
          pendingImportSource === "folder" && folderImportMode === "preserve" ? item.relativeParentPath : "",
      })),
    );
    for (const item of pendingImports) {
      URL.revokeObjectURL(item.previewUrl);
    }
    setPendingImports([]);
  }

  function submitGotoPage() {
    const nextPage = Number(gotoPageInput);
    if (!Number.isFinite(nextPage)) return;
    const normalized = Math.min(Math.max(Math.trunc(nextPage), 1), totalPages);
    setCurrentPage(normalized);
    setGotoPageInput("");
  }

  const pageNumbers = useMemo(() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    const pages = new Set<number>([1, totalPages, safeCurrentPage - 1, safeCurrentPage, safeCurrentPage + 1]);
    return Array.from(pages)
      .filter((page) => page >= 1 && page <= totalPages)
      .sort((left, right) => left - right);
  }, [safeCurrentPage, totalPages]);

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

  async function saveNote() {
    if (!activeImage || activeImage.isTrashed) return;
    const currentNote = folderIndexCache[activeImage.folderPath]?.images?.[activeImage.fileName]?.note ?? activeImage.note;
    if (draftNote === currentNote) return;
    await onWriteImageNote(activeImage.folderPath, activeImage.fileName, draftNote);
    setFolderIndexCache((current) => ({
      ...current,
      [activeImage.folderPath]: {
        version: current[activeImage.folderPath]?.version ?? 1,
        images: {
          ...(current[activeImage.folderPath]?.images ?? {}),
          [activeImage.fileName]: { note: draftNote },
        },
      },
    }));
  }

  return (
    <>
      <input
        ref={importFilesRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => {
          replacePendingImports(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={importFolderRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => {
          replacePendingImports(event.target.files);
          event.target.value = "";
        }}
      />

      <div
        ref={workspaceRootRef}
        className="module-body notes-module-body"
        style={{ ["--sidebar-width" as string]: `${sidebarWidth}px` }}
      >
        <aside className="sidebar gallery-sidebar-panel">
          <div className="sidebar-action-stack gallery-sidebar-actions">
            <button
              type="button"
              className="sidebar-action-button"
              aria-label={messages.galleryImportFilesButton}
              title={messages.galleryImportFilesButton}
              onClick={() => openImportDialog("files")}
            >
              <Upload size={17} strokeWidth={1.8} />
              <span>{messages.galleryImportFilesButton}</span>
            </button>
            <button
              type="button"
              className="sidebar-action-button"
              aria-label={messages.galleryImportFolderButton}
              title={messages.galleryImportFolderButton}
              onClick={() => openImportDialog("folder")}
            >
              <ImagePlus size={17} strokeWidth={1.8} />
              <span>{messages.galleryImportFolderButton}</span>
            </button>
            <button
              type="button"
              className="sidebar-action-button"
              aria-label={messages.createFolderButton}
              title={messages.createFolderButton}
              onClick={() => setFolderModal({ mode: "create", value: "" })}
            >
              <FolderPlus size={17} strokeWidth={1.8} />
              <span>{messages.createFolderButton}</span>
            </button>
          </div>

          <div className="gallery-sidebar-tree">
            <div className="gallery-sidebar-scroll">
            <button
              type="button"
              className={`gallery-filter-button ${!selectedFolderPath ? "is-active" : ""}`}
              title={messages.galleryAllImagesLabel}
              onClick={() => onSelectFolder("")}
            >
              <Folder size={15} strokeWidth={1.8} />
              <span>{messages.galleryAllImagesLabel}</span>
              <span className="gallery-filter-count">{libraryImages.length}</span>
            </button>

            <div className="gallery-folder-list">
              {folderItems.map((folder) => (
                <div key={folder.path} className="gallery-folder-row">
                  <button
                    type="button"
                    className={`gallery-filter-button ${selectedFolderPath === folder.path ? "is-active" : ""}`}
                    title={folder.path}
                    style={{ paddingLeft: `${12 + folder.depth * 18}px` }}
                    onClick={() => onSelectFolder(folder.path)}
                  >
                    <ChevronRight size={14} strokeWidth={1.8} className="gallery-folder-chevron" />
                    <Folder size={15} strokeWidth={1.8} />
                    <span>{folder.path.split("/").pop()}</span>
                    <span className="gallery-filter-count">{folder.count}</span>
                  </button>

                  <div className="folder-menu-shell" ref={activeMenuFolder === folder.path ? menuShellRef : null}>
                    <button
                      type="button"
                      className="icon-button folder-menu-trigger"
                      aria-label={messages.renameFolderButton}
                      title={messages.renameFolderButton}
                      onClick={() =>
                        setActiveMenuFolder((current) => (current === folder.path ? null : folder.path))
                      }
                    >
                      <MoreHorizontal size={15} strokeWidth={1.8} />
                    </button>

                    {activeMenuFolder === folder.path ? (
                      <div className="folder-inline-actions">
                        <button
                          type="button"
                          className="icon-button folder-inline-action"
                          aria-label={messages.renameFolderButton}
                          title={messages.renameFolderButton}
                          onClick={() => {
                            setFolderModal({
                              mode: "rename",
                              folderPath: folder.path,
                              value: folder.path,
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
                            onDeleteFolder(folder.path);
                            setActiveMenuFolder(null);
                          }}
                        >
                          <Trash2 size={14} strokeWidth={1.8} />
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
            </div>

            <div className="gallery-trash-dock">
              <button
                type="button"
                className={`gallery-filter-button gallery-trash-button ${selectedFolderPath === "trash" ? "is-active" : ""}`}
                title={messages.trashLabel}
                onClick={() => onSelectFolder("trash")}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const nextPosition = positionContextMenu(event.clientX, event.clientY, 180, 52);
                  setTrashContextMenu(nextPosition);
                }}
              >
                <Trash2 size={15} strokeWidth={1.8} />
                <span>{messages.trashLabel}</span>
                <span className="gallery-filter-count">{trashImages.length}</span>
              </button>
            </div>
          </div>
        </aside>

        <div
          className={`sidebar-resizer ${sidebarResizeActive ? "is-active" : ""}`}
          onMouseDown={(event) => {
            if (event.button === 0) {
              onStartSidebarResize();
            }
          }}
        />

        <section className="gallery-main-panel">
          {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

          <div className="gallery-main-toolbar">
            <input
              type="search"
              value={searchText}
              placeholder={messages.gallerySearchPlaceholder}
              onChange={(event) => onSearchTextChange(event.target.value)}
            />
            <span className="meta-pill">
              {selectedFolderPath || messages.galleryAllImagesLabel}
            </span>
            <span className="meta-pill">
              {messages.galleryResultCountLabel.replace("{count}", String(images.length))}
            </span>
          </div>

          <div className="gallery-main-scroll">
            {booting ? <p className="empty-state gallery-empty-panel">{messages.galleryBootingLabel}</p> : null}

            {!booting && !images.length ? (
              <div className="empty-editor gallery-empty-panel">
                <h3>{messages.galleryEmptyTitle}</h3>
                <p>{messages.galleryEmptyBody}</p>
              </div>
            ) : null}

            {!booting && images.length ? (
              previewOpen && activeImage ? (
                <div className="gallery-preview-shell">
                  <div className="gallery-preview-toolbar">
                    <button
                      type="button"
                      className="soft-button"
                      title={messages.galleryBackToGridButton}
                      onClick={onClosePreview}
                    >
                      <ArrowLeft size={16} strokeWidth={1.8} />
                      {messages.galleryBackToGridButton}
                    </button>
                    <span className="meta-pill">
                      {messages.galleryPreviewIndexLabel
                        .replace("{current}", String(activeIndex + 1))
                        .replace("{total}", String(images.length))}
                    </span>
                  </div>

                  <div className="gallery-preview-content">
                    <div className="gallery-preview-stage">
                      <button
                        type="button"
                        className="gallery-nav-button"
                        title={messages.galleryPreviousImageButton}
                        onClick={() => {
                          const next = images[(activeIndex - 1 + images.length) % images.length];
                          onSelectImage(next.id);
                        }}
                      >
                        <ChevronRight size={18} strokeWidth={1.8} className="is-left" />
                      </button>

                      <div className="gallery-preview-image-frame">
                        <img src={buildAssetUrl(activeImage.absolutePath)} alt={activeImage.fileName} />
                      </div>

                      <button
                        type="button"
                        className="gallery-nav-button"
                        title={messages.galleryNextImageButton}
                        onClick={() => {
                          const next = images[(activeIndex + 1) % images.length];
                          onSelectImage(next.id);
                        }}
                      >
                        <ChevronRight size={18} strokeWidth={1.8} />
                      </button>
                    </div>

                    <aside className="gallery-detail-panel">
                      <div className="gallery-detail-header">
                        <h3>{activeImage.fileName}</h3>
                        <p>{activeImage.folderPath || messages.galleryRootFolderLabel}</p>
                      </div>

                      <div className="gallery-detail-meta">
                        <span className="meta-pill">{formatFileSize(activeImage.fileSize)}</span>
                        {activeImage.height && activeImage.width ? (
                          <span className="meta-pill">{`${activeImage.height} x ${activeImage.width}`}</span>
                        ) : null}
                      </div>

                      <label className="settings-field">
                        <span>{messages.galleryNoteLabel}</span>
                        <textarea
                          className="gallery-note-input"
                          value={draftNote}
                          disabled={activeImage.isTrashed}
                          onChange={(event) => setDraftNote(event.target.value)}
                          onBlur={() => void saveNote()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void saveNote();
                            }
                          }}
                          placeholder={messages.galleryNotePlaceholder}
                        />
                      </label>

                      {!activeImage.isTrashed ? (
                        <label className="move-note-field">
                          <span>{messages.moveTargetLabel}</span>
                          <select
                            value={moveTarget}
                            onChange={(event) => setMoveTarget(event.target.value)}
                            disabled={!moveTargets.length}
                          >
                            {moveTargets.length ? null : (
                              <option value="">{messages.galleryMoveEmptyFoldersHint}</option>
                            )}
                            {moveTargets.map((folder) => (
                              <option key={folder} value={folder}>
                                {folder}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}

                      <div className="gallery-detail-actions">
                        {!activeImage.isTrashed ? (
                          <>
                            <button
                              type="button"
                              className="soft-button"
                              disabled={!moveTarget}
                              onClick={() => void onMoveImage(activeImage.id, moveTarget)}
                            >
                              {messages.galleryMoveImageButton}
                            </button>
                            <button
                              type="button"
                              className="soft-button"
                              onClick={() => onRevealImage(activeImage.absolutePath)}
                            >
                              <FolderSearch size={16} strokeWidth={1.8} />
                              {messages.revealNoteButton}
                            </button>
                            <button
                              type="button"
                              className="soft-button"
                              onClick={() => onOpenImageFolder(activeImage.absolutePath)}
                            >
                              <Folder size={16} strokeWidth={1.8} />
                              {messages.openFolderButton}
                            </button>
                            <button
                              type="button"
                              className="danger-button"
                              onClick={() => void onDeleteImage(activeImage.id)}
                            >
                              {messages.deleteButton}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="soft-button"
                              onClick={() => void onRestoreImage(activeImage.id)}
                            >
                              {messages.restoreButton}
                            </button>
                            <button type="button" className="soft-button" onClick={onEmptyTrash}>
                              {messages.emptyTrashButton}
                            </button>
                            <button
                              type="button"
                              className="danger-button"
                              onClick={() => void onDeleteImagePermanently(activeImage.id)}
                            >
                              {messages.deletePermanentlyButton}
                            </button>
                          </>
                        )}
                      </div>
                    </aside>
                  </div>
                </div>
              ) : (
                <div className="gallery-grid-scroll">
                  <div className="gallery-grid">
                    {visibleImages.map((image) => (
                      <button
                        key={image.id}
                        type="button"
                        className={`gallery-card ${selectedImageId === image.id ? "is-selected" : ""}`}
                        title={image.fileName}
                        onClick={() => onSelectImage(image.id)}
                      >
                        <div className="gallery-card-thumb">
                          <img
                            src={imagesSuspended ? undefined : buildAssetUrl(image.absolutePath)}
                            alt={image.fileName}
                            loading="lazy"
                          />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )
            ) : null}
          </div>

          {!booting && images.length ? (
            <div className="gallery-pagination">
              <button
                type="button"
                className="soft-button"
                disabled={safeCurrentPage <= 1}
                onClick={() => setCurrentPage((current) => Math.max(current - 1, 1))}
              >
                {"<"}
              </button>
              {pageNumbers.map((page, index) => {
                const previous = pageNumbers[index - 1];
                return (
                  <div key={page} className="gallery-pagination-group">
                    {index > 0 && previous && page - previous > 1 ? (
                      <span className="gallery-pagination-ellipsis">...</span>
                    ) : null}
                    <button
                      type="button"
                      className={`soft-button ${page === safeCurrentPage ? "is-active" : ""}`}
                      onClick={() => setCurrentPage(page)}
                    >
                      {page}
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="soft-button"
                disabled={safeCurrentPage >= totalPages}
                onClick={() => setCurrentPage((current) => Math.min(current + 1, totalPages))}
              >
                {">"}
              </button>
              <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value) || 12)}>
                <option value={12}>12 / page</option>
                <option value={20}>20 / page</option>
                <option value={40}>40 / page</option>
              </select>
              <label className="gallery-pagination-goto">
                <span>Go to</span>
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={gotoPageInput}
                  onChange={(event) => setGotoPageInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      submitGotoPage();
                    }
                  }}
                />
              </label>
            </div>
          ) : null}
        </section>
      </div>

      {folderModal ? (
        <div className="inline-modal-backdrop" onClick={() => setFolderModal(null)}>
          <div className="inline-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inline-modal-header">
              <h3>
                {folderModal.mode === "create"
                  ? messages.galleryCreateFolderTitle
                  : messages.galleryRenameFolderTitle}
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

      {pendingImports.length ? (
        <div className="inline-modal-backdrop" onClick={() => !importing && setPendingImports([])}>
          <div className="inline-modal gallery-import-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inline-modal-header">
              <h3>{messages.galleryImportPreviewTitle}</h3>
            </div>

            <p className="gallery-import-summary">
              {messages.galleryImportPreviewBody
                .replace("{count}", String(pendingImports.length))
                .replace("{folder}", selectedFolderPath || messages.galleryRootFolderLabel)}
            </p>

            {pendingImportSource === "folder" ? (
              <div className="settings-field">
                <span>{messages.galleryImportModeLabel}</span>
                <label className="settings-toggle">
                  <input
                    type="radio"
                    name="gallery-import-mode"
                    checked={folderImportMode === "preserve"}
                    onChange={() => setFolderImportMode("preserve")}
                  />
                  <span>{messages.galleryImportModePreserve}</span>
                </label>
                <label className="settings-toggle">
                  <input
                    type="radio"
                    name="gallery-import-mode"
                    checked={folderImportMode === "flatten"}
                    onChange={() => setFolderImportMode("flatten")}
                  />
                  <span>{messages.galleryImportModeFlatten}</span>
                </label>
              </div>
            ) : null}

            <div className="gallery-import-list">
              {pendingImports.slice(0, 12).map((item) => (
                <div key={item.key} className="gallery-import-row">
                  <img src={item.previewUrl} alt={item.file.name} />
                  <div>
                    <strong>{item.file.name}</strong>
                    <span>{item.relativeParentPath || messages.galleryRootFolderLabel}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="inline-modal-actions">
              <button
                type="button"
                className="soft-button"
                disabled={importing}
                onClick={() => setPendingImports([])}
              >
                {messages.cancelButton}
              </button>
              <button type="button" className="soft-button" disabled={importing} onClick={() => void confirmImport()}>
                {importing ? messages.galleryImportingLabel : messages.confirmButton}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {trashContextMenu ? (
        <div
          ref={trashContextMenuRef}
          className="note-context-menu"
          style={{ left: `${trashContextMenu.x}px`, top: `${trashContextMenu.y}px` }}
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
