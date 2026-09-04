import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  ListMusic,
  LocateFixed,
  Music2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Trash2,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerQueueRequest } from "../types";

type PlayerWorkspaceProps = {
  active: boolean;
  onBack: () => void;
};

type SubtitleLine = {
  start: number;
  end: number;
  text: string;
};

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function parseSubtitleTime(value: string) {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function parseSubtitles(raw: string): SubtitleLine[] {
  const assLines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith("dialogue:"))
    .map((line) => {
      const parts = line.slice(line.indexOf(":") + 1).trim().split(",");
      if (parts.length < 10) return null;
      const text = parts
        .slice(9)
        .join(",")
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\N/g, "\n")
        .replace(/\\h/g, " ")
        .trim();
      if (!text) return null;
      return { start: parseSubtitleTime(parts[1]), end: parseSubtitleTime(parts[2]), text };
    })
    .filter((line): line is SubtitleLine => Boolean(line));
  if (assLines.length) return assLines.sort((left, right) => left.start - right.start);

  const timedLines: SubtitleLine[] = [];
  for (const block of raw.replace(/\r/g, "").split(/\n\s*\n/)) {
    const rows = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeIndex = rows.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [startRaw, endRaw] = rows[timeIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const text = rows.slice(timeIndex + 1).join("\n").trim();
    if (text) timedLines.push({ start: parseSubtitleTime(startRaw), end: parseSubtitleTime(endRaw), text });
  }
  if (timedLines.length) return timedLines.sort((left, right) => left.start - right.start);

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

export function PlayerWorkspace({ active, onBack }: PlayerWorkspaceProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeSubtitleRef = useRef<HTMLButtonElement | null>(null);
  const shouldAutoplayRef = useRef(false);
  const [queue, setQueue] = useState<PlayerQueueRequest["tracks"]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playbackRevision, setPlaybackRevision] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.72);
  const [subtitles, setSubtitles] = useState<SubtitleLine[]>([]);
  const [subtitleError, setSubtitleError] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const currentTrack = queue[currentIndex] ?? null;

  const activeSubtitleIndex = useMemo(
    () => subtitles.reduce((last, line, index) => (position >= line.start ? index : last), -1),
    [position, subtitles],
  );

  function releaseMedia() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  function applyQueue(payload: PlayerQueueRequest) {
    if (!payload.tracks.length) return;
    shouldAutoplayRef.current = true;
    setQueue(payload.tracks);
    setCurrentIndex(Math.min(Math.max(payload.startIndex, 0), payload.tracks.length - 1));
    setPlaybackRevision((current) => current + 1);
    setErrorMessage("");
  }

  function playAt(index: number) {
    if (index < 0 || index >= queue.length) return;
    shouldAutoplayRef.current = true;
    if (index === currentIndex && currentTrack) {
      void audioRef.current?.play().catch((error) => {
        setIsPlaying(false);
        setErrorMessage(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    setCurrentIndex(index);
    setPlaybackRevision((current) => current + 1);
    setErrorMessage("");
  }

  function stopAndClear() {
    releaseMedia();
    shouldAutoplayRef.current = false;
    setQueue([]);
    setCurrentIndex(0);
    setPosition(0);
    setDuration(0);
    setSubtitles([]);
    setIsPlaying(false);
    setErrorMessage("");
    void invoke("clear_player_queue");
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (audio.paused) {
      void audio.play().catch((error) => {
        setIsPlaying(false);
        setErrorMessage(error instanceof Error ? error.message : String(error));
      });
    } else {
      audio.pause();
    }
  }

  function seekTo(seconds: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(seconds, duration || seconds));
    setPosition(audio.currentTime);
  }

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<PlayerQueueRequest>("player:replace-queue", (event) => {
      if (!disposed) applyQueue(event.payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else {
        unlisten = cleanup;
        void invoke<PlayerQueueRequest | null>("bootstrap_player").then((payload) => {
          if (payload && !disposed) applyQueue(payload);
        });
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    window.addEventListener("player:prepare-close", releaseMedia);
    return () => {
      window.removeEventListener("player:prepare-close", releaseMedia);
      releaseMedia();
    };
  }, []);

  useEffect(() => {
    function handleQuickAction(event: Event) {
      const action = (event as CustomEvent<"pause" | "close">).detail;
      if (action === "close") {
        stopAndClear();
        return;
      }
      audioRef.current?.pause();
      setIsPlaying(false);
    }

    window.addEventListener("player:quick-action", handleQuickAction);
    return () => window.removeEventListener("player:quick-action", handleQuickAction);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    audio.src = convertFileSrc(currentTrack.absolutePath);
    audio.load();
    setPosition(0);
    setDuration(0);
    if (shouldAutoplayRef.current) {
      void audio.play().catch((error) => {
        setIsPlaying(false);
        setErrorMessage(error instanceof Error ? error.message : String(error));
      });
    }
  }, [currentTrack?.id, playbackRevision]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    setSubtitles([]);
    setSubtitleError("");
    setAutoScroll(true);
    if (!currentTrack?.subtitlePath) return;
    let disposed = false;
    void invoke<string>("read_player_subtitle", {
      input: { workId: currentTrack.workId, relativePath: currentTrack.subtitlePath },
    }).then(
      (raw) => {
        if (!disposed) setSubtitles(parseSubtitles(raw));
      },
      (error) => {
        if (!disposed) setSubtitleError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      disposed = true;
    };
  }, [currentTrack?.id, currentTrack?.subtitlePath, currentTrack?.workId]);

  useEffect(() => {
    if (active && autoScroll && activeSubtitleIndex >= 0) {
      activeSubtitleRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [active, activeSubtitleIndex, autoScroll]);

  return (
    <div className={`module-body player-workspace ${active ? "is-active" : "is-hidden"}`}>
      <aside className="player-workspace-sidebar">
        <button type="button" className="player-back-button" onClick={onBack}>
          <ArrowLeft size={17} strokeWidth={1.8} />
          <span>返回笔记</span>
        </button>
        <div className="player-playlist-header">
          <div>
            <span className="section-label">播放器</span>
            <h1>播放列表</h1>
          </div>
          <button type="button" className="player-clear-button" onClick={stopAndClear} disabled={!queue.length} title="清空播放列表">
            <Trash2 size={17} strokeWidth={1.8} />
          </button>
        </div>
        <nav className="player-playlist">
          {queue.length ? queue.map((track, index) => (
            <button
              key={track.id}
              type="button"
              className={`player-playlist-item ${index === currentIndex ? "is-active" : ""}`}
              onClick={() => playAt(index)}
            >
              <span className="player-track-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="player-track-copy">
                <strong>{track.title}</strong>
                <small>{track.workTitle || track.workId}</small>
              </span>
              {index === currentIndex && isPlaying ? <Music2 size={16} strokeWidth={1.8} /> : null}
            </button>
          )) : (
            <div className="player-playlist-empty">
              <ListMusic size={27} strokeWidth={1.5} />
              <strong>播放列表为空</strong>
              <span>从音声作品浏览器选择音频</span>
            </div>
          )}
        </nav>
      </aside>

      <main className="player-workspace-content">
        <header className="player-content-header">
          <div>
            <span className="section-label">正在播放 · {currentTrack?.workId ?? "未选择"}</span>
            <h2>{currentTrack?.title ?? "选择一首音频开始播放"}</h2>
            <p>{currentTrack?.workTitle ?? "字幕将在这里与播放进度同步显示"}</p>
          </div>
          <button
            type="button"
            className="player-locate-button"
            disabled={activeSubtitleIndex < 0}
            onClick={() => {
              setAutoScroll(true);
              window.requestAnimationFrame(() => activeSubtitleRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
            }}
          >
            <LocateFixed size={18} strokeWidth={1.8} />
            <span>当前字幕</span>
          </button>
        </header>

        <section
          className="player-subtitle-stage"
          onWheel={() => setAutoScroll(false)}
          onPointerDown={() => setAutoScroll(false)}
        >
          {subtitles.length ? subtitles.map((line, index) => (
            <button
              key={`${line.start}-${index}`}
              ref={index === activeSubtitleIndex ? activeSubtitleRef : null}
              type="button"
              className={`player-subtitle-line ${index === activeSubtitleIndex ? "is-active" : ""}`}
              onClick={() => seekTo(line.start)}
            >
              <span>{formatDuration(line.start)}</span>
              <strong>{line.text}</strong>
            </button>
          )) : (
            <div className="player-subtitle-empty">
              <Music2 size={32} strokeWidth={1.35} />
              <strong>{currentTrack ? "当前音频没有可显示的字幕" : "等待播放"}</strong>
              <span>{subtitleError ? `字幕读取失败：${subtitleError}` : "支持 VTT、SRT、LRC、ASS 与 SSA"}</span>
            </div>
          )}
        </section>

        <footer className="player-control-deck">
          <div className="player-progress-row">
            <span>{formatDuration(position)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(position, duration || position)}
              disabled={!currentTrack}
              onChange={(event) => seekTo(Number(event.target.value))}
            />
            <span>{formatDuration(duration)}</span>
          </div>
          <div className="player-control-row">
            <div className="player-transport-controls">
              <button type="button" onClick={() => playAt(currentIndex - 1)} disabled={currentIndex <= 0} title="上一首"><SkipBack size={20} /></button>
              <button type="button" onClick={() => seekTo(position - 5)} disabled={!currentTrack} title="快退 5 秒"><RotateCcw size={19} /><small>5</small></button>
              <button type="button" className="is-primary" onClick={togglePlayback} disabled={!currentTrack} title="播放或暂停">
                {isPlaying ? <Pause size={23} /> : <Play size={25} fill="currentColor" />}
              </button>
              <button type="button" onClick={() => seekTo(position + 30)} disabled={!currentTrack} title="快进 30 秒"><RotateCw size={19} /><small>30</small></button>
              <button type="button" onClick={() => playAt(currentIndex + 1)} disabled={!queue.length || currentIndex >= queue.length - 1} title="下一首"><SkipForward size={20} /></button>
            </div>
            <label className="player-volume-control">
              <Volume2 size={17} strokeWidth={1.8} />
              <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
              <span>{Math.round(volume * 100)}%</span>
            </label>
          </div>
          {errorMessage ? <p className="player-error">播放失败：{errorMessage}</p> : null}
          <audio
            ref={audioRef}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
            onDurationChange={(event) => setDuration(event.currentTarget.duration)}
            onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
            onEnded={() => {
              if (currentIndex < queue.length - 1) playAt(currentIndex + 1);
              else setIsPlaying(false);
            }}
            onError={() => setErrorMessage("当前音频格式无法由 WebView2 解码")}
          />
        </footer>
      </main>
    </div>
  );
}
