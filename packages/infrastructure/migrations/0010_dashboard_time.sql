-- Private timer references live in data so losing project access cannot prevent
-- stopping one's own timer. Readers redact references against current core access.
CREATE UNIQUE INDEX dashboard_time_active_timer_unique ON dashboard_records(workspace_id,owner_id)
  WHERE kind='time_timer' AND data->>'stoppedAt' IS NULL;
CREATE UNIQUE INDEX dashboard_time_timer_worklog_unique ON dashboard_records(workspace_id,(data->>'timerId'))
  WHERE kind='time_worklog' AND data->>'timerId' IS NOT NULL;
CREATE UNIQUE INDEX dashboard_presence_preference_unique ON dashboard_records(workspace_id,owner_id) WHERE kind='presence_preference';
CREATE UNIQUE INDEX dashboard_presence_heartbeat_unique ON dashboard_records(workspace_id,owner_id) WHERE kind='presence_heartbeat';

CREATE FUNCTION pm_validate_dashboard_time_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE started timestamptz; ended timestamptz; timer dashboard_records%ROWTYPE; worklog dashboard_records%ROWTYPE;
BEGIN
  IF NEW.kind NOT IN ('time_timer','time_worklog','presence_preference','presence_heartbeat') THEN RETURN NEW; END IF;
  IF NEW.owner_id IS NULL OR NEW.project_id IS NOT NULL OR NEW.created_by<>NEW.owner_id THEN
    RAISE EXCEPTION 'time records require private owner scope' USING ERRCODE='23514', CONSTRAINT='dashboard_time_owner_scope';
  END IF;
  IF NEW.kind='time_timer' THEN
    started := (NEW.data->>'startedAt')::timestamptz;
    ended := (NEW.data->>'stoppedAt')::timestamptz;
    IF started IS NULL OR NEW.data->>'taskId' IS NULL OR NEW.data->>'projectId' IS NULL
      OR (ended IS NULL) <> (NEW.data->>'worklogId' IS NULL) OR ended<started THEN
      RAISE EXCEPTION 'invalid timer interval' USING ERRCODE='23514', CONSTRAINT='dashboard_time_interval';
    END IF;
    IF ended IS NOT NULL THEN
      SELECT * INTO worklog FROM dashboard_records WHERE workspace_id=NEW.workspace_id AND id=(NEW.data->>'worklogId')::uuid;
      IF NOT FOUND OR worklog.kind<>'time_worklog' OR worklog.owner_id IS DISTINCT FROM NEW.owner_id OR worklog.data->>'timerId' IS DISTINCT FROM NEW.id::text
        OR worklog.data->>'startedAt' IS DISTINCT FROM NEW.data->>'startedAt' OR worklog.data->>'endedAt' IS DISTINCT FROM NEW.data->>'stoppedAt' THEN
        RAISE EXCEPTION 'timer stop requires its worklog' USING ERRCODE='23514', CONSTRAINT='dashboard_time_stop_worklog';
      END IF;
    END IF;
  ELSIF NEW.kind='time_worklog' THEN
    started := (NEW.data->>'startedAt')::timestamptz;
    ended := (NEW.data->>'endedAt')::timestamptz;
    IF started IS NULL OR ended IS NULL OR ended<started OR NEW.data->>'taskId' IS NULL OR NEW.data->>'projectId' IS NULL
      OR NEW.data->>'source' IS NULL OR NEW.data->>'source' NOT IN ('manual','timer')
      OR (NEW.data->>'durationMs')::numeric IS DISTINCT FROM extract(epoch FROM ended-started)*1000
      OR (NEW.data->>'source'='manual' AND (ended=started OR NEW.data->>'timerId' IS NOT NULL))
      OR (NEW.data->>'source'='timer' AND NEW.data->>'timerId' IS NULL) THEN
      RAISE EXCEPTION 'invalid worklog interval' USING ERRCODE='23514', CONSTRAINT='dashboard_time_interval';
    END IF;
    IF NEW.data->>'timerId' IS NOT NULL THEN
      SELECT * INTO timer FROM dashboard_records WHERE workspace_id=NEW.workspace_id AND id=(NEW.data->>'timerId')::uuid;
      IF NOT FOUND OR timer.kind<>'time_timer' OR timer.owner_id IS DISTINCT FROM NEW.owner_id OR timer.data->>'worklogId' IS DISTINCT FROM NEW.id::text
        OR timer.data->>'taskId' IS DISTINCT FROM NEW.data->>'taskId' OR timer.data->>'projectId' IS DISTINCT FROM NEW.data->>'projectId' THEN
        RAISE EXCEPTION 'worklog requires its stopped timer' USING ERRCODE='23514', CONSTRAINT='dashboard_time_stop_worklog';
      END IF;
    END IF;
  ELSIF NEW.kind='presence_preference' THEN
    IF NEW.data->>'preference' IS NULL OR NEW.data->>'preference' NOT IN ('online','away') THEN
      RAISE EXCEPTION 'invalid presence preference' USING ERRCODE='23514', CONSTRAINT='dashboard_presence_preference';
    END IF;
  ELSIF NEW.kind='presence_heartbeat' THEN
    IF (NEW.data->>'heartbeatAt')::timestamptz IS NULL THEN
      RAISE EXCEPTION 'heartbeat time required' USING ERRCODE='23514', CONSTRAINT='dashboard_presence_heartbeat';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER dashboard_time_validation AFTER INSERT OR UPDATE ON dashboard_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pm_validate_dashboard_time_record();

CREATE FUNCTION pm_guard_dashboard_time_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind='time_worklog' THEN
    RAISE EXCEPTION 'worklogs are immutable' USING ERRCODE='23514', CONSTRAINT='dashboard_time_worklog_immutable';
  END IF;
  IF OLD.kind='time_timer' AND (OLD.data->>'stoppedAt' IS NOT NULL OR
    NEW.data-ARRAY['stoppedAt','worklogId'] IS DISTINCT FROM OLD.data-ARRAY['stoppedAt','worklogId'] OR NEW.data->>'stoppedAt' IS NULL) THEN
    RAISE EXCEPTION 'timer identity and stopped history are immutable' USING ERRCODE='23514', CONSTRAINT='dashboard_time_timer_immutable';
  END IF;
  IF OLD.kind='presence_heartbeat' AND (NEW.data->>'heartbeatAt')::timestamptz < (OLD.data->>'heartbeatAt')::timestamptz THEN
    RAISE EXCEPTION 'heartbeat cannot move backwards' USING ERRCODE='23514', CONSTRAINT='dashboard_presence_monotonic';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dashboard_time_history_guard BEFORE UPDATE ON dashboard_records FOR EACH ROW EXECUTE FUNCTION pm_guard_dashboard_time_history();
