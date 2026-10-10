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

  listVideos: (opts: { q?: string; archived?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    if (opts.archived) params.set('archived', '1');
    const qs = params.toString();
    return request<Video[]>(`/videos${qs ? `?${qs}` : ''}`);
  },
  createVideo: (body: { title: string; sourceMode: SourceMode; mimeType: string }) =>
    request<Video>('/videos', json('POST', body)),
  getVideo: (id: string) => request<Video>(`/videos/${id}`),
  patchVideo: (
    id: string,
    body: Partial<{ title: string; archived: boolean; commentsEnabled: boolean; reactionsEnabled: boolean }>,
  ) => request<Video>(`/videos/${id}`, json('PATCH', body)),
  deleteVideo: (id: string) => request<void>(`/videos/${id}`, { method: 'DELETE' }),

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
export const thumbnailUrl = (v: Pick<Video, 'id' | 'updatedAt'>) => `/api/videos/${v.id}/thumbnail?v=${encodeURIComponent(v.updatedAt)}`;
export const shareUrl = (id: string) => `${window.location.origin}/v/${id}`;
