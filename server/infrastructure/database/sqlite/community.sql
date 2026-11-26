CREATE TABLE IF NOT EXISTS community_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, barangay_id INTEGER NOT NULL REFERENCES barangays(id),
  author_id INTEGER NOT NULL REFERENCES users(id), is_official INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL, report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
  request_key TEXT NOT NULL, request_hash TEXT NOT NULL, engagement_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT, UNIQUE(author_id, request_key), UNIQUE(report_id)
);
CREATE INDEX IF NOT EXISTS community_feed_scope ON community_posts(barangay_id, deleted_at, created_at, id);
CREATE TABLE IF NOT EXISTS community_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  storage_reference TEXT NOT NULL, image_order INTEGER NOT NULL, UNIQUE(post_id, image_order)
);
CREATE TABLE IF NOT EXISTS community_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES community_comments(id) ON DELETE SET NULL,
  author_id INTEGER NOT NULL REFERENCES users(id), is_official INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
  request_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT, UNIQUE(post_id, author_id, request_key)
);
CREATE INDEX IF NOT EXISTS community_comment_page ON community_comments(post_id, deleted_at, created_at, id);
CREATE INDEX IF NOT EXISTS community_comment_parent ON community_comments(post_id, parent_id, deleted_at);
CREATE TABLE IF NOT EXISTS community_reactions (
  post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction TEXT NOT NULL CHECK(reaction IN ('like', 'heart')), PRIMARY KEY(post_id, user_id)
);
CREATE TABLE IF NOT EXISTS community_personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_variant INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_id, user_id),
  UNIQUE(post_id, display_name)
);
CREATE TABLE IF NOT EXISTS community_comment_reactions (
  comment_id INTEGER NOT NULL REFERENCES community_comments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reaction TEXT NOT NULL DEFAULT 'like' CHECK (reaction IN ('like', 'heart')),
  PRIMARY KEY(comment_id, user_id)
);
