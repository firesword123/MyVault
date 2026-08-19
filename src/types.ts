export type NoteSummary = {
  id: string;
  title: string;
  relativePath: string;
  folderPath: string;
  isDraft: boolean;
  isTrashed: boolean;
  updatedAt: number;
  preview: string;
  originalFolderPath: string | null;
  deletedAt: number | null;
};

export type NoteDetail = {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  relativePath: string;
  folderPath: string;
  isDraft: boolean;
  isTrashed: boolean;
  originalFolderPath: string | null;
  deletedAt: number | null;
};

export type BootstrapPayload = {
  vaultPath: string;
  notes: NoteSummary[];
  folders: string[];
  settings: AppSettings;
};

export type WorkspacePayload = {
  notes: NoteSummary[];
  folders: string[];
};

export type AppSettings = {
  language: string;
  showNoteTime: boolean;
  colorPresets: string[];
  colorPresetCount: number;
  closeBehavior: "quit" | "tray";
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  noProxy: string;
  notesState: {
    selectedNoteId: string;
  };
  persistentModules: string[];
  closePlayerOnPause: boolean;
  showMemoryInTitlebar: boolean;
};

export type ResourceUsage = {
  appMemoryBytes: number;
  webviewMemoryBytes: number;
  totalMemoryBytes: number;
  appCpuPercent: number;
  webviewCpuPercent: number;
  totalCpuPercent: number;
  appProcesses: number;
  webviewProcesses: number;
  totalProcesses: number;
};

export type AsmrDictionaries = {
  tags: string[];
  voiceActors: string[];
  circles: string[];
};

export type AsmrWork = {
  rjId: string;
  title: string;
  circle: string;
  voiceActors: string[];
  tags: string[];
  status: "new" | "listening" | "finished" | "archived";
  favorite: boolean;
  rating: number | null;
  note: string;
  workDir: string;
  filesDir: string;
  coverPath: string | null;
  thumbnailPath: string | null;
  lastOpenedFolder: string | null;
  lastPlayedAudioPath: string | null;
  lastPositionMs: number;
  importedAt: number;
  updatedAt: number;
};

export type AsmrBootstrapPayload = {
  works: AsmrWork[];
  dictionaries: AsmrDictionaries;
  libraryPath: string;
};

export type AsmrImportPreview = {
  sourcePath: string;
  rjId: string;
  alreadyExists: boolean;
  fileCount: number;
  folderCount: number;
  totalSize: number;
  audioCount: number;
  subtitleCount: number;
  imageCount: number;
  otherCount: number;
  associatedSubtitleCount: number;
  defaultFolder: string | null;
};

export type AsmrImportResult = {
  work: AsmrWork;
  mode: "copy" | "move";
  sourceRemoved: boolean;
  warning: string | null;
};

export type AsmrFileItem = {
  name: string;
  relativePath: string;
  absolutePath: string;
  kind: "folder" | "audio" | "subtitle" | "image" | "file";
  size: number;
  subtitlePath: string | null;
};

export type AsmrFolderPayload = {
  rjId: string;
  folderPath: string;
  items: AsmrFileItem[];
};

export type PlayerTrack = {
  id: string;
  title: string;
  workId: string;
  workTitle: string;
  absolutePath: string;
  relativePath: string;
  subtitlePath: string | null;
};

export type PlayerQueueRequest = {
  source: "dl_asmr";
  startIndex: number;
  tracks: PlayerTrack[];
};
