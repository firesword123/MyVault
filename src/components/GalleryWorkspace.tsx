import { convertFileSrc } from "@tauri-apps/api/core";
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
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import type { LocaleMessages } from "../i18n";
import type { GalleryImageEntry } from "../types";
import { formatFileSize, formatTimestamp } from "../utils";

type PendingImportItem = {
  file: File;
  key: string;
  previewUrl: string;
  relativeParentPath: string;
};

type FolderModalState =
  | { mode: "create"; value: string }
  | { mode: "rename"; folderPath: string; value: string }
  | null;

const INITIAL_IMAGE_BATCH = 60;
const IMAGE_BATCH_STEP = 40;

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
  tags: string[];
  selectedFolderPath: string;
  selectedTag: string;
  selectedImageId: string;
  previewOpen: boolean;
  importing: boolean;
  onSelectFolder: (folderPath: string) => void;
  onSelectTag: (tag: string) => void;
  onSelectImage: (imageId: string) => void;
  onClosePreview: () => void;
  onCreateFolder: (folderPath: string) => void;
  onRenameFolder: (fromPath: string, toPath: string) => void;
  onDeleteFolder: (folderPath: string) => void;
  onImportFiles: (items: { file: File; relativeParentPath: string }[]) => Promise<void>;
  onUpdateImageMeta: (id: string, tags: string[], note: string) => Promise<void>;
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

function normalizeTagInput(raw: string) {
  const next = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Map(next.map((value) => [value.toLowerCase(), value])).values());
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
  tags,
  selectedFolderPath,
  selectedTag,
  selectedImageId,
  previewOpen,
  importing,
  onSelectFolder,
  onSelectTag,
  onSelectImage,
  onClosePreview,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onImportFiles,
  onUpdateImageMeta,
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
  const gridSentinelRef = useRef<HTMLDivElement | null>(null);
  const gridScrollRef = useRef<HTMLDivElement | null>(null);

  const [folderModal, setFolderModal] = useState<FolderModalState>(null);
  const [activeMenuFolder, setActiveMenuFolder] = useState<string | null>(null);
  const [pendingImports, setPendingImports] = useState<PendingImportItem[]>([]);
  const [draftTags, setDraftTags] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [moveTarget, setMoveTarget] = useState("");
  const [visibleCount, setVisibleCount] = useState(INITIAL_IMAGE_BATCH);
  const [tagsCollapsed, setTagsCollapsed] = useState(false);
  const [trashContextMenu, setTrashContextMenu] = useState<{ x: number; y: number } | null>(null);
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
      setDraftTags("");
      setDraftNote("");
      setMoveTarget("");
      return;
    }
    setDraftTags(activeImage.tags.join(", "));
    setDraftNote(activeImage.note);
    setMoveTarget(moveTargets[0] ?? "");
  }, [activeImage?.id, activeImage?.note, activeImage?.tags, moveTargets]);

  useEffect(() => {
    setVisibleCount(INITIAL_IMAGE_BATCH);
  }, [searchText, selectedFolderPath, selectedTag, images.length]);

  useEffect(() => {
    if (previewOpen) return;
    const root = gridScrollRef.current;
    const target = gridSentinelRef.current;
    if (!root || !target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        setVisibleCount((current) => Math.min(current + IMAGE_BATCH_STEP, images.length));
      },
      { root, rootMargin: "0px 0px 320px 0px" },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [images.length, previewOpen]);

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

  const tagItems = useMemo(
    () =>
      tags
        .map((tag) => ({
          tag,
          count: libraryImages.filter((image) => image.tags.some((item) => item.toLowerCase() === tag.toLowerCase()))
            .length,
        }))
        .filter((item) => item.count > 0),
    [libraryImages, tags],
  );

  const visibleImages = images.slice(0, visibleCount);

  function openImportDialog(mode: "files" | "folder") {
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
        relativeParentPath: item.relativeParentPath,
      })),
    );
    for (const item of pendingImports) {
      URL.revokeObjectURL(item.previewUrl);
    }
    setPendingImports([]);
  }

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

  async function saveMeta() {
    if (!activeImage) return;
    await onUpdateImageMeta(activeImage.id, normalizeTagInput(draftTags), draftNote);
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

      <div className="module-body notes-module-body" style={{ ["--sidebar-width" as string]: `${sidebarWidth}px` }}>
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
              className={`gallery-filter-button ${!selectedFolderPath && !selectedTag ? "is-active" : ""}`}
              title={messages.galleryAllImagesLabel}
              onClick={() => {
                onSelectTag("");
                onSelectFolder("");
              }}
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
                    className={`gallery-filter-button ${
                      !selectedTag && selectedFolderPath === folder.path ? "is-active" : ""
                    }`}
                    title={folder.path}
                    style={{ paddingLeft: `${12 + folder.depth * 18}px` }}
                    onClick={() => {
                      onSelectTag("");
                      onSelectFolder(folder.path);
                    }}
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

            {tagItems.length ? (
              <div className="gallery-tags-panel">
                <button
                  type="button"
                  className="gallery-tags-toggle"
                  onClick={() => setTagsCollapsed((current) => !current)}
                >
                  <span className="section-label">{messages.galleryTagsLabel}</span>
                  <ChevronRight
                    size={14}
                    strokeWidth={1.8}
                    className={`gallery-tags-toggle-icon ${tagsCollapsed ? "" : "is-open"}`}
                  />
                </button>

                {!tagsCollapsed ? (
                  <div className="gallery-tags-list">
                    {tagItems.map(({ tag, count }) => (
                      <button
                        key={tag}
                        type="button"
                        className={`gallery-tag-filter ${selectedTag === tag ? "is-active" : ""}`}
                        title={tag}
                        onClick={() => {
                          onSelectTag(tag);
                          onSelectFolder("");
                        }}
                      >
                        <Tag size={13} strokeWidth={1.8} />
                        <span>{tag}</span>
                        <span className="gallery-filter-count">{count}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="gallery-trash-dock">
              <button
                type="button"
                className={`gallery-filter-button gallery-trash-button ${selectedFolderPath === "trash" ? "is-active" : ""}`}
                title={messages.trashLabel}
                onClick={() => {
                  onSelectTag("");
                  onSelectFolder("trash");
                }}
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
              {selectedTag
                ? messages.galleryTagResultTitle.replace("{tag}", selectedTag)
                : selectedFolderPath || messages.galleryAllImagesLabel}
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
                        <span className="meta-pill">{formatTimestamp(activeImage.updatedAt)}</span>
                      </div>

                      <label className="settings-field">
                        <span>{messages.galleryTagsEditorLabel}</span>
                        <input
                          type="text"
                          value={draftTags}
                          disabled={activeImage.isTrashed}
                          onChange={(event) => setDraftTags(event.target.value)}
                          placeholder={messages.galleryTagsEditorPlaceholder}
                        />
                      </label>

                      <label className="settings-field">
                        <span>{messages.galleryNoteLabel}</span>
                        <textarea
                          className="gallery-note-input"
                          value={draftNote}
                          disabled={activeImage.isTrashed}
                          onChange={(event) => setDraftNote(event.target.value)}
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
                            <button type="button" className="soft-button" onClick={() => void saveMeta()}>
                              {messages.saveButton}
                            </button>
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
                <div className="gallery-grid-scroll" ref={gridScrollRef}>
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
                          <img src={buildAssetUrl(image.absolutePath)} alt={image.fileName} loading="lazy" />
                        </div>
                        <div className="gallery-card-body">
                          <strong>{image.fileName}</strong>
                          <span>{image.folderPath || messages.galleryRootFolderLabel}</span>
                          <div className="gallery-card-tags">
                            {image.tags.slice(0, 3).map((tag) => (
                              <span key={tag} className="gallery-inline-tag">
                                {tag}
                              </span>
                            ))}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>

                  {visibleCount < images.length ? (
                    <div ref={gridSentinelRef} className="gallery-grid-sentinel" />
                  ) : null}
                </div>
              )
            ) : null}
          </div>
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
