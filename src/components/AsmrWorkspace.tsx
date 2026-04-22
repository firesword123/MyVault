import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileAudio2,
  FileText,
  Folder,
  Library,
  LocateFixed,
  Mic2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  SkipBack,
  SkipForward,
  Tags,
  Volume2,
} from "lucide-react";
import type {
  AsmrBootstrapPayload,
  AsmrDictionaries,
  AsmrFileItem,
  AsmrFolderPayload,
  AsmrImportPreview,
  AsmrWork,
} from "../types";

type AsmrNavItem = {
  id: string;
  label: string;
  icon: typeof Library;
};

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

type PlayingTrack = {
  workId: string;
  item: AsmrFileItem;
};

type SubtitleLine = {
  start: number;
  end: number;
  text: string;
};

const navItems: AsmrNavItem[] = [
  { id: "library", label: "媒体库", icon: Library },
  { id: "circles", label: "社团", icon: Building2 },
  { id: "tags", label: "标签", icon: Tags },
  { id: "voices", label: "声优", icon: Mic2 },
];

function FileIcon({ kind }: { kind: AsmrFileItem["kind"] }) {
  if (kind === "folder") return <Folder size={26} fill="currentColor" strokeWidth={1.75} />;
  if (kind === "subtitle") return <FileText size={25} strokeWidth={1.75} />;
  return <FileAudio2 size={25} strokeWidth={1.75} />;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "00:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`;
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

function subtitleRelativePath(audioItem: AsmrFileItem) {
  if (!audioItem.subtitlePath) return null;
  const normalized = audioItem.subtitlePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.includes(":/")) return normalized;
  const folder = parentFolderPath(audioItem.relativePath);
  const name = normalized.split("/").pop();
  if (!name) return null;
  return folder ? `${folder}/${name}` : name;
}

function parseSubtitleTime(value: string) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length === 2) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    return minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  return 0;
}

function parseSubtitles(raw: string): SubtitleLine[] {
  const assLines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith("dialogue:"))
    .map((line) => {
      const payload = line.slice(line.indexOf(":") + 1).trim();
      const parts = payload.split(",");
      if (parts.length < 10) return null;
      const text = parts
        .slice(9)
        .join(",")
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\N/g, "\n")
        .replace(/\\h/g, " ")
        .trim();
      if (!text) return null;
      return {
        start: parseSubtitleTime(parts[1]),
        end: parseSubtitleTime(parts[2]),
        text,
      };
    })
    .filter((line): line is SubtitleLine => Boolean(line));
  if (assLines.length) return assLines.sort((left, right) => left.start - right.start);

  const blocks = raw
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const lines: SubtitleLine[] = [];
  for (const block of blocks) {
    const rows = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeIndex = rows.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [startRaw, endRaw] = rows[timeIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const text = rows.slice(timeIndex + 1).join("\n").trim();
    if (!text) continue;
    lines.push({
      start: parseSubtitleTime(startRaw),
      end: parseSubtitleTime(endRaw),
      text,
    });
  }

  if (lines.length) return lines.sort((left, right) => left.start - right.start);

  return raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^\[(\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\](.+)$/);
      if (!match) return null;
      const start = parseSubtitleTime(match[1]);
      return { start, end: start + 4, text: match[2].trim() };
    })
    .filter((line): line is SubtitleLine => Boolean(line))
    .sort((left, right) => left.start - right.start);
}

export function AsmrWorkspace() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const subtitlePanelRef = useRef<HTMLDivElement | null>(null);
  const activeSubtitleRef = useRef<HTMLButtonElement | null>(null);
  const lastPlaybackSaveRef = useRef<{ key: string; positionMs: number }>({ key: "", positionMs: -1 });
  const [view, setView] = useState<"library" | "detail">("library");
  const [activeSection, setActiveSection] = useState<AsmrSection>("library");
  const [activeFilter, setActiveFilter] = useState<AsmrFilter | null>(null);
  const [works, setWorks] = useState<AsmrWork[]>([]);
  const [dictionaries, setDictionaries] = useState<AsmrDictionaries>({
    tags: [],
    voiceActors: [],
    circles: [],
  });
  const [selectedWorkId, setSelectedWorkId] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [folderItems, setFolderItems] = useState<AsmrFileItem[]>([]);
  const [playingTrack, setPlayingTrack] = useState<PlayingTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioPosition, setAudioPosition] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [volume, setVolume] = useState(0.72);
  const [playerExpanded, setPlayerExpanded] = useState(false);
  const [autoScrollSubtitles, setAutoScrollSubtitles] = useState(true);
  const [subtitles, setSubtitles] = useState<SubtitleLine[]>([]);
  const [subtitleError, setSubtitleError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(8);
  const [searchText, setSearchText] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [metadataDraft, setMetadataDraft] = useState<MetadataDraft | null>(null);

  const selectedWork = works.find((work) => work.rjId === selectedWorkId) ?? works[0] ?? null;
  const playingWork = works.find((work) => work.rjId === playingTrack?.workId) ?? selectedWork;
  const audioItems = folderItems.filter((item) => item.kind === "audio");
  const audioSrc = playingTrack ? convertFileSrc(playingTrack.item.absolutePath) : "";
  const activeSubtitleIndex = subtitles.reduce((activeIndex, line, index) => {
    return audioPosition >= line.start ? index : activeIndex;
  }, -1);

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

  const pageCount = Math.max(1, Math.ceil(filteredWorks.length / pageSize));
  const visibleWorks = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredWorks.slice(start, start + pageSize);
  }, [filteredWorks, page, pageSize]);

  async function bootstrapAsmr() {
    setErrorMessage("");
    try {
      const payload = await invoke<AsmrBootstrapPayload>("bootstrap_asmr");
      setWorks(payload.works);
      setDictionaries(payload.dictionaries);
      if (!selectedWorkId && payload.works[0]) {
        setSelectedWorkId(payload.works[0].rjId);
      }
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
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setFolderPath(nextFolderPath);
      setFolderItems([]);
    }
  }

  async function importWork() {
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
      const overwrite = preview.alreadyExists
        ? window.confirm(
            `${preview.rjId} 已存在，是否覆盖导入？\n\n文件 ${preview.fileCount} 个，文件夹 ${preview.folderCount} 个\n音频 ${preview.audioCount} 个，字幕 ${preview.subtitleCount} 个，已关联字幕 ${preview.associatedSubtitleCount} 个\n图片 ${preview.imageCount} 个，其他 ${preview.otherCount} 个\n总大小 ${formatBytes(preview.totalSize)}`,
          )
        : window.confirm(
            `确认导入 ${preview.rjId}？\n\n文件 ${preview.fileCount} 个，文件夹 ${preview.folderCount} 个\n音频 ${preview.audioCount} 个，字幕 ${preview.subtitleCount} 个，已关联字幕 ${preview.associatedSubtitleCount} 个\n图片 ${preview.imageCount} 个，其他 ${preview.otherCount} 个\n总大小 ${formatBytes(preview.totalSize)}`,
          );
      if (!overwrite) return;
      const work = await invoke<AsmrWork>("import_asmr_work", {
        input: {
          sourcePath: selected,
          rjId: preview.rjId,
          overwrite: preview.alreadyExists,
        },
      });
      await bootstrapAsmr();
      openWork(work.rjId, work.lastOpenedFolder ?? "");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function setCover(work: AsmrWork) {
    setBusy(true);
    setErrorMessage("");
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
      });
      if (typeof selected !== "string") return;
      const updated = await invoke<AsmrWork>("set_asmr_cover", {
        input: {
          rjId: work.rjId,
          sourcePath: selected,
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
  }

  function toggleDraftValue(key: "tags" | "voiceActors", value: string) {
    setMetadataDraft((current) => {
      if (!current) return current;
      const values = current[key];
      return {
        ...current,
        [key]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value],
      };
    });
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
      void bootstrapAsmr();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function persistPlayback(track: PlayingTrack | null, seconds: number, force = false) {
    if (!track) return;
    const positionMs = Math.max(0, Math.floor(seconds * 1000));
    const key = `${track.workId}:${track.item.relativePath}`;
    const previous = lastPlaybackSaveRef.current;
    if (!force && previous.key === key && Math.abs(positionMs - previous.positionMs) < 5000) {
      return;
    }
    lastPlaybackSaveRef.current = { key, positionMs };
    void invoke<AsmrWork>("update_asmr_playback", {
      input: {
        rjId: track.workId,
        audioPath: track.item.relativePath,
        positionMs,
      },
    }).then(
      (updated) => setWorks((current) => current.map((work) => (work.rjId === updated.rjId ? updated : work))),
      () => {},
    );
  }

  function playItem(item: AsmrFileItem) {
    if (!selectedWork || item.kind !== "audio") return;
    setErrorMessage("");
    if (playingTrack) {
      persistPlayback(playingTrack, audioRef.current?.currentTime ?? audioPosition, true);
    }
    const resumeSeconds =
      selectedWork.lastPlayedAudioPath === item.relativePath ? Math.floor(selectedWork.lastPositionMs / 1000) : 0;
    const nextTrack = { workId: selectedWork.rjId, item };
    setPlayingTrack(nextTrack);
    setIsPlaying(true);
    setAudioPosition(resumeSeconds);
    persistPlayback(nextTrack, resumeSeconds, true);
  }

  function playAdjacent(offset: number) {
    if (!playingTrack) return;
    const index = audioItems.findIndex((item) => item.relativePath === playingTrack.item.relativePath);
    const next = audioItems[index + offset];
    if (next) {
      playItem(next);
    }
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !audioSrc) return;
    if (audio.paused) {
      void audio.play().catch((error) => {
        setIsPlaying(false);
        setErrorMessage(`播放失败：${error instanceof Error ? error.message : String(error)}`);
      });
      setIsPlaying(true);
    } else {
      persistPlayback(playingTrack, audio.currentTime, true);
      audio.pause();
      setIsPlaying(false);
    }
  }

  function seekTo(seconds: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(seconds, audioDuration || seconds));
    setAudioPosition(audio.currentTime);
    persistPlayback(playingTrack, audio.currentTime, true);
  }

  function nudge(seconds: number) {
    seekTo(audioPosition + seconds);
  }

  function scrollActiveSubtitle() {
    activeSubtitleRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  useEffect(() => {
    void bootstrapAsmr();
  }, []);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  useEffect(() => {
    if (!audioRef.current || !audioSrc || !isPlaying) return;
    audioRef.current.load();
    audioRef.current.currentTime = audioPosition;
    void audioRef.current.play().catch((error) => {
      setIsPlaying(false);
      setErrorMessage(`播放失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, [audioSrc, isPlaying]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    setSubtitles([]);
    setSubtitleError("");
    setAutoScrollSubtitles(true);
    if (!playingTrack?.item.subtitlePath) return;
    const relativePath = subtitleRelativePath(playingTrack.item);
    if (!relativePath) return;
    void invoke<string>("read_asmr_text_file", {
      input: {
        rjId: playingTrack.workId,
        relativePath,
      },
    }).then(
      (raw) => setSubtitles(parseSubtitles(raw)),
      (error) => setSubtitleError(error instanceof Error ? error.message : String(error)),
    );
  }, [playingTrack]);

  useEffect(() => {
    if (!playerExpanded || !autoScrollSubtitles || activeSubtitleIndex < 0) return;
    scrollActiveSubtitle();
  }, [activeSubtitleIndex, autoScrollSubtitles, playerExpanded]);

  return (
    <div className="module-body asmr-module-body">
      <aside className="asmr-sidebar">
        <div className="asmr-sidebar-header">
          <span className="section-label">ASMR</span>
          <h1>音声资料库</h1>
        </div>

        <div className="asmr-nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`asmr-nav-item ${activeSection === item.id ? "is-active" : ""}`}
                onClick={() => selectSection(item.id as AsmrSection)}
              >
                <Icon size={20} strokeWidth={1.9} />
                <span>
                  <strong>{item.label}</strong>
                </span>
              </button>
            );
          })}
        </div>

        <button type="button" className="asmr-import-button" disabled={busy} onClick={() => void importWork()}>
          <Plus size={18} strokeWidth={1.9} />
          <span>{busy ? "导入中..." : "导入 RJ 作品"}</span>
        </button>
      </aside>

      <main className="asmr-main">
        <div className="asmr-content-view">
          {view === "library" ? (
            <section className="asmr-library-panel">
              <div className="asmr-library-toolbar">
                <div>
                  <span className="section-label">{sectionLabel}</span>
                  <h2>{activeFilterLabel || "RJ 作品"}</h2>
                </div>
                <label className="asmr-search">
                  <Search size={16} strokeWidth={1.8} />
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
                <label className="asmr-page-size">
                  <span>每页</span>
                  <select
                    value={pageSize}
                    onChange={(event) => {
                      setPageSize(Number(event.target.value));
                      setPage(1);
                    }}
                  >
                    <option value={8}>8</option>
                    <option value={12}>12</option>
                    <option value={16}>16</option>
                  </select>
                </label>
                {activeFilter ? (
                  <button type="button" className="soft-button" onClick={() => setActiveFilter(null)}>
                    返回{sectionLabel}
                  </button>
                ) : null}
                {showingFilterList ? (
                  <button
                    type="button"
                    className="soft-button"
                    onClick={() => void upsertDictionaryValue(activeSection as Exclude<AsmrSection, "library">)}
                  >
                    新增{sectionLabel}
                  </button>
                ) : null}
              </div>

              {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

              {showingFilterList ? (
                filterEntries.length ? (
                  <div className="asmr-filter-grid">
                    {filterEntries.map((entry) => (
                      <div
                        key={entry.value}
                        className="asmr-filter-row"
                        onClick={() => selectFilter(activeSection as Exclude<AsmrSection, "library">, entry.value)}
                      >
                        <span>{entry.value}</span>
                        <strong>{entry.count}</strong>
                        <span className="asmr-filter-actions">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void upsertDictionaryValue(activeSection as Exclude<AsmrSection, "library">, entry.value);
                            }}
                          >
                            重命名
                          </button>
                          <button
                            type="button"
                            className="is-danger"
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
                  <div className="empty-editor">
                    <h3>暂无{sectionLabel}</h3>
                    <p>给作品填写{sectionLabel}后会在这里出现。</p>
                  </div>
                )
              ) : visibleWorks.length ? (
                <div className="asmr-work-grid">
                  {visibleWorks.map((work) => (
                    <button
                      key={work.rjId}
                      type="button"
                      className={`asmr-work-card ${work.rjId === selectedWorkId ? "is-selected" : ""}`}
                      onClick={() => openWork(work.rjId)}
                    >
                      <span className="asmr-work-cover">
                        {work.thumbnailPath ? <img src={convertFileSrc(work.thumbnailPath)} alt="" /> : null}
                        <strong>{work.rjId}</strong>
                      </span>
                      <span className="asmr-work-card-body">
                        <strong>{work.title || work.rjId}</strong>
                        <span>{work.circle || "社团未指定"}</span>
                        <span className="asmr-work-card-meta">
                          <Clock3 size={14} strokeWidth={1.8} />
                          本地资源
                        </span>
                        <span className="asmr-card-chip-row">
                          {work.tags.slice(0, 4).map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                          {work.voiceActors.slice(0, 2).map((voice) => (
                            <span key={voice} className="is-voice">
                              {voice}
                            </span>
                          ))}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-editor">
                  <h3>暂无 RJ 作品</h3>
                  <p>导入一个本地作品目录后，MyVault 会复制资源并写入本地索引。</p>
                </div>
              )}

              {!showingFilterList ? (
                <div className="asmr-library-pagination">
                  <button type="button" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>
                    <ChevronLeft size={17} strokeWidth={1.8} />
                    <span>上一页</span>
                  </button>
                  <span>
                    {page} / {pageCount}
                  </span>
                  <button type="button" disabled={page === pageCount} onClick={() => setPage((current) => current + 1)}>
                    <span>下一页</span>
                    <ChevronRight size={17} strokeWidth={1.8} />
                  </button>
                </div>
              ) : null}
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
                      {selectedWork.thumbnailPath ? <img src={convertFileSrc(selectedWork.thumbnailPath)} alt="" /> : <span>RJ</span>}
                    </div>
                    <div className="asmr-work-copy">
                      <span className="section-label">{selectedWork.rjId}</span>
                      <h2>{selectedWork.title || selectedWork.rjId}</h2>
                      <div className="asmr-work-meta">
                        <span>{selectedWork.circle || "社团未指定"}</span>
                        <span>封面手动指定</span>
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
                      <button type="button" className="soft-button" disabled={busy} onClick={() => void setCover(selectedWork)}>
                        指定封面
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
                            <strong>{folderPath}</strong>
                          </>
                        ) : null}
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
                          className={`asmr-file-row is-${file.kind} ${
                            file.relativePath === playingTrack?.item.relativePath ? "is-selected" : ""
                          }`}
                          onClick={() => {
                            if (file.kind === "folder") {
                              void loadFolder(selectedWork.rjId, file.relativePath);
                            } else if (file.kind === "audio") {
                              playItem(file);
                            }
                          }}
                        >
                          <span className="asmr-file-icon">
                            <FileIcon kind={file.kind} />
                          </span>
                          <span className="asmr-file-copy">
                            <strong>{file.name}</strong>
                            <small>{file.kind === "audio" && file.subtitlePath ? "同名字幕已关联" : file.kind}</small>
                          </span>
                          {file.kind === "audio" ? <Play size={18} strokeWidth={1.85} /> : null}
                        </button>
                      ))}
                    </div>
                  </section>
                </>
              ) : null}
            </section>
          )}
        </div>

        <section className="asmr-player">
          <button type="button" className="asmr-player-track" onClick={() => playingTrack && setPlayerExpanded(true)} disabled={!playingTrack}>
            <span className="section-label">正在播放：{playingWork?.rjId ?? "未选择"}</span>
            <strong>{playingTrack ? playingTrack.item.name : "尚未播放音频"}</strong>
          </button>
          <div className="asmr-player-controls">
            <button type="button" aria-label="上一首" title="上一首" onClick={() => playAdjacent(-1)}>
              <SkipBack size={18} strokeWidth={1.8} />
            </button>
            <button type="button" className="is-primary" aria-label="播放/暂停" title="播放/暂停" onClick={togglePlayback}>
              {isPlaying ? <Pause size={19} strokeWidth={1.8} /> : <Play size={21} fill="currentColor" strokeWidth={1.8} />}
            </button>
            <button type="button" aria-label="下一首" title="下一首" onClick={() => playAdjacent(1)}>
              <SkipForward size={18} strokeWidth={1.8} />
            </button>
          </div>
          <audio
            ref={audioRef}
            src={audioSrc}
            onPlay={() => setIsPlaying(true)}
            onPause={(event) => {
              persistPlayback(playingTrack, event.currentTarget.currentTime, true);
              setIsPlaying(false);
            }}
            onLoadedMetadata={(event) => setAudioDuration(event.currentTarget.duration)}
            onTimeUpdate={(event) => {
              setAudioPosition(event.currentTarget.currentTime);
              persistPlayback(playingTrack, event.currentTarget.currentTime);
            }}
            onEnded={() => playAdjacent(1)}
            onError={() => setErrorMessage("播放失败：当前音频无法加载，可能是格式不受 WebView 支持或资源访问被阻止。")}
          />
        </section>

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
              <div className="settings-field">
                <span>标签</span>
                <div className="asmr-picker-grid">
                  {dictionaries.tags.map((tag) => (
                    <label key={tag}>
                      <input
                        type="checkbox"
                        checked={metadataDraft.tags.includes(tag)}
                        onChange={() => toggleDraftValue("tags", tag)}
                      />
                      <span>{tag}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="settings-field">
                <span>声优</span>
                <div className="asmr-picker-grid">
                  {dictionaries.voiceActors.map((voiceActor) => (
                    <label key={voiceActor}>
                      <input
                        type="checkbox"
                        checked={metadataDraft.voiceActors.includes(voiceActor)}
                        onChange={() => toggleDraftValue("voiceActors", voiceActor)}
                      />
                      <span>{voiceActor}</span>
                    </label>
                  ))}
                </div>
              </div>
              <label className="settings-field">
                <span>备注</span>
                <textarea
                  value={metadataDraft.note}
                  onChange={(event) => setMetadataDraft((current) => current && { ...current, note: event.target.value })}
                />
              </label>
              <div className="inline-modal-actions">
                <button type="button" className="soft-button" onClick={() => setMetadataDraft(null)}>
                  取消
                </button>
                <button type="button" className="soft-button" onClick={() => void saveMetadata()}>
                  保存
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {playerExpanded ? (
          <aside className="asmr-player-panel">
            <button
              type="button"
              className="asmr-player-panel-handle"
              aria-label="收起播放器"
              title="收起播放器"
              onClick={() => setPlayerExpanded(false)}
            >
              <span />
            </button>
            <div className="asmr-player-panel-header">
              <div>
                <h3>{playingTrack?.item.name ?? "尚未播放音频"}</h3>
              </div>
              <button
                type="button"
                aria-label="定位当前字幕"
                title="定位当前字幕"
                onClick={() => {
                  setAutoScrollSubtitles(true);
                  window.requestAnimationFrame(scrollActiveSubtitle);
                }}
              >
                <LocateFixed size={22} strokeWidth={1.8} />
              </button>
            </div>

            <div
              ref={subtitlePanelRef}
              className="asmr-subtitle-panel"
              onWheel={() => setAutoScrollSubtitles(false)}
              onPointerDown={() => setAutoScrollSubtitles(false)}
            >
              {subtitles.length ? (
                subtitles.map((line, index) => (
                  <button
                    key={`${line.start}-${index}`}
                    ref={index === activeSubtitleIndex ? activeSubtitleRef : null}
                    type="button"
                    className={`asmr-subtitle-line ${index === activeSubtitleIndex ? "is-active" : ""}`}
                    onClick={() => seekTo(line.start)}
                  >
                    <span>[{formatDuration(line.start)}]</span>
                    <strong>{line.text}</strong>
                  </button>
                ))
              ) : (
                <div className="asmr-subtitle-empty">
                  {subtitleError ? `字幕读取失败：${subtitleError}` : "当前音频没有可显示的字幕。"}
                </div>
              )}
            </div>

            <div className="asmr-expanded-progress">
              <input
                type="range"
                min={0}
                max={audioDuration || 0}
                step={0.1}
                value={Math.min(audioPosition, audioDuration || audioPosition)}
                onChange={(event) => seekTo(Number(event.target.value))}
              />
              <div>
                <span>{formatDuration(audioPosition)}</span>
                <span>{formatDuration(audioDuration)}</span>
              </div>
            </div>

            <div className="asmr-expanded-controls">
              <button type="button" aria-label="上一首" title="上一首" onClick={() => playAdjacent(-1)}>
                <SkipBack size={21} strokeWidth={1.8} />
              </button>
              <button type="button" aria-label="快退 5 秒" title="快退 5 秒" onClick={() => nudge(-5)}>
                <RotateCcw size={21} strokeWidth={1.8} />
                <span>5</span>
              </button>
              <button type="button" className="is-primary" aria-label="播放/暂停" title="播放/暂停" onClick={togglePlayback}>
                {isPlaying ? <Pause size={28} strokeWidth={1.8} /> : <Play size={30} fill="currentColor" strokeWidth={1.8} />}
              </button>
              <button type="button" aria-label="快进 30 秒" title="快进 30 秒" onClick={() => nudge(30)}>
                <RotateCw size={21} strokeWidth={1.8} />
                <span>30</span>
              </button>
              <button type="button" aria-label="下一首" title="下一首" onClick={() => playAdjacent(1)}>
                <SkipForward size={21} strokeWidth={1.8} />
              </button>
            </div>

            <label className="asmr-volume-row">
              <Volume2 size={19} strokeWidth={1.8} />
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
              <span>{Math.round(volume * 100)}%</span>
            </label>
          </aside>
        ) : null}
      </main>
    </div>
  );
}
