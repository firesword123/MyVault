export function formatTimestamp(timestamp: number) {
  if (!timestamp) return "Unknown";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

export function noteSignature(note: { id: string; title: string; content: string } | null) {
  if (!note) return "";
  return `${note.id}::${note.title}::${note.content}`;
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
