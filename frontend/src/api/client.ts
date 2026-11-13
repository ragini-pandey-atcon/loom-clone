export type VideoStatus = 'recording' | 'ready' | 'failed';
export type SourceMode = 'screen_camera' | 'screen' | 'camera';

export interface Video {
  id: string;
  title: string;
  status: VideoStatus;
  sourceMode: SourceMode;
  mimeType: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  chunkCount: number;
  seekable: boolean;
  hasThumbnail: boolean;
  commentsEnabled: boolean;
  reactionsEnabled: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  viewCount: number;
  commentCount: number;
  folderId: string | null;
  /** Trim is a playback window over the untouched file; null means not trimmed. */
  trimStartMs: number | null;
  trimEndMs: number | null;
  uploaded: boolean;
  /** Only when the request named a viewer. */
  watchLater?: boolean;
}

export interface Folder {
  id: string;
  name: string;
  videoCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The part of the file that plays: the trim window, or all of it. */
export function playWindow(v: Pick<Video, 'durationMs' | 'trimStartMs' | 'trimEndMs'>): { startMs: number; endMs: number | null } {
  return { startMs: v.trimStartMs ?? 0, endMs: v.trimEndMs ?? v.durationMs };
}

/** Length as watched: trimmed length when trimmed. */
export function playedDurationMs(v: Pick<Video, 'durationMs' | 'trimStartMs' | 'trimEndMs'>): number | null {
  const { startMs, endMs } = playWindow(v);
  return endMs === null ? null : endMs - startMs;
}

export interface Comment {
  id: string;
  videoId: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  isOwner: boolean;
  body: string;
  deleted: boolean;
  timestampMs: number | null;
  createdAt: string;
}

export interface Reaction {
  id: string;
  videoId: string;
  authorId: string;
  authorName: string;
  emoji: string;
  timestampMs: number;
  createdAt: string;
}

export interface Viewer {
  viewerId: string;
  viewerName: string;
  watchedMs: number;
  completed: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

export const EMOJIS = ['👍', '❤️', '😂', '😮', '🎉', '👏', '🔥', '🤔'] as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: unknown,
  ) {
    super(message);
  }
}

/** True when the local API server is not running (fetch itself failed, or Vite's proxy said 502/504). */
export function isOffline(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ApiError && (error.status === 502 || error.status === 504));
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = (await res.json()).detail;
    } catch {
      /* not JSON */
    }
    const message =
      typeof detail === 'string'
        ? detail
        : detail && typeof detail === 'object' && 'message' in detail
          ? String((detail as { message: unknown }).message)
          : `Request failed (${res.status})`;
    throw new ApiError(res.status, message, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  claimOwnerDevice: (viewerId: string) => request<void>('/owner/devices', json('POST', { viewerId })),

  /** folder: a folder id, 'none' for videos in no folder, or leave out for all. */
  listVideos: (opts: { q?: string; archived?: boolean; folder?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    if (opts.archived) params.set('archived', '1');
    if (opts.folder) params.set('folder', opts.folder);
    const qs = params.toString();
    return request<Video[]>(`/videos${qs ? `?${qs}` : ''}`);
  },
  createVideo: (body: { title: string; sourceMode: SourceMode; mimeType: string }) =>
    request<Video>('/videos', json('POST', body)),
  getVideo: (id: string, viewer?: string) =>
    request<Video>(`/videos/${id}${viewer ? `?viewerId=${encodeURIComponent(viewer)}` : ''}`),
  patchVideo: (
    id: string,
    body: Partial<{
      title: string;
      archived: boolean;
      commentsEnabled: boolean;
      reactionsEnabled: boolean;
      folderId: string | null;
      trimStartMs: number | null;
      trimEndMs: number | null;
    }>,
  ) => request<Video>(`/videos/${id}`, json('PATCH', body)),
  deleteVideo: (id: string) => request<void>(`/videos/${id}`, { method: 'DELETE' }),
  duplicateVideo: (id: string) => request<Video>(`/videos/${id}/duplicate`, { method: 'POST' }),

  listFolders: () => request<Folder[]>('/folders'),
  getFolder: (id: string) => request<Folder>(`/folders/${id}`),
  createFolder: (name: string) => request<Folder>('/folders', json('POST', { name })),
  renameFolder: (id: string, name: string) => request<Folder>(`/folders/${id}`, json('PATCH', { name })),
  deleteFolder: (id: string) => request<void>(`/folders/${id}`, { method: 'DELETE' }),

  listWatchLater: (viewer: string) => request<Video[]>(`/watch-later?viewerId=${encodeURIComponent(viewer)}`),
  addWatchLater: (id: string, viewer: string) => request<void>(`/watch-later/${id}`, json('PUT', { viewerId: viewer })),
  removeWatchLater: (id: string, viewer: string) =>
    request<void>(`/watch-later/${id}?viewerId=${encodeURIComponent(viewer)}`, { method: 'DELETE' }),

  putChunk: (id: string, seq: number, data: Blob) =>
    request<{ seq: number; bytes: number }>(`/videos/${id}/chunks/${seq}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
    }),
  getChunks: (id: string) =>
    request<{ received: number[]; bytes: number; contiguous: number }>(`/videos/${id}/chunks`),
  getRaw: async (id: string) => {
    const res = await fetch(`/api/videos/${id}/raw`);
    if (!res.ok) throw new ApiError(res.status, 'Could not read the unfinished recording', null);
    return res.blob();
  },
  finalize: (
    id: string,
    header: Uint8Array,
    q: { chunkCount: number; bodyOffset: number; durationMs?: number; width?: number; height?: number },
  ) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(Math.round(v)));
    return request<Video>(`/videos/${id}/finalize?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: header as BodyInit,
    });
  },
  putThumbnail: (id: string, jpeg: Blob) =>
    request<void>(`/videos/${id}/thumbnail`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: jpeg,
    }),

  listComments: (id: string) => request<Comment[]>(`/videos/${id}/comments`),
  addComment: (
    id: string,
    body: { authorId: string; authorName: string; body: string; timestampMs?: number | null; parentId?: string | null },
  ) => request<Comment>(`/videos/${id}/comments`, json('POST', body)),
  deleteComment: (commentId: string, authorId: string) =>
    request<void>(`/comments/${commentId}?authorId=${encodeURIComponent(authorId)}`, { method: 'DELETE' }),

  listReactions: (id: string) => request<Reaction[]>(`/videos/${id}/reactions`),
  addReaction: (id: string, body: { authorId: string; authorName: string; emoji: string; timestampMs: number }) =>
    request<Reaction>(`/videos/${id}/reactions`, json('POST', body)),

  // keepalive: the last heartbeat is usually sent as the viewer leaves, and must outlive the page.
  sendView: (
    id: string,
    body: { viewerId: string; viewerName: string | null; deltaMs: number; positionMs: number; ended: boolean },
  ) => request<{ counted: boolean; owner: boolean }>(`/videos/${id}/views`, { ...json('POST', body), keepalive: true }),
  listViews: (id: string) => request<{ count: number; viewers: Viewer[] }>(`/videos/${id}/views`),
};

export const mediaUrl = (id: string) => `/api/videos/${id}/media`;
export const downloadUrl = (id: string) => `/api/videos/${id}/media?download=1`;

/** Starts a download of the whole file (a trim only applies to playback here). */
export function downloadVideo(id: string) {
  const a = document.createElement('a');
  a.href = downloadUrl(id);
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

/** A share link that starts playing at `ms` (Loom: "Start at mm:ss"). */
export const shareUrlAt = (id: string, ms: number) => `${shareUrl(id)}?t=${Math.floor(ms / 1000)}`;

export interface UploadInfo {
  title: string;
  mimeType: string;
  durationMs?: number;
  width?: number;
  height?: number;
  folderId?: string;
}

/** XHR rather than fetch: fetch cannot report upload progress. */
export function uploadVideo(file: Blob, info: UploadInfo, onProgress: (fraction: number) => void): Promise<Video> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(info)) if (v !== undefined && v !== null) params.set(k, String(typeof v === 'number' ? Math.round(v) : v));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/videos/upload?${params}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { detail?: unknown } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as unknown as Video);
      else {
        const detail = body?.detail;
        reject(new ApiError(xhr.status, typeof detail === 'string' ? detail : `Upload failed (${xhr.status})`, detail));
      }
    };
    xhr.onerror = () => reject(new TypeError('The local server is not answering'));
    xhr.send(file);
  });
}
export const thumbnailUrl = (v: Pick<Video, 'id' | 'updatedAt'>) => `/api/videos/${v.id}/thumbnail?v=${encodeURIComponent(v.updatedAt)}`;
export const shareUrl = (id: string) => `${window.location.origin}/v/${id}`;
