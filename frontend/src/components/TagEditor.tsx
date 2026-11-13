import { useState } from 'react';
import { Link } from 'react-router';

import { api, type Video } from '../api/client';
import { IconTag, IconX } from './Icons';
import { toast } from './ui';

const MAX_TAGS = 10;

/** Tags under the title. The owner adds and removes them; everyone else just reads them. */
export function TagEditor({ video, owner, onChanged }: { video: Video; owner: boolean; onChanged: (v: Video) => void }) {
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);

  async function save(tags: string[]) {
    try {
      onChanged(await api.setTags(video.id, tags));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The tags were not saved', 'error');
    }
  }

  async function add() {
    // "design, q4" adds two.
    const fresh = draft
      .split(',')
      .map((t) => t.trim().replace(/^#/, ''))
      .filter(Boolean);
    setDraft('');
    if (!fresh.length) return;
    const known = new Set(video.tags.map((t) => t.toLowerCase()));
    const next = [...video.tags, ...fresh.filter((t) => !known.has(t.toLowerCase()))];
    if (next.length > MAX_TAGS) {
      toast(`Up to ${MAX_TAGS} tags per video`, 'error');
      return;
    }
    await save(next);
  }

  if (!owner && video.tags.length === 0) return null;

  return (
    <div className="tag-row" aria-label="Tags">
      <IconTag className="tag-row-icon" />
      {video.tags.map((tag) => (
        <span key={tag} className="tag">
          {owner ? <Link to={`/?tag=${encodeURIComponent(tag)}`}>{tag}</Link> : tag}
          {owner && (
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => void save(video.tags.filter((t) => t !== tag))}
            >
              <IconX />
            </button>
          )}
        </span>
      ))}
      {owner &&
        (adding ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <input
              className="input tag-input"
              aria-label="New tag"
              placeholder="Add a tag"
              value={draft}
              maxLength={80}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (draft.trim()) void add();
                setAdding(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDraft('');
                  setAdding(false);
                }
              }}
            />
          </form>
        ) : (
          video.tags.length < MAX_TAGS && (
            <button type="button" className="link-btn" onClick={() => setAdding(true)}>
              {video.tags.length ? 'Add tag' : 'Add a tag'}
            </button>
          )
        ))}
    </div>
  );
}
