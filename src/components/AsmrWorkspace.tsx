import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useEmbeddedGuard } from "../useEmbeddedGuard";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  File,
  FileAudio2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Play,
  Plus,
  Search,
  X,
} from "lucide-react";
import type {
  AsmrBootstrapPayload,
  AsmrDictionaries,
  AsmrFileItem,
  AsmrFolderPayload,
  AsmrImportPreview,
  AsmrImportResult,
  AsmrWork,
  PlayerQueueRequest,
} from "../types";

type AsmrSection = "library" | "circles" | "tags" | "voices";

type AsmrFilter = {
  kind: Exclude<AsmrSection, "library">;
  value: string;
};

type FilterEntry = {
  value: string;
  count: number;
};

type MetadataDraft = {
  title: string;
  circle: string;
  tags: string[];
  voiceActors: string[];
  note: string;
};

type MetadataPickerKey = "tags" | "voiceActors";
type StructuredMetadataMode = "skip" | "create";

type StructuredMetadataInput = {
  title?: unknown;
  circle?: unknown;
  tags?: unknown;
  voiceActors?: unknown;
  voice_actors?: unknown;
  note?: unknown;
};

function FileIcon({ kind }: { kind: AsmrFileItem["kind"] }) {
  if (kind === "folder") return <Folder size={26} fill="currentColor" strokeWidth={1.75} />;
  if (kind === "subtitle") return <FileText size={25} strokeWidth={1.75} />;
  if (kind === "audio") return <FileAudio2 size={25} strokeWidth={1.75} />;
  if (kind === "image") return <FileImage size={25} strokeWidth={1.75} />;
  return <File size={25} strokeWidth={1.75} />;
}

function fileKindLabel(file: AsmrFileItem) {
  if (file.kind === "folder") return "文件夹";
  if (file.kind === "audio") return file.subtitlePath ? "音频 · 同名字幕已关联" : "音频";
  if (file.kind === "subtitle") return "字幕";
  if (file.kind === "image") return "图片";
  return "文件";
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parentFolderPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function workCoverHue(rjId: string) {
  return Array.from(rjId).reduce((value, character) => (value * 31 + character.charCodeAt(0)) % 360, 24);
}

export function AsmrWorkspace() {
  const [view, setView] = useState<"library" | "detail">("library");
  const [activeSection, setActiveSection] = useState<AsmrSection>("library");
  const [activeFilter, setActiveFilter] = useState<AsmrFilter | null>(null);
  const [works, setWorks] = useState<AsmrWork[]>([]);
  const [libraryPath, setLibraryPath] = useState("");
  const [dictionaries, setDictionaries] = useState<AsmrDictionaries>({
    tags: [],
    voiceActors: [],
    circles: [],
  });
  const [selectedWorkId, setSelectedWorkId] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [folderItems, setFolderItems] = useState<AsmrFileItem[]>([]);
  const [selectedCoverPath, setSelectedCoverPath] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(8);
  const [searchText, setSearchText] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [metadataDraft, setMetadataDraft] = useState<MetadataDraft | null>(null);
  const [activeMetadataPicker, setActiveMetadataPicker] = useState<MetadataPickerKey | null>(null);
  const [metadataPickerSearch, setMetadataPickerSearch] = useState("");
  const [structuredMetadataText, setStructuredMetadataText] = useState("");
  const [structuredMetadataMode, setStructuredMetadataMode] = useState<StructuredMetadataMode>("skip");
  const [structuredMetadataStatus, setStructuredMetadataStatus] = useState("");
  useEmbeddedGuard(busy ? "DL_ASMR 正在导入，请完成后再切换" : metadataDraft ? "请先保存或取消元数据编辑，再切换模块" : null);

  const selectedWork = works.find((work) => work.rjId === selectedWorkId) ?? works[0] ?? null;
  const audioItems = folderItems.filter((item) => item.kind === "audio");

  const sectionLabel = activeSection === "circles" ? "社团" : activeSection === "tags" ? "标签" : activeSection === "voices" ? "声优" : "媒体库";
  const activeFilterLabel =
    activeFilter?.kind === "circles"
      ? `社团：${activeFilter.value}`
      : activeFilter?.kind === "tags"
        ? `标签：${activeFilter.value}`
        : activeFilter?.kind === "voices"
          ? `声优：${activeFilter.value}`
          : "";

  const baseWorks = useMemo(() => {
    if (!activeFilter) return works;
    return works.filter((work) => {
      if (activeFilter.kind === "circles") return (work.circle || "未指定") === activeFilter.value;
      if (activeFilter.kind === "tags") return work.tags.includes(activeFilter.value);
      return work.voiceActors.includes(activeFilter.value);
    });
  }, [activeFilter, works]);

  const filterEntries = useMemo<FilterEntry[]>(() => {
    if (activeSection === "library") return [];
    const counts = new Map<string, number>();
    const dictionaryValues =
      activeSection === "circles"
        ? dictionaries.circles
        : activeSection === "tags"
          ? dictionaries.tags
          : dictionaries.voiceActors;
    for (const value of dictionaryValues) {
      const normalized = value.trim();
      if (normalized) {
        counts.set(normalized, 0);
      }
    }
    for (const work of works) {
      const values =
        activeSection === "circles"
          ? [work.circle || "未指定"]
          : activeSection === "tags"
            ? work.tags
            : work.voiceActors;
      for (const value of values) {
        const normalized = value.trim();
        if (!normalized) continue;
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      }
    }
    const query = searchText.trim().toLowerCase();
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .filter((entry) => !query || entry.value.toLowerCase().includes(query))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
  }, [activeSection, dictionaries, searchText, works]);

  const showingFilterList = activeSection !== "library" && !activeFilter;

  const filteredWorks = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (!query) return baseWorks;
    return baseWorks.filter((work) => {
      const haystacks = [work.rjId, work.title, work.circle, ...work.tags, ...work.voiceActors];
      return haystacks.some((value) => value.toLowerCase().includes(query));
    });
  }, [baseWorks, searchText]);

  const pagedEntryCount = showingFilterList ? filterEntries.length : filteredWorks.length;
  const pageCount = Math.max(1, Math.ceil(pagedEntryCount / pageSize));
  const visibleWorks = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredWorks.slice(start, start + pageSize);
  }, [filteredWorks, page, pageSize]);
  const visibleFilterEntries = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filterEntries.slice(start, start + pageSize);
  }, [filterEntries, page, pageSize]);

  const bootstrapAsmr = useCallback(async () => {
    setErrorMessage("");
    try {
      const payload = await invoke<AsmrBootstrapPayload>("bootstrap_asmr");
      setWorks(payload.works);
      setDictionaries(payload.dictionaries);
      setLibraryPath(payload.libraryPath);
      setSelectedWorkId((current) => {
        if (current && payload.works.some((work) => work.rjId === current)) return current;
        if (current) {
          setView("library");
          setFolderPath("");
          setFolderItems([]);
          setSelectedCoverPath("");
        }
        return payload.works[0]?.rjId ?? "";
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  async function openInExplorer(path: string) {
    try {
      await openPath(path);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadFolder(workId: string, nextFolderPath: string) {
    setErrorMessage("");
    try {
      const payload = await invoke<AsmrFolderPayload>("list_asmr_folder", {
        input: {
          rjId: workId,
          folderPath: nextFolderPath,
        },
      });
      setFolderPath(payload.folderPath);
      setFolderItems(payload.items);
      setSelectedCoverPath("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setFolderPath(nextFolderPath);
      setFolderItems([]);
    }
  }

  async function importWork(mode: "copy" | "move") {
    setBusy(true);
    setErrorMessage("");
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      const preview = await invoke<AsmrImportPreview>("preview_asmr_import", {
        input: {
          sourcePath: selected,
        },
      });
      const actionLabel = mode === "move" ? "移动导入" : "复制导入";
      const moveNotice = mode === "move" ? "\n\n移动成功后，原位置中的作品文件夹会被移除。" : "";
      const overwrite = preview.alreadyExists
        ? window.confirm(
            `${preview.rjId} 已存在，是否覆盖并${actionLabel}？\n\n文件 ${preview.fileCount} 个，文件夹 ${preview.folderCount} 个\n音频 ${preview.audioCount} 个，字幕 ${preview.subtitleCount} 个，已关联字幕 ${preview.associatedSubtitleCount} 个\n图片 ${preview.imageCount} 个，其他 ${preview.otherCount} 个\n总大小 ${formatBytes(preview.totalSize)}${moveNotice}`,
          )
        : window.confirm(
            `确认${actionLabel} ${preview.rjId}？\n\n文件 ${preview.fileCount} 个，文件夹 ${preview.folderCount} 个\n音频 ${preview.audioCount} 个，字幕 ${preview.subtitleCount} 个，已关联字幕 ${preview.associatedSubtitleCount} 个\n图片 ${preview.imageCount} 个，其他 ${preview.otherCount} 个\n总大小 ${formatBytes(preview.totalSize)}${moveNotice}`,
          );
      if (!overwrite) return;
      const result = await invoke<AsmrImportResult>("import_asmr_work", {
        input: {
          sourcePath: selected,
          rjId: preview.rjId,
          overwrite: preview.alreadyExists,
          mode,
        },
      });
      await bootstrapAsmr();
      openWork(result.work.rjId, result.work.lastOpenedFolder ?? "");
      if (result.warning) setErrorMessage(result.warning);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function setCover(work: AsmrWork, relativePath: string) {
    if (!relativePath) return;
    setBusy(true);
    setErrorMessage("");
    try {
      const updated = await invoke<AsmrWork>("set_asmr_cover", {
        input: {
          rjId: work.rjId,
          relativePath,
        },
      });
      setWorks((current) => current.map((item) => (item.rjId === updated.rjId ? updated : item)));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function openWork(workId: string, preferredFolderPath?: string) {
    const work = works.find((item) => item.rjId === workId);
    setSelectedWorkId(workId);
    setView("detail");
    void loadFolder(workId, preferredFolderPath ?? work?.lastOpenedFolder ?? "");
  }

  function selectSection(section: AsmrSection) {
    setActiveSection(section);
    setActiveFilter(null);
    setSearchText("");
    setPage(1);
    setView("library");
  }

  function selectFilter(kind: Exclude<AsmrSection, "library">, value: string) {
    setActiveFilter({ kind, value });
    setSearchText("");
    setPage(1);
  }

  function dictionaryKind(section: Exclude<AsmrSection, "library">) {
    if (section === "circles") return "circle";
    if (section === "tags") return "tag";
    return "voiceActor";
  }

  function applyAsmrPayload(payload: AsmrBootstrapPayload) {
    setWorks(payload.works);
    setDictionaries(payload.dictionaries);
  }

  function mergeDictionaryValues(currentValues: string[], nextValues: string[]) {
    return Array.from(
      new Set([...currentValues, ...nextValues.map((value) => value.trim()).filter(Boolean)]),
    ).sort((left, right) => left.localeCompare(right));
  }

  async function upsertDictionaryValue(section: Exclude<AsmrSection, "library">, oldValue?: string) {
    const label = section === "circles" ? "社团" : section === "tags" ? "标签" : "声优";
    const nextValue = window.prompt(oldValue ? `重命名${label}` : `新增${label}`, oldValue ?? "");
    if (nextValue === null) return;
    const value = nextValue.trim();
    if (!value) return;
    setErrorMessage("");
    try {
      const payload = await invoke<AsmrBootstrapPayload>("upsert_asmr_dictionary", {
        input: {
          kind: dictionaryKind(section),
          oldValue: oldValue ?? null,
          value,
        },
      });
      applyAsmrPayload(payload);
      if (activeFilter?.kind === section && oldValue && activeFilter.value === oldValue) {
        setActiveFilter({ kind: section, value });
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteDictionaryValue(section: Exclude<AsmrSection, "library">, value: string) {
    const label = section === "circles" ? "社团" : section === "tags" ? "标签" : "声优";
    if (!window.confirm(`删除${label}「${value}」？\n\n该值也会从已关联作品中移除。`)) return;
    setErrorMessage("");
    try {
      const payload = await invoke<AsmrBootstrapPayload>("delete_asmr_dictionary", {
        input: {
          kind: dictionaryKind(section),
          value,
        },
      });
      applyAsmrPayload(payload);
      if (activeFilter?.kind === section && activeFilter.value === value) {
        setActiveFilter(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function startMetadataEdit(work: AsmrWork) {
    setMetadataDraft({
      title: work.title,
      circle: work.circle,
      tags: work.tags,
      voiceActors: work.voiceActors,
      note: work.note,
    });
    setActiveMetadataPicker(null);
    setMetadataPickerSearch("");
    setStructuredMetadataText("");
    setStructuredMetadataStatus("");
  }

  function addDraftValue(key: MetadataPickerKey, value: string) {
    setMetadataDraft((current) => {
      if (!current) return current;
      const values = current[key];
      if (values.includes(value)) return current;
      return {
        ...current,
        [key]: [...values, value],
      };
    });
  }

  function removeDraftValue(key: MetadataPickerKey, value: string) {
    setMetadataDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        [key]: current[key].filter((item) => item !== value),
      };
    });
  }

  function openMetadataPicker(key: MetadataPickerKey) {
    setActiveMetadataPicker((current) => (current === key ? null : key));
    setMetadataPickerSearch("");
  }

  function renderMetadataValueEditor(
    label: string,
    key: MetadataPickerKey,
    selectedValues: string[],
    dictionaryValues: string[],
  ) {
    const query = metadataPickerSearch.trim().toLowerCase();
    const candidates = dictionaryValues
      .filter((value) => !selectedValues.includes(value))
      .filter((value) => !query || value.toLowerCase().includes(query));

    return (
      <div className="settings-field">
        <span>{label}</span>
        <div className="asmr-selected-picker">
          <div className="asmr-selected-chip-row">
            {selectedValues.length ? (
              selectedValues.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`asmr-selected-chip ${key === "voiceActors" ? "is-voice" : ""}`}
                  onClick={() => removeDraftValue(key, value)}
                  title={`移除${value}`}
                >
                  <span>{value}</span>
                  <X size={14} strokeWidth={1.9} />
                </button>
              ))
            ) : (
              <span className="asmr-selected-empty">未添加</span>
            )}
            <button
              type="button"
              className="asmr-picker-add-button"
              onClick={() => openMetadataPicker(key)}
              aria-label={`添加${label}`}
              title={`添加${label}`}
            >
              <Plus size={17} strokeWidth={2} />
            </button>
          </div>

          {activeMetadataPicker === key ? (
            <div className="asmr-picker-popover">
              <label className="asmr-picker-search">
                <Search size={15} strokeWidth={1.8} />
                <input
                  autoFocus
                  type="search"
                  placeholder={`搜索${label}`}
                  value={metadataPickerSearch}
                  onChange={(event) => setMetadataPickerSearch(event.target.value)}
                />
              </label>
              <div className="asmr-picker-option-list">
                {candidates.length ? (
                  candidates.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className="asmr-picker-option"
                      onClick={() => {
                        addDraftValue(key, value);
                        setMetadataPickerSearch("");
                      }}
                    >
                      <Plus size={15} strokeWidth={2} />
                      <span>{value}</span>
                    </button>
                  ))
                ) : (
                  <span className="asmr-picker-empty">没有可添加项</span>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  function metadataStringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : null;
  }

  function metadataStringList(value: unknown) {
    if (!Array.isArray(value)) return null;
    return Array.from(
      new Set(
        value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    );
  }

  function applyStructuredMetadata() {
    if (!metadataDraft) return;
    setStructuredMetadataStatus("");

    let parsed: StructuredMetadataInput;
    try {
      parsed = JSON.parse(structuredMetadataText) as StructuredMetadataInput;
    } catch (error) {
      setStructuredMetadataStatus(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setStructuredMetadataStatus("JSON 顶层必须是对象。");
      return;
    }

    const knownCircles = new Set(dictionaries.circles);
    const knownTags = new Set(dictionaries.tags);
    const knownVoiceActors = new Set(dictionaries.voiceActors);
    const skipped: string[] = [];
    const created = {
      circles: [] as string[],
      tags: [] as string[],
      voiceActors: [] as string[],
    };

    const nextDraft: MetadataDraft = { ...metadataDraft };
    if ("title" in parsed) {
      const title = metadataStringValue(parsed.title);
      if (title !== null) nextDraft.title = title;
    }
    if ("note" in parsed) {
      const note = metadataStringValue(parsed.note);
      if (note !== null) nextDraft.note = note;
    }
    if ("circle" in parsed) {
      const circle = metadataStringValue(parsed.circle);
      if (circle === "") {
        nextDraft.circle = "";
      } else if (circle) {
        if (knownCircles.has(circle) || structuredMetadataMode === "create") {
          nextDraft.circle = circle;
          if (!knownCircles.has(circle)) created.circles.push(circle);
        } else {
          skipped.push(`社团：${circle}`);
        }
      }
    }

    const tags = metadataStringList(parsed.tags);
    if (tags) {
      nextDraft.tags = tags.filter((tag) => {
        if (knownTags.has(tag)) return true;
        if (structuredMetadataMode === "create") {
          created.tags.push(tag);
          return true;
        }
        skipped.push(`标签：${tag}`);
        return false;
      });
    }

    const voiceActors = metadataStringList(parsed.voiceActors ?? parsed.voice_actors);
    if (voiceActors) {
      nextDraft.voiceActors = voiceActors.filter((voiceActor) => {
        if (knownVoiceActors.has(voiceActor)) return true;
        if (structuredMetadataMode === "create") {
          created.voiceActors.push(voiceActor);
          return true;
        }
        skipped.push(`声优：${voiceActor}`);
        return false;
      });
    }

    setMetadataDraft(nextDraft);
    if (structuredMetadataMode === "create") {
      setDictionaries((current) => ({
        circles: mergeDictionaryValues(current.circles, created.circles),
        tags: mergeDictionaryValues(current.tags, created.tags),
        voiceActors: mergeDictionaryValues(current.voiceActors, created.voiceActors),
      }));
    }

    const createdCount = created.circles.length + created.tags.length + created.voiceActors.length;
    const parts = ["已应用到当前表单"];
    if (createdCount) parts.push(`新增 ${createdCount} 项`);
    if (skipped.length) parts.push(`跳过 ${skipped.length} 项`);
    setStructuredMetadataStatus(parts.join("，") + "。");
  }

  async function saveMetadata() {
    if (!selectedWork || !metadataDraft) return;
    setErrorMessage("");
    try {
      const updated = await invoke<AsmrWork>("update_asmr_work", {
        input: {
          rjId: selectedWork.rjId,
          title: metadataDraft.title,
          circle: metadataDraft.circle,
          voiceActors: metadataDraft.voiceActors,
          tags: metadataDraft.tags,
          status: selectedWork.status,
          favorite: selectedWork.favorite,
          rating: selectedWork.rating,
          note: metadataDraft.note,
        },
      });
      setWorks((current) => current.map((work) => (work.rjId === updated.rjId ? updated : work)));
      setMetadataDraft(null);
      setActiveMetadataPicker(null);
      setMetadataPickerSearch("");
      setStructuredMetadataText("");
      setStructuredMetadataStatus("");
      void bootstrapAsmr();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function playItem(item: AsmrFileItem) {
    if (!selectedWork || item.kind !== "audio") return;
    setErrorMessage("");
    const startIndex = audioItems.findIndex((audioItem) => audioItem.relativePath === item.relativePath);
    if (startIndex < 0) return;
    const request: PlayerQueueRequest = {
      source: "dl_asmr",
      startIndex,
      tracks: audioItems.map((audioItem) => ({
        id: `${selectedWork.rjId}:${audioItem.relativePath}`,
        title: audioItem.name,
        workId: selectedWork.rjId,
        workTitle: selectedWork.title,
        absolutePath: audioItem.absolutePath,
        relativePath: audioItem.relativePath,
        subtitlePath: audioItem.subtitlePath,
      })),
    };
    try {
      const updated = await invoke<AsmrWork>("update_asmr_playback", {
        input: {
          rjId: selectedWork.rjId,
          audioPath: item.relativePath,
          positionMs: 0,
        },
      });
      setWorks((current) => current.map((work) => (work.rjId === updated.rjId ? updated : work)));
      // Queue handoff may immediately destroy this embedded page.
      await invoke("request_main_playback", { request });
    } catch (error) {
      setErrorMessage(`无法交给主程序播放：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  useEffect(() => {
    void bootstrapAsmr();
    const refreshFromDisk = () => void bootstrapAsmr();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refreshFromDisk();
    };
    window.addEventListener("focus", refreshFromDisk);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", refreshFromDisk);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [bootstrapAsmr]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  return (
    <div className="module-body asmr-module-body">
      <aside className="asmr-sidebar library-sidebar">
        <div className="side-h">
          <div className="side-t1">DL_ASMR</div>
          <div className="side-t2">DLsite 音声资料库</div>
        </div>

        <button type="button" className={`nav-item ${activeSection === "library" ? "active" : ""}`} onClick={() => selectSection("library")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="18" y2="20" /><line x1="6" y1="4" x2="6" y2="20" /><line x1="12" y1="10" x2="12" y2="20" /></svg>
          媒体库
        </button>
        <button type="button" className={`nav-item ${activeSection === "circles" ? "active" : ""}`} onClick={() => selectSection("circles")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 21v-4h6v4" /></svg>
          社团
        </button>
        <button type="button" className={`nav-item ${activeSection === "tags" ? "active" : ""}`} onClick={() => selectSection("tags")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="0.8" fill="currentColor" /></svg>
          标签
        </button>
        <button type="button" className={`nav-item ${activeSection === "voices" ? "active" : ""}`} onClick={() => selectSection("voices")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" /><path d="M19 10v1a7 7 0 0 1-14 0v-1" /><path d="M12 18v3" /></svg>
          声优
        </button>

        <div className="side-foot">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void importWork("copy")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            {busy ? "导入中..." : "复制导入"}
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void importWork("move")} title="同一磁盘中通常可以快速完成">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
            {busy ? "导入中..." : "移动导入"}
          </button>
        </div>
      </aside>

      <main className="asmr-main library-content">
        <div className="asmr-content-view">
          {view === "library" ? (
            <section className="asmr-library-panel">
              <div className="toolbar">
                <div className="tb-title">
                  {sectionLabel}
                  <span>{activeFilterLabel || "RJ 作品"}</span>
                </div>
                <label className="search">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                  <input
                    type="search"
                    placeholder={showingFilterList ? `搜索${sectionLabel}` : "搜索 RJ、标题、社团、标签"}
                    value={searchText}
                    onChange={(event) => {
                      setSearchText(event.target.value);
                      setPage(1);
                    }}
                  />
                </label>
                <label className="perpage">
                  每页
                  <select
                    className="select"
                    value={pageSize}
                    onChange={(event) => {
                      setPageSize(Number(event.target.value));
                      setPage(1);
                    }}
                  >
                    <option value={8}>8</option>
                    <option value={12}>12</option>
                    <option value={20}>20</option>
                  </select>
                </label>
                <div className="spacer" />
                <div className="tb-btns">
                  <button type="button" className="btn ghost" disabled={!libraryPath} onClick={() => void openInExplorer(libraryPath)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                    打开资源目录
                  </button>
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => void bootstrapAsmr()}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3.5-7" /><polyline points="21 3 21 9 15 9" /></svg>
                    刷新
                  </button>
                  {activeFilter ? (
                    <button type="button" className="btn ghost" onClick={() => setActiveFilter(null)}>
                      返回{sectionLabel}
                    </button>
                  ) : null}
                  {showingFilterList ? (
                    <button type="button" className="btn primary" onClick={() => void upsertDictionaryValue(activeSection as Exclude<AsmrSection, "library">)}>
                      新增{sectionLabel}
                    </button>
                  ) : null}
                </div>
              </div>

              {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

              <div className="grid-wrap nice-scroll">
                {showingFilterList ? (
                  visibleFilterEntries.length ? (
                    <div className="meta-list">
                      {visibleFilterEntries.map((entry) => (
                      <div
                        key={entry.value}
                        className="meta-row"
                        onClick={() => selectFilter(activeSection as Exclude<AsmrSection, "library">, entry.value)}
                      >
                        <span className="meta-name">{entry.value}</span>
                        <span className="meta-count">{entry.count}</span>
                        <span className="meta-actions">
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              void upsertDictionaryValue(activeSection as Exclude<AsmrSection, "library">, entry.value);
                            }}
                          >
                            重命名
                          </button>
                          <button
                            type="button"
                            className="btn danger-ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              void deleteDictionaryValue(activeSection as Exclude<AsmrSection, "library">, entry.value);
                            }}
                          >
                            删除
                          </button>
                        </span>
                      </div>
                      ))}
                    </div>
                  ) : (
                    <div className="grid-empty">没有匹配的条目</div>
                  )
                ) : visibleWorks.length ? (
                  <div className="work-grid">
                    {visibleWorks.map((work) => (
                    <button
                      key={work.rjId}
                      type="button"
                      className={`work-card ${work.rjId === selectedWorkId ? "selected" : ""}`}
                      onClick={() => openWork(work.rjId)}
                    >
                      <span className="w-cover" style={{ ["--h" as string]: workCoverHue(work.rjId) }}>
                        {work.coverPath ? <img src={convertFileSrc(work.coverPath)} alt="" /> : null}
                        <span className="w-rj">{work.rjId}</span>
                      </span>
                      <span className="w-info">
                        <span className="w-title">{work.title || work.rjId}</span>
                        <span className="w-circle">{work.circle || "社团未指定"}</span>
                        <span className="w-loc">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                          本地资源
                        </span>
                        <span className="w-tags">
                          {work.tags.slice(0, 4).map((tag) => (
                            <span key={tag} className="w-tag">{tag}</span>
                          ))}
                        </span>
                      </span>
                    </button>
                    ))}
                  </div>
                ) : (
                  <div className="grid-empty">没有匹配的条目</div>
                )}
              </div>

              <div className="pager">
                <button type="button" className="pg-btn" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
                  上一页
                </button>
                <span className="pg-info">{page} / {pageCount}</span>
                <button type="button" className="pg-btn" disabled={page === pageCount} onClick={() => setPage((current) => current + 1)}>
                  下一页
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
                </button>
              </div>
            </section>
          ) : (
            <section className="asmr-detail-view">
              <div className="asmr-detail-header">
                <button type="button" className="soft-button" onClick={() => setView("library")}>
                  <ChevronLeft size={17} strokeWidth={1.8} />
                  <span>返回媒体库</span>
                </button>
              </div>

              {selectedWork ? (
                <>
                  <section className="asmr-work-strip">
                    <div className="asmr-cover-placeholder">
                      {selectedWork.coverPath ? <img src={convertFileSrc(selectedWork.coverPath)} alt="" /> : <span>RJ</span>}
                    </div>
                    <div className="asmr-work-copy">
                      <span className="section-label">{selectedWork.rjId}</span>
                      <h2 title={selectedWork.title || selectedWork.rjId}>{selectedWork.title || selectedWork.rjId}</h2>
                      <div className="asmr-work-meta">
                        <span>{selectedWork.circle || "社团未指定"}</span>
                        <span>{selectedWork.coverPath ? "已设置作品内封面" : "尚未设置封面"}</span>
                      </div>
                      <div className="asmr-chip-row">
                        {selectedWork.tags.map((tag) => (
                          <span key={tag} className="asmr-chip">
                            {tag}
                          </span>
                        ))}
                        {selectedWork.voiceActors.map((voice) => (
                          <span key={voice} className="asmr-chip is-voice">
                            {voice}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="asmr-work-actions">
                      <button type="button" className="soft-button" onClick={() => void openInExplorer(selectedWork.workDir)}>
                        <FolderOpen size={16} strokeWidth={1.8} />
                        在资源管理器中打开
                      </button>
                      <button type="button" className="soft-button" onClick={() => startMetadataEdit(selectedWork)}>
                        编辑信息
                      </button>
                    </div>
                  </section>

                  <section className="asmr-file-panel">
                    <div className="asmr-file-toolbar">
                      <div className="asmr-breadcrumb">
                        <button type="button" onClick={() => void loadFolder(selectedWork.rjId, "")}>works</button>
                        <ChevronRight size={15} />
                        <span>{selectedWork.rjId}</span>
                        {folderPath ? (
                          <>
                            <ChevronRight size={15} />
                            <strong title={folderPath}>{folderPath}</strong>
                          </>
                        ) : null}
                      </div>
                      <div className="asmr-file-toolbar-actions">
                        {selectedCoverPath ? <span title={selectedCoverPath}>已选择图片</span> : <span>先选择一张图片</span>}
                        <button
                          type="button"
                          className="soft-button"
                          disabled={busy || !selectedCoverPath}
                          onClick={() => void setCover(selectedWork, selectedCoverPath)}
                        >
                          设置封面
                        </button>
                      </div>
                    </div>

                    {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

                    <div className="asmr-file-list">
                      {folderPath ? (
                        <button
                          type="button"
                          className="asmr-file-row is-folder"
                          onClick={() => void loadFolder(selectedWork.rjId, parentFolderPath(folderPath))}
                        >
                          <span className="asmr-file-icon">
                            <Folder size={26} fill="currentColor" strokeWidth={1.75} />
                          </span>
                          <span className="asmr-file-copy">
                            <strong>..</strong>
                            <small>返回上级目录</small>
                          </span>
                        </button>
                      ) : null}

                      {folderItems.map((file) => (
                        <button
                          key={file.relativePath}
                          type="button"
                          className={`asmr-file-row is-${file.kind} ${selectedCoverPath === file.relativePath ? "is-selected" : ""}`}
                          onClick={() => {
                            if (file.kind === "folder") {
                              void loadFolder(selectedWork.rjId, file.relativePath);
                            } else if (file.kind === "audio") {
                              void playItem(file);
                            } else if (file.kind === "image") {
                              setSelectedCoverPath(file.relativePath);
                            }
                          }}
                        >
                          <span className="asmr-file-icon">
                            <FileIcon kind={file.kind} />
                          </span>
                          <span className="asmr-file-copy">
                            <strong title={file.name}>{file.name}</strong>
                            <small>{fileKindLabel(file)}</small>
                          </span>
                          {file.kind === "audio" ? <Play size={18} strokeWidth={1.85} /> : null}
                          {file.kind === "image" && selectedCoverPath === file.relativePath ? <Check size={18} strokeWidth={2} /> : null}
                        </button>
                      ))}
                    </div>
                  </section>
                </>
              ) : null}
            </section>
          )}
        </div>

        {metadataDraft && selectedWork ? (
          <div className="inline-modal-backdrop">
            <section className="asmr-metadata-modal">
              <div className="inline-modal-header">
                <h3>编辑作品信息</h3>
              </div>
              <label className="settings-field">
                <span>标题</span>
                <input
                  type="text"
                  value={metadataDraft.title}
                  onChange={(event) => setMetadataDraft((current) => current && { ...current, title: event.target.value })}
                />
              </label>
              <label className="settings-field">
                <span>社团</span>
                <select
                  value={metadataDraft.circle}
                  onChange={(event) => setMetadataDraft((current) => current && { ...current, circle: event.target.value })}
                >
                  <option value="">未指定</option>
                  {dictionaries.circles.map((circle) => (
                    <option key={circle} value={circle}>
                      {circle}
                    </option>
                  ))}
                </select>
              </label>
              {renderMetadataValueEditor("标签", "tags", metadataDraft.tags, dictionaries.tags)}
              {renderMetadataValueEditor("声优", "voiceActors", metadataDraft.voiceActors, dictionaries.voiceActors)}
              <label className="settings-field">
                <span>备注</span>
                <textarea
                  value={metadataDraft.note}
                  onChange={(event) => setMetadataDraft((current) => current && { ...current, note: event.target.value })}
                />
              </label>
              <section className="asmr-structured-import">
                <div className="asmr-structured-import-header">
                  <span>Structured metadata import</span>
                  <label>
                    <select
                      value={structuredMetadataMode}
                      onChange={(event) => setStructuredMetadataMode(event.target.value as StructuredMetadataMode)}
                    >
                      <option value="skip">不存在自动跳过</option>
                      <option value="create">不存在自动新建</option>
                    </select>
                  </label>
                </div>
                <textarea
                  value={structuredMetadataText}
                  onChange={(event) => {
                    setStructuredMetadataText(event.target.value);
                    setStructuredMetadataStatus("");
                  }}
                  placeholder={`{\n  "title": "作品标题",\n  "circle": "社团名",\n  "tags": ["标签A", "标签B"],\n  "voiceActors": ["声优A", "声优B"],\n  "note": "备注"\n}`}
                  spellCheck={false}
                />
                <div className="asmr-structured-import-footer">
                  <button type="button" className="soft-button" onClick={applyStructuredMetadata}>
                    应用到表单
                  </button>
                  {structuredMetadataStatus ? <span>{structuredMetadataStatus}</span> : null}
                </div>
              </section>
              <div className="inline-modal-actions">
                <button
                  type="button"
                  className="soft-button"
                  onClick={() => {
                    setMetadataDraft(null);
                    setActiveMetadataPicker(null);
                    setMetadataPickerSearch("");
                    setStructuredMetadataText("");
                    setStructuredMetadataStatus("");
                  }}
                >
                  取消
                </button>
                <button type="button" className="soft-button" onClick={() => void saveMetadata()}>
                  保存
                </button>
              </div>
            </section>
          </div>
        ) : null}

      </main>
    </div>
  );
}
