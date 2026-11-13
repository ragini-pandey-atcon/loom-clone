import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import { api, type Comment, playedDurationMs, thumbnailUrl, type Video } from '../api/client';
import { formatClock, formatWhen } from '../lib/format';
import { viewerId } from '../lib/identity';
import { insertMention, mentionQuery, splitMentions, suggest } from '../lib/mentions';
import { IconReply, IconVideo } from './Icons';
import { Avatar, ConfirmDialog, toast } from './ui';

/** Names that can be @mentioned on this video. */
const People = createContext<string[]>([]);

/** Trim start (file time): comment times show from the trimmed 0:00, like the player clock. */
const ClockOffset = createContext(0);
const useShown = () => {
  const offset = useContext(ClockOffset);
  return (ms: number) => formatClock(Math.max(0, ms - offset));
};

interface Props {
  /** Trim start, so the times shown match the player. */
  offsetMs?: number;
  /** Everyone who took part on this video, for @mentions. */
  people?: string[];
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
  const people = useContext(People);
  const area = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const query = mentionQuery(body, caret);
  const options = query && dismissed !== query.start ? suggest(people, query.query) : [];
  const open = options.length > 0;
  useEffect(() => setPick(0), [query?.query]);

  function choose(name: string) {
    if (!query) return;
    const next = insertMention(body, query.start, caret, name);
    setBody(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  }

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
        ref={area}
        id={`composer-${parentId ?? 'top'}`}
        className="textarea"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? `mentions-${parentId ?? 'top'}` : undefined}
        placeholder={isReply ? 'Write a reply' : 'Add a comment at this moment'}
        value={body}
        maxLength={4000}
        autoFocus={autoFocus}
        onFocus={() => {
          // Pin the moment when the person started writing, not when they press send.
          if (!isReply && stampMs === null) setStampMs(currentMs());
        }}
        onChange={(e) => {
          setBody(e.target.value);
          setCaret(e.target.selectionStart);
          setDismissed(null);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setPick((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              choose(options[pick]);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDismissed(query!.start);
              return;
            }
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
          if (e.key === 'Escape' && onCancel) onCancel();
        }}
      />
      {open && (
        <ul className="mention-list" id={`mentions-${parentId ?? 'top'}`} role="listbox" aria-label="People to mention">
          {options.map((name, i) => (
            <li
              key={name}
              role="option"
              aria-selected={i === pick}
              onPointerDown={(e) => {
                e.preventDefault();
                choose(name);
              }}
            >
              <Avatar name={name} seed={name} />
              {name}
            </li>
          ))}
        </ul>
      )}
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
          {!isReply && (
            <Link className="btn btn-ghost" to={`/record?replyTo=${videoId}`} title="Answer with a recording of your own">
              <IconReply />
              Video reply
            </Link>
          )}
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

function CommentText({ body }: { body: string }) {
  const people = useContext(People);
  return (
    <>
      {splitMentions(body, people).map((s, i) =>
        s.mention ? (
          <mark key={i} className="mention">
            {s.text}
          </mark>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

/** The recording someone made in answer, as a small card linking to it. */
function VideoReplyCard({ id }: { id: string }) {
  const [video, setVideo] = useState<Video | null | 'gone'>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getVideo(id)
      .then((v) => !cancelled && setVideo(v))
      .catch(() => !cancelled && setVideo('gone'));
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (video === 'gone') return null;
  const length = video ? playedDurationMs(video) : null;
  return (
    <Link className="reply-card" to={`/v/${id}`}>
      <span className="reply-card-thumb">
        {video && video.hasThumbnail ? <img src={thumbnailUrl(video)} alt="" /> : <IconVideo />}
        {length !== null && <span className="badge">{formatClock(length)}</span>}
      </span>
      <span>
        <span className="muted">Video reply</span>
        <strong>{video ? video.title : '…'}</strong>
      </span>
    </Link>
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
          <>
            <p className="comment-body">
              <CommentText body={comment.body} />
            </p>
            {comment.replyVideoId && <VideoReplyCard id={comment.replyVideoId} />}
          </>
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
      <People.Provider value={props.people ?? []}>
        <CommentsInner {...props} />
      </People.Provider>
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
