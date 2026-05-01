-- ============================================================================
-- MarvMem Cloud — Supabase Schema Migration
-- ============================================================================
-- Run this in your Supabase SQL editor.
-- Requires: pgvector extension (enable in Dashboard → Database → Extensions)
-- ============================================================================

-- 0. Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. Subscriptions
-- ============================================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan            TEXT NOT NULL DEFAULT 'free'
                  CHECK (plan IN ('free', 'pro', 'team', 'enterprise')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'canceled', 'past_due', 'trialing')),
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ============================================================================
-- 2. Projects
-- ============================================================================

CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT 'default',
  slug            TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(owner_id, slug)
);

-- ============================================================================
-- 3. Project Members (Team tier)
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_members (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  invited_by      UUID REFERENCES auth.users(id),
  joined_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

-- ============================================================================
-- 4. Cloud Memories
-- ============================================================================

CREATE TABLE IF NOT EXISTS cloud_memories (
  id              UUID PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_type      TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  content         TEXT NOT NULL,
  summary         TEXT,
  confidence      REAL NOT NULL DEFAULT 0.7,
  importance      REAL NOT NULL DEFAULT 0.5,
  source          TEXT NOT NULL DEFAULT 'user',
  tags            JSONB NOT NULL DEFAULT '[]',
  metadata        JSONB DEFAULT '{}',
  embedding       vector(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,
  sync_version    BIGINT NOT NULL DEFAULT 0
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_cm_project ON cloud_memories(project_id);
CREATE INDEX IF NOT EXISTS idx_cm_project_kind ON cloud_memories(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_cm_project_scope ON cloud_memories(project_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_cm_sync_version ON cloud_memories(project_id, sync_version);
CREATE INDEX IF NOT EXISTS idx_cm_updated ON cloud_memories(project_id, updated_at DESC);

-- Vector similarity search index (IVFFlat for < 1M rows, switch to HNSW for larger)
CREATE INDEX IF NOT EXISTS idx_cm_embedding ON cloud_memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================================
-- 5. Usage Meters
-- ============================================================================

CREATE TABLE IF NOT EXISTS usage_meters (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period          TEXT NOT NULL,  -- '2026-04'
  memories_written    INT NOT NULL DEFAULT 0,
  memories_total      INT NOT NULL DEFAULT 0,
  embeddings_count    INT NOT NULL DEFAULT 0,
  sync_operations     INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, period)
);

-- ============================================================================
-- 6. API Keys (per-project, for SDK/MCP access)
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_hash        TEXT NOT NULL,   -- SHA-256 of the actual key
  key_prefix      TEXT NOT NULL,   -- 'mm_' + first 8 chars (for display)
  label           TEXT DEFAULT 'default',
  scopes          JSONB DEFAULT '["read", "write"]',
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ak_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_ak_project ON api_keys(project_id);

-- ============================================================================
-- 7. Audit Events
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id),
  event_type      TEXT NOT NULL,
  event_data      JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ae_project ON audit_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ae_type ON audit_events(project_id, event_type);

-- ============================================================================
-- 8. Row Level Security
-- ============================================================================

-- Subscriptions: users see only their own
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sub_own ON subscriptions
  FOR ALL USING (user_id = auth.uid());

-- Projects: owner OR team member
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY proj_access ON projects
  FOR ALL USING (
    owner_id = auth.uid()
    OR id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
  );

-- Project members: only project owners/admins can manage
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY pm_read ON project_members
  FOR SELECT USING (
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
    OR user_id = auth.uid()
  );
CREATE POLICY pm_write ON project_members
  FOR ALL USING (
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  );

-- Cloud memories: project access required
ALTER TABLE cloud_memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY cm_access ON cloud_memories
  FOR ALL USING (
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
      UNION
      SELECT project_id FROM project_members WHERE user_id = auth.uid()
    )
  );

-- Usage meters: project owner/member
ALTER TABLE usage_meters ENABLE ROW LEVEL SECURITY;
CREATE POLICY um_access ON usage_meters
  FOR ALL USING (
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
      UNION
      SELECT project_id FROM project_members WHERE user_id = auth.uid()
    )
  );

-- API keys: project access
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY ak_access ON api_keys
  FOR ALL USING (
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
      UNION
      SELECT project_id FROM project_members
        WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- Audit events: project access (read only for non-admins)
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY ae_read ON audit_events
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
      UNION
      SELECT project_id FROM project_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================================
-- 9. Helper Functions
-- ============================================================================

-- Atomic usage increment
CREATE OR REPLACE FUNCTION increment_usage(
  p_project_id UUID,
  p_period TEXT,
  p_counter TEXT,
  p_amount INT DEFAULT 1
) RETURNS void AS $$
BEGIN
  INSERT INTO usage_meters (project_id, period)
    VALUES (p_project_id, p_period)
    ON CONFLICT (project_id, period) DO NOTHING;

  EXECUTE format(
    'UPDATE usage_meters SET %I = %I + $1, updated_at = NOW() WHERE project_id = $2 AND period = $3',
    p_counter, p_counter
  ) USING p_amount, p_project_id, p_period;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Auto-increment sync_version on insert/update
CREATE OR REPLACE FUNCTION set_sync_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.sync_version := COALESCE(
    (SELECT MAX(sync_version) FROM cloud_memories WHERE project_id = NEW.project_id),
    0
  ) + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_version
  BEFORE INSERT OR UPDATE ON cloud_memories
  FOR EACH ROW
  EXECUTE FUNCTION set_sync_version();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sub_updated
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trg_proj_updated
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
