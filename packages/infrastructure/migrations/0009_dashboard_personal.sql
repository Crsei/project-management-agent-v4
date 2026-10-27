ALTER TABLE users
  ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 200),
  ADD COLUMN profile_version integer NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  ADD COLUMN profile_updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX dashboard_task_watch_active_unique
  ON dashboard_records(workspace_id, owner_id, (data->>'taskId'))
  WHERE kind='task_watch' AND data->>'watching'='true';

ALTER TABLE dashboard_records ADD CONSTRAINT dashboard_personal_record_shape CHECK (
  CASE kind
    WHEN 'task_watch' THEN owner_id IS NOT NULL AND project_id IS NOT NULL
      AND jsonb_typeof(data->'taskId')='string' AND length(data->>'taskId')>0
      AND jsonb_typeof(data->'watching')='boolean'
    WHEN 'private_note' THEN owner_id IS NOT NULL AND project_id IS NULL
      AND jsonb_typeof(data->'content')='string' AND length(btrim(data->>'content')) BETWEEN 1 AND 16000
      AND data ? 'completedAt' AND data ? 'deletedAt'
    WHEN 'project_meeting' THEN owner_id IS NULL AND project_id IS NOT NULL
      AND jsonb_typeof(data->'title')='string' AND length(btrim(data->>'title')) BETWEEN 1 AND 300
      AND jsonb_typeof(data->'description')='string'
      AND jsonb_typeof(data->'startsAt')='string' AND jsonb_typeof(data->'endsAt')='string'
      AND jsonb_typeof(data->'participantIds')='array'
      AND data ? 'cancelledAt' AND data ? 'cancelledBy' AND data ? 'cancellationReason'
    ELSE true
  END IS TRUE
);
