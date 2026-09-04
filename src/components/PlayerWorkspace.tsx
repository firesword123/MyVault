import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  const clock = `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
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
  const progressPercent = currentTrack && duration > 0
    ? Math.min(100, Math.max(0, position / duration * 100))
    : 0;

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
      <aside className="player-sidebar">
        <button type="button" className="btn-back" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          返回笔记
        </button>
        <div className="pl-head">
          <span className="pl-title">播放列表</span>
          <button type="button" className="icon-btn pl-clear" onClick={stopAndClear} disabled={!queue.length} title="清空列表">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
        <nav className={`playlist nice-scroll ${queue.length ? "" : "empty"}`}>
          {queue.length ? queue.map((track, index) => (
            <button
              key={track.id}
              type="button"
              className={`pl-item ${index === currentIndex ? "active" : ""}`}
              onClick={() => playAt(index)}
            >
              <span className="pl-idx">{String(index + 1).padStart(2, "0")}</span>
              <span className="pl-text">
                <span className="pl-name">{track.title}</span>
                <span className="pl-sub">{track.workTitle || track.workId}</span>
              </span>
            </button>
          )) : (
            <div className="pl-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="16" y2="18" />
                <path d="M3 6h.01M3 12h.01M3 18h.01" strokeWidth="2.4" />
              </svg>
              <h3>播放列表为空</h3>
              <p>从音声作品浏览器选择音频</p>
            </div>
          )}
        </nav>
      </aside>

      <main className="player-content">
        <header className="now-head">
          <div className="nh-left">
            <div className="nh-flag">正在播放 · <span>{currentTrack?.workId ?? "未选择"}</span></div>
            <div className="nh-title">{currentTrack?.title ?? "选择一首音频开始播放"}</div>
            <div className="nh-sub">
              {currentTrack
                ? subtitles.length
                  ? `共 ${subtitles.length} 条字幕`
                  : "该曲目暂无字幕"
                : "字幕将在这里与播放进度同步显示"}
            </div>
          </div>
          <button
            type="button"
            className="btn-cue"
            disabled={activeSubtitleIndex < 0}
            onClick={() => {
              setAutoScroll(true);
              window.requestAnimationFrame(() => activeSubtitleRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="12" cy="12" r="7" />
              <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
            </svg>
            当前字幕
          </button>
        </header>

        <section
          className="sub-panel nice-scroll"
          onWheel={() => setAutoScroll(false)}
          onPointerDown={() => setAutoScroll(false)}
        >
          {subtitles.length ? subtitles.map((line, index) => (
            <button
              key={`${line.start}-${index}`}
              ref={index === activeSubtitleIndex ? activeSubtitleRef : null}
              type="button"
              className={`cue-row ${index === activeSubtitleIndex ? "active" : ""}`}
              onClick={() => seekTo(line.start)}
            >
              <span className="cue-time">{formatDuration(line.start)}</span>
              <span className="cue-text">{line.text}</span>
            </button>
          )) : (
            <div className="sub-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M8 15s-1.5 2-1.5 3.5A1.5 1.5 0 0 0 8 20a1.5 1.5 0 0 0 1.5-1.5c0-1.5-1.5-3.5-1.5-3.5" />
                <path d="M9 9a3 3 0 1 0 3-3" />
                <path d="M3 15h6" />
                <path d="M15 9v10" />
              </svg>
              <h3>{currentTrack ? "该曲目暂无字幕" : "等待播放"}</h3>
              <p>{subtitleError ? `字幕读取失败：${subtitleError}` : "支持 VTT、SRT、LRC、ASS 与 SSA"}</p>
            </div>
          )}
        </section>

        <footer className={`transport ${currentTrack ? "" : "ctrl-disabled"}`}>
          <div className="t-row1">
            <span>{formatDuration(position)}</span>
            <div className="seek">
              <div className="seek-track">
                <div className="seek-fill" style={{ ["--pos" as string]: `${progressPercent}%` }} />
                <div className="seek-thumb" style={{ left: `${progressPercent}%` }} />
              </div>
              <input
                className="seek-input"
                aria-label="播放进度"
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={Math.min(position, duration || position)}
                disabled={!currentTrack}
                onChange={(event) => seekTo(Number(event.target.value))}
              />
            </div>
            <span>{formatDuration(duration)}</span>
          </div>
          <div className="t-row2">
            <div className="t-ctr">
              <button type="button" className="tc-btn" onClick={() => playAt(currentIndex - 1)} disabled={currentIndex <= 0} title="上一首">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 20 L9 12 L19 4 Z" /><rect x="5" y="4" width="2.4" height="16" rx="1" /></svg>
              </button>
              <button type="button" className="tc-btn" onClick={() => seekTo(position - 5)} disabled={!currentTrack} title="后退 5 秒">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
                <span className="tc-num">5</span>
              </button>
              <button type="button" className={`tc-btn tc-main ${isPlaying ? "playing" : ""}`} onClick={togglePlayback} disabled={!currentTrack} title="播放 / 暂停">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path className="play-ic" d="M8 5.5 L19 12 L8 18.5 Z" />
                  <g className="pause-ic"><rect x="7" y="5.5" width="3.4" height="13" rx="1" /><rect x="13.6" y="5.5" width="3.4" height="13" rx="1" /></g>
                </svg>
              </button>
              <button type="button" className="tc-btn" onClick={() => seekTo(position + 30)} disabled={!currentTrack} title="前进 30 秒">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7l3 2.7" /><path d="M21 3v5h-5" /></svg>
                <span className="tc-num">30</span>
              </button>
              <button type="button" className="tc-btn" onClick={() => playAt(currentIndex + 1)} disabled={!queue.length || currentIndex >= queue.length - 1} title="下一首">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 4 L15 12 L5 20 Z" /><rect x="16.6" y="4" width="2.4" height="16" rx="1" /></svg>
              </button>
            </div>
            <label className="vol-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9 H2 v6 h4 l5 4 z" /><path d="M15.5 8.8a5 5 0 0 1 0 6.4" /></svg>
              <input
                type="range"
                className="vol"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                style={{ ["--v" as string]: `${Math.round(volume * 100)}%` }}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
              <span className="vol-pct">{Math.round(volume * 100)}%</span>
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
