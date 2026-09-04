import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FolderOpen,
  FolderInput,
  Images,
  RefreshCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEmbeddedGuard } from "../useEmbeddedGuard";

type GalleryItem = {
  relativePath: string;
  fileName: string;
  originalPath: string;
  thumbnailId: string;
  width: number;
  height: number;
};

type GalleryPage = {
  galleryPath: string;
  items: GalleryItem[];
  totalItems: number;
  page: number;
  totalPages: number;
  columnCount: number;
  columnWidth: number;
};

type ImportResult = {
  imported: number;
  skipped: number;
};

type LayoutMetrics = {
  width: number;
  height: number;
  targetWidth: number;
};

const SHELL_THUMBNAIL_ORIGIN = "http://myvault-thumbnail.localhost";
const SIZE_STORAGE_KEY = "myvault-gallery-thumbnail-size";
const SIZE_MIN = 128;
const SIZE_MAX = 288;
const SIZE_STEP = 32;
const DEFAULT_SIZE = 192;
const MASONRY_GAP = 16;
const CARD_TEXT_HEIGHT = 40;
const IMAGE_FILTERS = [
  {
    name: "图片",
    extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"],
  },
];

function selectedPaths(selection: string | string[] | null) {
  if (!selection) return [];
  return Array.isArray(selection) ? selection : [selection];
}

function storedThumbnailSize() {
  const value = Number.parseInt(localStorage.getItem(SIZE_STORAGE_KEY) ?? "", 10);
  if (!Number.isFinite(value)) return DEFAULT_SIZE;
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(value / SIZE_STEP) * SIZE_STEP));
}

function shellThumbnailEdge(displayWidth: number) {
  const desired = displayWidth * Math.max(1, window.devicePixelRatio || 1);
  return [96, 128, 160, 192, 224, 256].find((edge) => edge >= desired) ?? 256;
}

function distributeItems(items: GalleryItem[], columnCount: number, columnWidth: number) {
  const columns = Array.from({ length: Math.max(1, columnCount) }, () => [] as GalleryItem[]);
  const heights = columns.map(() => 0);
  for (const item of items) {
    let shortest = 0;
    for (let index = 1; index < heights.length; index += 1) {
      if (heights[index] < heights[shortest]) shortest = index;
    }
    const itemHeight = columnWidth * item.height / item.width + CARD_TEXT_HEIGHT;
    heights[shortest] += (heights[shortest] > 0 ? MASONRY_GAP : 0) + itemHeight;
    columns[shortest].push(item);
  }
  return columns;
}

export function GalleryWorkspace() {
  const [payload, setPayload] = useState<GalleryPage | null>(null);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("正在加载图库…");
  const [targetWidth, setTargetWidth] = useState(storedThumbnailSize);
  const contentRef = useRef<HTMLElement | null>(null);
  const requestId = useRef(0);
  const resizeTimer = useRef<number | null>(null);
  const currentPage = useRef(1);
  const anchorPath = useRef<string | null>(null);
  const layout = useRef<LayoutMetrics | null>(null);
  useEmbeddedGuard(busy ? "图库仍在加载或导入，请完成后再切换" : null);

  const loadPage = useCallback(async (
    page: number,
    refresh = false,
    metrics = layout.current,
    anchorRelativePath: string | null = null,
  ) => {
    if (!metrics) return;
    const currentRequest = ++requestId.current;
    setBusy(true);
    try {
      const next = await invoke<GalleryPage>("list_gallery", {
        input: {
          page,
          viewportWidth: metrics.width,
          viewportHeight: metrics.height,
          targetWidth: metrics.targetWidth,
          anchorRelativePath,
          refresh,
        },
      });
      if (currentRequest !== requestId.current) return;
      setPayload(next);
      currentPage.current = next.page;
      anchorPath.current = next.items[0]?.relativePath ?? null;
      setMessage(next.totalItems > 0 ? `共 ${next.totalItems} 张图片` : "图库中还没有图片");
    } catch (error) {
      if (currentRequest !== requestId.current) return;
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (currentRequest === requestId.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const measure = () => {
      const style = window.getComputedStyle(node);
      const width = Math.max(
        1,
        node.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
      );
      const height = Math.max(
        1,
        node.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom),
      );
      const next = {
        width: Math.floor(width),
        height: Math.floor(height),
        targetWidth: layout.current?.targetWidth ?? targetWidth,
      };
      const previous = layout.current;
      if (previous && previous.width === next.width && previous.height === next.height && previous.targetWidth === next.targetWidth) return;
      layout.current = next;
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
      resizeTimer.current = window.setTimeout(() => {
        void loadPage(currentPage.current, false, next, anchorPath.current);
      }, 90);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => {
      observer.disconnect();
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
      requestId.current += 1;
    };
  }, [loadPage]);

  useEffect(() => {
    const refreshFromDisk = () => {
      setPreview(null);
      void loadPage(currentPage.current, true);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refreshFromDisk();
    };
    window.addEventListener("focus", refreshFromDisk);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", refreshFromDisk);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [loadPage]);

  useEffect(() => {
    if (!preview || !payload) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreview(null);
        return;
      }
      const index = payload.items.findIndex((item) => item.relativePath === preview.relativePath);
      if (event.key === "ArrowLeft" && index > 0) {
        setPreview(payload.items[index - 1]);
      } else if (event.key === "ArrowRight" && index >= 0 && index < payload.items.length - 1) {
        setPreview(payload.items[index + 1]);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [payload, preview]);

  const columns = useMemo(
    () => payload ? distributeItems(payload.items, payload.columnCount, payload.columnWidth) : [],
    [payload],
  );
  const thumbnailEdge = payload ? shellThumbnailEdge(payload.columnWidth) : 256;

  async function importPaths(paths: string[]) {
    if (paths.length === 0) return;
    setBusy(true);
    setMessage("正在导入图片…");
    try {
      const result = await invoke<ImportResult>("import_gallery", { input: { paths } });
      const skipped = result.skipped > 0 ? `，跳过 ${result.skipped} 项` : "";
      await loadPage(1, false, layout.current, null);
      setMessage(`已导入 ${result.imported} 张图片${skipped}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  async function chooseImages() {
    const selection = await open({ multiple: true, directory: false, filters: IMAGE_FILTERS });
    await importPaths(selectedPaths(selection));
  }

  async function chooseFolder() {
    const selection = await open({ multiple: false, directory: true });
    await importPaths(selectedPaths(selection));
  }

  async function openGalleryFolder() {
    if (!payload) return;
    try {
      await openPath(payload.galleryPath);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function revealPreviewedImage() {
    if (!preview) return;
    try {
      await revealItemInDir(preview.originalPath);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function changeTargetWidth(value: number) {
    setTargetWidth(value);
    localStorage.setItem(SIZE_STORAGE_KEY, String(value));
    if (!layout.current) return;
    if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
    const next = { ...layout.current, targetWidth: value };
    layout.current = next;
    void loadPage(currentPage.current, false, next, anchorPath.current);
  }

  return (
    <main className="gallery-workspace">
      <header className="gallery-toolbar">
        <div className="gallery-heading">
          <span className="gallery-heading-icon"><Images size={18} /></span>
          <div>
            <h1>图库</h1>
            <p>{message}</p>
          </div>
        </div>
        <div className="gallery-actions">
          <button type="button" className="gallery-secondary-button" disabled={busy || !payload} onClick={() => void openGalleryFolder()}>
            <FolderOpen size={15} />
            打开图库目录
          </button>
          <button type="button" className="gallery-secondary-button" disabled={busy} onClick={() => void loadPage(currentPage.current, true)}>
            <RefreshCw size={15} />
            刷新
          </button>
          <button type="button" className="gallery-secondary-button" disabled={busy} onClick={() => void chooseFolder()}>
            <FolderInput size={15} />
            导入文件夹
          </button>
          <button type="button" className="gallery-primary-button" disabled={busy} onClick={() => void chooseImages()}>
            <FilePlus2 size={15} />
            导入图片
          </button>
        </div>
      </header>

      <section ref={contentRef} className={`gallery-content nice-scroll ${busy ? "is-busy" : ""}`} aria-busy={busy}>
        {payload && payload.items.length > 0 ? (
          <div className="gallery-masonry" style={{ gridTemplateColumns: `repeat(${payload.columnCount}, minmax(0, 1fr))` }}>
            {columns.map((column, columnIndex) => (
              <div className="gallery-masonry-column" key={columnIndex}>
                {column.map((item) => (
                  <button
                    type="button"
                    className="gallery-card"
                    key={item.relativePath}
                    title={item.relativePath}
                    onClick={() => setPreview(item)}
                  >
                    <span className="gallery-thumbnail-frame" style={{ aspectRatio: `${item.width} / ${item.height}` }}>
                      <img
                        src={`${SHELL_THUMBNAIL_ORIGIN}/${item.thumbnailId}?edge=${thumbnailEdge}`}
                        alt={item.fileName}
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                      />
                      <span className="gallery-dimensions">{item.width}×{item.height}</span>
                    </span>
                    <span className="gallery-card-name">{item.fileName}</span>
                    <span className="gallery-card-path">{item.relativePath}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : !busy ? (
          <div className="gallery-empty">
            <Images size={38} strokeWidth={1.4} />
            <h2>导入第一批图片</h2>
            <p>图片将复制到 MyVaultData/Gallery，原文件不会被修改。</p>
            <button type="button" className="gallery-primary-button" onClick={() => void chooseImages()}>
              <FilePlus2 size={16} />
              选择图片
            </button>
          </div>
        ) : null}
        {busy ? <div className="gallery-loading">处理中…</div> : null}
      </section>

      {payload ? (
        <footer className="gallery-pagination">
          <span className="gallery-storage-path" title={payload.galleryPath}>{payload.galleryPath}</span>
          <div className="gallery-pager">
            <button
              type="button"
              aria-label="上一页"
              disabled={busy || payload.page <= 1}
              onClick={() => void loadPage(payload.page - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>{payload.page} / {payload.totalPages}</span>
            <button
              type="button"
              aria-label="下一页"
              disabled={busy || payload.page >= payload.totalPages}
              onClick={() => void loadPage(payload.page + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <label className="gallery-size-control" title={`缩略图大小：${targetWidth}px`}>
            <ZoomOut size={14} />
            <input
              type="range"
              min={SIZE_MIN}
              max={SIZE_MAX}
              step={SIZE_STEP}
              value={targetWidth}
              aria-label="缩略图大小"
              onChange={(event) => changeTargetWidth(Number(event.target.value))}
            />
            <ZoomIn size={15} />
          </label>
        </footer>
      ) : null}

      {preview ? (
        <div className="gallery-preview" role="dialog" aria-modal="true" aria-label={preview.fileName}>
          <button type="button" className="gallery-preview-close" aria-label="关闭预览" onClick={() => setPreview(null)}>
            <X size={20} />
          </button>
          <img src={convertFileSrc(preview.originalPath)} alt={preview.fileName} draggable={false} />
          <div className="gallery-preview-footer">
            <div>
              <strong>{preview.fileName}</strong>
              <span>{preview.relativePath}</span>
            </div>
            <button type="button" className="gallery-preview-explorer-button" onClick={() => void revealPreviewedImage()}>
              <FolderOpen size={16} />
              在资源管理器中显示
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
