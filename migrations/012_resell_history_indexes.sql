CREATE INDEX IF NOT EXISTS resell_tasks_store_status_created_idx
  ON resell_tasks (store_id, status, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS resell_tasks_created_idx
  ON resell_tasks (created_at_ms DESC);
