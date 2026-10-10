/**
 * Sends recording chunks to the API while the take is still running, one at a time and in order.
 * A failed PUT is retried with backoff until it lands or the take is discarded, so a server
 * restart mid-recording loses nothing. Chunks stay referenced after upload: the WebM repair at
 * Stop reads the whole recording, and Chrome keeps large Blobs on disk rather than in memory.
 */
import { api, ApiError } from '../api/client';

export interface UploadProgress {
  chunks: number;
  uploaded: number;
  bytes: number;
  uploadedBytes: number;
  retrying: boolean;
}

const MAX_BACKOFF_MS = 8000;

export class ChunkUploader {
  readonly chunks: Blob[] = [];
  private acked = new Set<number>();
  private queue: number[] = [];
  private running = false;
  private cancelled = false;
  private retrying = false;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly videoId: string,
    private readonly onProgress: (p: UploadProgress) => void,
  ) {}

  push(blob: Blob): void {
    if (this.cancelled || blob.size === 0) return;
    this.chunks.push(blob);
    this.queue.push(this.chunks.length - 1);
    this.report();
    void this.run();
  }

  /** Resolves once every chunk pushed so far is on the server. */
  drain(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Re-sends chunks the server says it is missing (after a 409 from finalize). */
  resend(seqs: number[]): Promise<void> {
    for (const seq of seqs) {
      this.acked.delete(seq);
      if (seq < this.chunks.length && !this.queue.includes(seq)) this.queue.push(seq);
    }
    this.queue.sort((a, b) => a - b);
    void this.run();
    return this.drain();
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    this.idleWaiters.splice(0).forEach((w) => w());
  }

  progress(): UploadProgress {
    let uploadedBytes = 0;
    for (const seq of this.acked) uploadedBytes += this.chunks[seq]?.size ?? 0;
    return {
      chunks: this.chunks.length,
      uploaded: this.acked.size,
      bytes: this.chunks.reduce((n, c) => n + c.size, 0),
      uploadedBytes,
      retrying: this.retrying,
    };
  }

  private report() {
    this.onProgress(this.progress());
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    let backoff = 500;
    while (this.queue.length > 0 && !this.cancelled) {
      const seq = this.queue[0];
      try {
        await api.putChunk(this.videoId, seq, this.chunks[seq]);
        this.acked.add(seq);
        this.queue.shift();
        backoff = 500;
        this.retrying = false;
      } catch (error) {
        // The take was deleted elsewhere (or finished): nothing will ever accept these chunks.
        if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
          this.cancel();
          break;
        }
        this.retrying = true;
        this.report();
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
      this.report();
    }
    this.running = false;
    this.idleWaiters.splice(0).forEach((w) => w());
  }
}
