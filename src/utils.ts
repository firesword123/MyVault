export function formatTimestamp(timestamp: number) {
  if (!timestamp) return "Unknown";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

export function formatClockTime(timestamp: number, locale: string) {
  if (!timestamp) return "--:--";
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

export function formatRelativeTimestamp(timestamp: number, locale: string) {
  if (!timestamp) return "";
  const elapsedSeconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (elapsedSeconds < 60) return locale.startsWith("zh") ? "刚刚" : "just now";

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const [unit, seconds] = units.find(([, size]) => elapsedSeconds >= size) ?? ["minute", 60];
  const value = Math.floor(elapsedSeconds / seconds);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-value, unit);
}

export function noteSignature(note: { id: string; title: string; blocks: unknown[] } | null) {
  if (!note) return "";
  return `${note.id}::${note.title}::${JSON.stringify(note.blocks)}`;
}

export function noteRichText(note: { blocks: Array<{ type: string; html?: string }> } | null) {
  return note?.blocks.find((block) => block.type === "richText")?.html ?? "";
}

export function previewText(content: string) {
  const plain = content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain.slice(0, 120) || "Empty note";
}

export function formatFileSize(size: number) {
  if (!size) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
