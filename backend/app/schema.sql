-- ATCON Async Video, local edition. SQLite.
-- Ids are text (short random for videos so links stay readable, hex for the rest).
-- Times are ISO 8601 UTC text ending in Z, which sorts correctly as text.
-- The backend runs this file at startup (backend/app/schema.sql is the same file).

pragma foreign_keys = on;

create table if not exists owner_devices (
  viewer_id text primary key,
  created_at text not null
);

create table if not exists videos (
  id text primary key,
  title text not null check (length(title) between 1 and 200),
  status text not null default 'recording'
    check (status in ('recording', 'ready', 'failed')),
  source_mode text not null default 'screen_camera'
    check (source_mode in ('screen_camera', 'screen', 'camera')),
  mime_type text not null default 'video/webm',
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  width integer,
  height integer,
  size_bytes integer not null default 0,
  chunk_count integer not null default 0,
  seekable integer not null default 0 check (seekable in (0, 1)),
  has_thumbnail integer not null default 0 check (has_thumbnail in (0, 1)),
  comments_enabled integer not null default 1 check (comments_enabled in (0, 1)),
  reactions_enabled integer not null default 1 check (reactions_enabled in (0, 1)),
  archived_at text,
  created_at text not null,
  updated_at text not null
);
create index if not exists videos_created_idx on videos (created_at);
create index if not exists videos_archived_idx on videos (archived_at, created_at);

create table if not exists comments (
  id text primary key,
  video_id text not null references videos (id) on delete cascade,
  parent_id text references comments (id) on delete cascade,
  author_id text not null,
  author_name text not null check (length(author_name) between 1 and 60),
  is_owner integer not null default 0 check (is_owner in (0, 1)),
  body text not null check (length(body) between 1 and 4000),
  timestamp_ms integer check (timestamp_ms is null or timestamp_ms >= 0),
  created_at text not null,
  deleted_at text
);
create index if not exists comments_video_idx on comments (video_id, created_at);
create index if not exists comments_parent_idx on comments (parent_id);

create table if not exists reactions (
  id text primary key,
  video_id text not null references videos (id) on delete cascade,
  author_id text not null,
  author_name text not null check (length(author_name) between 1 and 60),
  emoji text not null check (emoji in ('👍', '❤️', '😂', '😮', '🎉', '👏', '🔥', '🤔')),
  timestamp_ms integer not null check (timestamp_ms >= 0),
  created_at text not null
);
create index if not exists reactions_video_idx on reactions (video_id, timestamp_ms);

-- One row per viewer per video. "counted" flips to 1 once, when the viewer passes
-- 5 s watched, 75 % of the duration, or the end, so a refresh never adds a view.
create table if not exists views (
  video_id text not null references videos (id) on delete cascade,
  viewer_id text not null,
  viewer_name text,
  watched_ms integer not null default 0,
  max_position_ms integer not null default 0,
  completed integer not null default 0 check (completed in (0, 1)),
  counted integer not null default 0 check (counted in (0, 1)),
  first_seen_at text not null,
  last_seen_at text not null,
  primary key (video_id, viewer_id)
);
create index if not exists views_counted_idx on views (video_id, counted);
