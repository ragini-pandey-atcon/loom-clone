import { createContext, useContext, useState } from 'react';

import { api, type Comment } from '../api/client';
import { formatClock, formatWhen } from '../lib/format';
import { viewerId } from '../lib/identity';
import { Avatar, ConfirmDialog, toast } from './ui';

/** Trim start (file time): comment times show from the trimmed 0:00, like the player clock. */
const ClockOffset = createContext(0);
const useShown = () => {
  const offset = useContext(ClockOffset);
  return (ms: number) => formatClock(Math.max(0, ms - offset));
};

interface Props {
  /** Trim start, so the times shown match the player. */
  offsetMs?: number;
  videoId: string;
  comments: Comment[];
  enabled: boolean;
  ownerDevice: boolean;
  /** Current player position, read when the composer opens. */
  currentMs: () => number;
  onSeek: (ms: number) => void;
  /** Resolves to a display name, asking for one first if needed; null when the person declined. */
  requireName: () => Promise<string | null>;
  onChanged: () => void;
}

function Composer({
  videoId,
  parentId,
  currentMs,
  requireName,
  onPosted,
  onCancel,
  autoFocus = false,
}: {
  videoId: string;
  parentId: string | null;
  currentMs: () => number;
  requireName: () => Promise<string | null>;
  onPosted: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState('');
  const [stampMs, setStampMs] = useState<number | null>(null);
  const [includeStamp, setIncludeStamp] = useState(true);
  const [sending, setSending] = useState(false);
  const isReply = parentId !== null;
  const shown = useShown();

  async function send() {
    const text = body.trim();
    if (!text || sending) return;
    const name = await requireName();
    if (!name) return;
    setSending(true);
    try {
      await api.addComment(videoId, {
        authorId: viewerId(),
        authorName: name,
        body: text,
        parentId,
        timestampMs: !isReply && includeStamp ? Math.round(stampMs ?? currentMs()) : null,
      });
      setBody('');
      setStampMs(null);
      onPosted();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The comment was not saved', 'error');
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label className="sr-only" htmlFor={`composer-${parentId ?? 'top'}`}>
        {isReply ? 'Reply' : 'Comment'}
      </label>
      <textarea
        id={`composer-${parentId ?? 'top'}`}
        className="textarea"
        placeholder={isReply ? 'Write a reply' : 'Add a comment at this moment'}
        value={body}
        maxLength={4000}
        autoFocus={autoFocus}
        onFocus={() => {
          // Pin the moment when the person started writing, not when they press send.
          if (!isReply && stampMs === null) setStampMs(currentMs());
        }}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
          if (e.key === 'Escape' && onCancel) onCancel();
        }}
      />
      <div className="composer-actions">
        {!isReply ? (
          <button
            type="button"
            className="stamp"
            aria-pressed={includeStamp}
            onClick={() => setIncludeStamp((v) => !v)}
            title={includeStamp ? 'Comment is pinned to this moment. Click to remove the time.' : 'Pin to this moment'}
          >
            at {shown(stampMs ?? currentMs())}
          </button>
        ) : (
          <span />
        )}
        <span className="chip-row">
          {onCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={!body.trim() || sending}>
            {isReply ? 'Reply' : 'Comment'}
          </button>
        </span>
      </div>
    </form>
  );
}

function CommentView({
  comment,
  reply,
  canDelete,
  onSeek,
  onReply,
  onDelete,
}: {
  comment: Comment;
  reply: boolean;
  canDelete: boolean;
  onSeek: (ms: number) => void;
  onReply?: () => void;
  onDelete: () => void;
}) {
  const shown = useShown();
  return (
    <div className={reply ? 'comment is-reply' : 'comment'}>
      <Avatar name={comment.authorName} seed={comment.authorId} />
      <div>
        <div className="comment-head">
          <strong>{comment.authorName}</strong>
          {comment.isOwner && <span className="owner-tag">Owner</span>}
          {comment.timestampMs !== null && (
            <button type="button" className="stamp" onClick={() => onSeek(comment.timestampMs!)}>
              {shown(comment.timestampMs)}
            </button>
          )}
          <span className="muted">{formatWhen(comment.createdAt)}</span>
        </div>
        {comment.deleted ? (
          <p className="comment-body is-deleted">Comment deleted</p>
        ) : (
          <p className="comment-body">{comment.body}</p>
        )}
        {!comment.deleted && (
          <div className="comment-actions">
            {onReply && (
              <button type="button" className="link-btn" onClick={onReply}>
                Reply
              </button>
            )}
            {canDelete && (
              <button type="button" className="link-btn" onClick={onDelete}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function Comments(props: Props) {
  return (
    <ClockOffset.Provider value={props.offsetMs ?? 0}>
      <CommentsInner {...props} />
    </ClockOffset.Provider>
  );
}

function CommentsInner({ videoId, comments, enabled, ownerDevice, currentMs, onSeek, requireName, onChanged }: Props) {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const me = viewerId();

  const top = comments
    .filter((c) => !c.parentId)
    .sort((a, b) => (a.timestampMs ?? Infinity) - (b.timestampMs ?? Infinity) || a.createdAt.localeCompare(b.createdAt));
  const repliesOf = (id: string) => comments.filter((c) => c.parentId === id);
  // A deleted comment with no replies has nothing left to show.
  const visible = top.filter((c) => !c.deleted || repliesOf(c.id).length > 0);

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api.deleteComment(deleting.id, me);
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The comment was not deleted', 'error');
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div>
      {enabled ? (
        <Composer videoId={videoId} parentId={null} currentMs={currentMs} requireName={requireName} onPosted={onChanged} />
      ) : (
        <p className="muted">Comments are turned off for this video.</p>
      )}

      {visible.length === 0 ? (
        <p className="muted">No comments yet. Pause where something needs a reply, then write it here.</p>
      ) : (
        visible.map((c) => (
          <div className="thread" key={c.id}>
            <CommentView
              comment={c}
              reply={false}
              canDelete={c.authorId === me || ownerDevice}
              onSeek={onSeek}
              onReply={enabled ? () => setReplyTo(c.id) : undefined}
              onDelete={() => setDeleting(c)}
            />
            {repliesOf(c.id)
              .filter((r) => !r.deleted)
              .map((r) => (
                <CommentView
                  key={r.id}
                  comment={r}
                  reply
                  canDelete={r.authorId === me || ownerDevice}
                  onSeek={onSeek}
                  onDelete={() => setDeleting(r)}
                />
              ))}
            {replyTo === c.id && (
              <div className="comment is-reply" style={{ display: 'block' }}>
                <Composer
                  videoId={videoId}
                  parentId={c.id}
                  currentMs={currentMs}
                  requireName={requireName}
                  autoFocus
                  onPosted={() => {
                    setReplyTo(null);
                    onChanged();
                  }}
                  onCancel={() => setReplyTo(null)}
                />
              </div>
            )}
          </div>
        ))
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this comment?"
        body="It is removed for everyone. Replies stay."
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
