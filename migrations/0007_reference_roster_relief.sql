-- 0007_reference_roster_relief.sql
-- Explicit shift semantics, effective cross-team relief controls and fixed markers.
-- Existing schedules and credentials are preserved; no PINs or enrollment codes are created.

ALTER TABLE leave_requests ADD COLUMN leave_type TEXT NOT NULL DEFAULT 'L'
  CHECK (leave_type IN ('L','PL','ML','SL'));
ALTER TABLE staff_department_qualifications ADD COLUMN relief_only INTEGER NOT NULL DEFAULT 0
  CHECK (relief_only IN (0,1));
ALTER TABLE shift_assignments ADD COLUMN coverage_department_id TEXT REFERENCES departments(id);
ALTER TABLE shift_assignments ADD COLUMN coverage_shift_code TEXT;
ALTER TABLE staff ADD COLUMN employment_end_date TEXT;

CREATE TABLE IF NOT EXISTS shift_code_catalog (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('day','night','rest','leave','training','relief')),
  counts_as_work INTEGER NOT NULL CHECK (counts_as_work IN (0,1)),
  counts_as_leave INTEGER NOT NULL CHECK (counts_as_leave IN (0,1)),
  counts_toward_coverage INTEGER NOT NULL CHECK (counts_toward_coverage IN (0,1))
);
INSERT OR REPLACE INTO shift_code_catalog
  (code,label,category,counts_as_work,counts_as_leave,counts_toward_coverage) VALUES
  ('D','ISOC Day','day',1,0,1),
  ('N','ISOC Night','night',1,0,1),
  ('DC','SCE/SCM Day','day',1,0,1),
  ('NC','SCE/SCM Night','night',1,0,1),
  ('O','Off','rest',0,0,0),
  ('L','Leave (legacy/general)','leave',0,1,0),
  ('PL','Paternity Leave','leave',0,1,0),
  ('ML','Maternity Leave','leave',0,1,0),
  ('SL','Sick Leave','leave',0,1,0),
  ('T','Trainee','training',1,0,0),
  ('FSA','Field Supervisor Assignment','relief',1,0,0);

CREATE TABLE IF NOT EXISTS workforce_staff_designations (
  staff_id TEXT PRIMARY KEY REFERENCES staff(id),
  designation TEXT NOT NULL,
  relief_capable INTEGER NOT NULL DEFAULT 0 CHECK (relief_capable IN (0,1)),
  updated_by TEXT REFERENCES staff(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workforce_staff_markers (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  date TEXT NOT NULL,
  marker_code TEXT NOT NULL CHECK (marker_code IN ('T')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','cancelled')),
  created_by TEXT NOT NULL REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(staff_id,date)
);
CREATE INDEX IF NOT EXISTS idx_staff_markers_date_status
  ON workforce_staff_markers(date,status);

CREATE TABLE IF NOT EXISTS workforce_relief_assignments (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  duty_date TEXT NOT NULL,
  target_department_id TEXT NOT NULL REFERENCES departments(id),
  shift_code TEXT NOT NULL CHECK (shift_code IN ('D','N','DC','NC')),
  display_code TEXT NOT NULL CHECK (display_code IN ('D','N','DC','NC','FSA')),
  reason TEXT NOT NULL,
  shortage_count_at_request INTEGER,
  minimum_required INTEGER,
  shortage_confirmed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by TEXT NOT NULL REFERENCES staff(id),
  reviewed_by TEXT REFERENCES staff(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (display_code = shift_code OR display_code = 'FSA')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_relief_staff_date
  ON workforce_relief_assignments(staff_id,duty_date)
  WHERE status IN ('pending','approved');
CREATE INDEX IF NOT EXISTS idx_relief_target_date_status
  ON workforce_relief_assignments(target_department_id,duty_date,status);

-- Distinct employee identity: Mercy Dorice is operational; Mercy Wanyoike remains HR.
INSERT OR IGNORE INTO staff (id,name,department_id,active,role,pin_set)
VALUES ('mercy-dorice','Mercy Dorice','ISOC',1,'staff',0);
INSERT OR IGNORE INTO staff_shift_policies
  (staff_id,night_mode,max_consecutive_days,min_rest_hours,effective_from)
VALUES ('mercy-dorice','allowed',5,11,'2026-11-27');
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id,department_id,can_day,can_night,priority,effective_from,approval_note)
VALUES ('mercy-dorice','ISOC',1,1,100,'2026-11-27','Operational ISOC onboarding qualification');

-- Cross-qualified ISOC controllers can support SCE/SCM only through an explicit,
-- independently approved, date-specific relief allocation.
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id,department_id,can_day,can_night,priority,effective_from,approval_note,relief_only)
SELECT id,'SCE',1,1,900,'2026-11-27',
       'Cross-qualified SCE/SCM relief; approval required for each deployment',1
FROM staff WHERE id IN ('joan','benson','mercy-dorice');
UPDATE staff_department_qualifications SET relief_only=1
WHERE staff_id IN ('joan','benson','wayne') AND department_id='SCE' AND effective_to IS NULL;

-- Every active SCE member is qualified for ISOC relief, but never part of the
-- routine ISOC allocation pool. This applies to future SCE members as they are
-- added through HR (the qualification workflow enforces the same policy).
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id,department_id,can_day,can_night,priority,effective_from,approval_note,relief_only)
SELECT id,'ISOC',1,1,950,'2026-11-27',
       'SCE-to-ISOC emergency relief only; Duty Ops approval and reason required',1
FROM staff WHERE active=1 AND department_id='SCE';

-- Preserve the Technical Assistant's emergency-only night restriction.
UPDATE staff_department_qualifications SET can_day=1,can_night=1,relief_only=1
WHERE staff_id='wayne' AND department_id='SCE' AND effective_to IS NULL;

-- Clinton Juma is the Field Supervisor and can relieve either operational desk
-- on day or night, but is never added to normal staffing demand.
INSERT OR IGNORE INTO staff (id,name,department_id,active,role,pin_set)
VALUES ('clinton-juma','Clinton Juma','ROC',1,'staff',0);
INSERT OR IGNORE INTO staff_shift_policies
  (staff_id,night_mode,max_consecutive_days,min_rest_hours,effective_from)
VALUES ('clinton-juma','allowed',5,11,'2026-11-27');
INSERT OR IGNORE INTO workforce_staff_designations(staff_id,designation,relief_capable)
VALUES ('clinton-juma','Field Supervisor',1);
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id,department_id,can_day,can_night,priority,effective_from,approval_note,relief_only)
VALUES
  ('clinton-juma','ISOC',1,1,1000,'2026-11-27','Field Supervisor; scheduled only as approved relief',1),
  ('clinton-juma','SCE',1,1,1000,'2026-11-27','Field Supervisor; scheduled only as approved relief',1);

-- David resigned at the end of November. Retain every historic roster entry;
-- exclude him from forward allocation and revoke any remaining sessions.
UPDATE staff SET active=0, employment_end_date='2026-11-30' WHERE id='david';
DELETE FROM sessions WHERE staff_id='david';

-- Explicitly show the two Mercy records as distinct identities in HR data.


-- Capacity triggers close the race between simultaneous relief requests.
-- One receiving-desk shortage can only be allocated up to the uncovered minimum.
CREATE TRIGGER IF NOT EXISTS trg_relief_shortage_capacity_insert
BEFORE INSERT ON workforce_relief_assignments
WHEN NEW.status IN ('pending','approved')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM schedules sc
    WHERE sc.month = substr(NEW.duty_date,1,7)
      AND sc.department_id = NEW.target_department_id
  ) THEN RAISE(ABORT, 'Generate the receiving desk roster before requesting relief') END;

  SELECT CASE WHEN
    (
      SELECT COUNT(*) FROM shift_assignments sa
      WHERE sa.schedule_id = (
        SELECT sc.id FROM schedules sc
        WHERE sc.month = substr(NEW.duty_date,1,7)
          AND sc.department_id = NEW.target_department_id
        ORDER BY sc.generated_at DESC LIMIT 1
      )
      AND sa.date = NEW.duty_date
      AND sa.shift_code NOT IN ('O','L','PL','ML','SL')
      AND (
        (sa.coverage_department_id = NEW.target_department_id AND sa.coverage_shift_code = NEW.shift_code)
        OR (sa.coverage_department_id IS NULL AND sa.shift_code = NEW.shift_code)
      )
    )
    +
    (
      SELECT COUNT(*) FROM workforce_relief_assignments r
      WHERE r.target_department_id = NEW.target_department_id
        AND r.duty_date = NEW.duty_date
        AND r.shift_code = NEW.shift_code
        AND r.status IN ('pending','approved')
        AND NOT EXISTS (
          SELECT 1 FROM shift_assignments sa
          WHERE sa.schedule_id = (
            SELECT sc.id FROM schedules sc
            WHERE sc.month = substr(NEW.duty_date,1,7)
              AND sc.department_id = NEW.target_department_id
            ORDER BY sc.generated_at DESC LIMIT 1
          )
          AND sa.staff_id = r.staff_id AND sa.date = r.duty_date
          AND sa.coverage_department_id = r.target_department_id
          AND sa.coverage_shift_code = r.shift_code
        )
    )
    >= (
      SELECT CASE WHEN NEW.shift_code = d.day_code THEN d.day_min ELSE d.night_min END
      FROM departments d WHERE d.id = NEW.target_department_id
    )
    THEN RAISE(ABORT, 'No uncovered minimum remains for this relief request')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_relief_shortage_capacity_update
BEFORE UPDATE OF status ON workforce_relief_assignments
WHEN NEW.status IN ('pending','approved') AND OLD.status NOT IN ('pending','approved')
BEGIN
  SELECT CASE WHEN
    (
      SELECT COUNT(*) FROM shift_assignments sa
      WHERE sa.schedule_id = (
        SELECT sc.id FROM schedules sc
        WHERE sc.month = substr(NEW.duty_date,1,7)
          AND sc.department_id = NEW.target_department_id
        ORDER BY sc.generated_at DESC LIMIT 1
      )
      AND sa.date = NEW.duty_date
      AND sa.shift_code NOT IN ('O','L','PL','ML','SL')
      AND (
        (sa.coverage_department_id = NEW.target_department_id AND sa.coverage_shift_code = NEW.shift_code)
        OR (sa.coverage_department_id IS NULL AND sa.shift_code = NEW.shift_code)
      )
    )
    +
    (
      SELECT COUNT(*) FROM workforce_relief_assignments r
      WHERE r.id <> OLD.id
        AND r.target_department_id = NEW.target_department_id
        AND r.duty_date = NEW.duty_date
        AND r.shift_code = NEW.shift_code
        AND r.status IN ('pending','approved')
        AND NOT EXISTS (
          SELECT 1 FROM shift_assignments sa
          WHERE sa.schedule_id = (
            SELECT sc.id FROM schedules sc
            WHERE sc.month = substr(NEW.duty_date,1,7)
              AND sc.department_id = NEW.target_department_id
            ORDER BY sc.generated_at DESC LIMIT 1
          )
          AND sa.staff_id = r.staff_id AND sa.date = r.duty_date
          AND sa.coverage_department_id = r.target_department_id
          AND sa.coverage_shift_code = r.shift_code
        )
    )
    >= (
      SELECT CASE WHEN NEW.shift_code = d.day_code THEN d.day_min ELSE d.night_min END
      FROM departments d WHERE d.id = NEW.target_department_id
    )
    THEN RAISE(ABORT, 'No uncovered minimum remains for this relief approval')
  END;
END;


-- Staff-specific, effective-dated rotation patterns. Codes are stored as a
-- weekly/rolling cycle and anchored to an explicit calendar date.
CREATE TABLE IF NOT EXISTS workforce_rotation_patterns (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  department_id TEXT NOT NULL REFERENCES departments(id),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  anchor_date TEXT NOT NULL,
  cycle_codes_json TEXT NOT NULL
    CHECK (json_valid(cycle_codes_json) AND json_type(cycle_codes_json) = 'array'
      AND json_array_length(cycle_codes_json) BETWEEN 1 AND 28),
  created_by TEXT NOT NULL REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE(staff_id, department_id, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_rotation_patterns_effective
  ON workforce_rotation_patterns(department_id,staff_id,effective_from,effective_to);
ALTER TABLE shift_assignments ADD COLUMN assignment_source TEXT NOT NULL DEFAULT 'generated'
  CHECK (assignment_source IN ('generated','rotation','training','relief','field_supervisor','duty_ops','manual'));


-- Close the API pre-check race: leave, training and relief are mutually exclusive
-- at the D1 write boundary, not merely in UI validation.

CREATE TRIGGER IF NOT EXISTS trg_leave_no_training_or_relief_insert
BEFORE INSERT ON leave_requests
WHEN NEW.status IN ('pending','approved')
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM workforce_relief_assignments r
    WHERE r.staff_id=NEW.staff_id AND r.duty_date=NEW.date
      AND r.status IN ('pending','approved')
  ) THEN RAISE(ABORT, 'Leave conflicts with a pending or approved relief deployment') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM workforce_staff_markers m
    WHERE m.staff_id=NEW.staff_id AND m.date=NEW.date
      AND m.marker_code='T' AND m.status='approved'
  ) THEN RAISE(ABORT, 'Leave conflicts with an approved trainee assignment') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_leave_no_training_or_relief_update
BEFORE UPDATE OF staff_id,date,status ON leave_requests
WHEN NEW.status IN ('pending','approved')
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM workforce_relief_assignments r
    WHERE r.staff_id=NEW.staff_id AND r.duty_date=NEW.date
      AND r.status IN ('pending','approved')
  ) THEN RAISE(ABORT, 'Leave conflicts with a pending or approved relief deployment') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM workforce_staff_markers m
    WHERE m.staff_id=NEW.staff_id AND m.date=NEW.date
      AND m.marker_code='T' AND m.status='approved'
  ) THEN RAISE(ABORT, 'Leave conflicts with an approved trainee assignment') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_training_no_leave_or_relief_insert
BEFORE INSERT ON workforce_staff_markers
WHEN NEW.status='approved' AND NEW.marker_code='T'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM leave_requests l
    WHERE l.staff_id=NEW.staff_id AND l.date=NEW.date
      AND l.status IN ('pending','approved')
  ) THEN RAISE(ABORT, 'Training conflicts with pending or approved leave') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM workforce_relief_assignments r
    WHERE r.staff_id=NEW.staff_id AND r.duty_date=NEW.date
      AND r.status IN ('pending','approved')
  ) THEN RAISE(ABORT, 'Training conflicts with a pending or approved relief deployment') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM shift_assignments sa
    JOIN schedules sc ON sc.id=sa.schedule_id
    WHERE sa.staff_id=NEW.staff_id AND sa.date=NEW.date
      AND sa.shift_code NOT IN ('O','L','PL','ML','SL')
      AND sc.id=(
        SELECT latest.id FROM schedules latest
        WHERE latest.month=sc.month AND latest.department_id=sc.department_id
        ORDER BY latest.generated_at DESC LIMIT 1
      )
  ) THEN RAISE(ABORT, 'Training conflicts with an existing rostered assignment') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_training_no_leave_or_relief_update
BEFORE UPDATE OF staff_id,date,status,marker_code ON workforce_staff_markers
WHEN NEW.status='approved' AND NEW.marker_code='T'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM leave_requests l
    WHERE l.staff_id=NEW.staff_id AND l.date=NEW.date
      AND l.status IN ('pending','approved')
  ) THEN RAISE(ABORT, 'Training conflicts with pending or approved leave') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM workforce_relief_assignments r
    WHERE r.staff_id=NEW.staff_id AND r.duty_date=NEW.date
      AND r.status IN ('pending','approved')
  ) THEN RAISE(ABORT, 'Training conflicts with a pending or approved relief deployment') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_relief_no_leave_or_training_insert
BEFORE INSERT ON workforce_relief_assignments
WHEN NEW.status IN ('pending','approved')
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM leave_requests l
    WHERE l.staff_id=NEW.staff_id AND l.date=NEW.duty_date
      AND l.status IN ('pending','approved')
  ) THEN RAISE(ABORT, 'Relief conflicts with pending or approved leave') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM workforce_staff_markers m
    WHERE m.staff_id=NEW.staff_id AND m.date=NEW.duty_date
      AND m.marker_code='T' AND m.status='approved'
  ) THEN RAISE(ABORT, 'Relief conflicts with an approved trainee assignment') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM shift_assignments sa
    JOIN schedules sc ON sc.id=sa.schedule_id
    WHERE sa.staff_id=NEW.staff_id AND sa.date=NEW.duty_date
      AND sa.shift_code NOT IN ('O','L','PL','ML','SL')
      AND NOT (
        sa.coverage_department_id=NEW.target_department_id
        AND sa.coverage_shift_code=NEW.shift_code
      )
      AND sc.id=(
        SELECT latest.id FROM schedules latest
        WHERE latest.month=sc.month AND latest.department_id=sc.department_id
        ORDER BY latest.generated_at DESC LIMIT 1
      )
  ) THEN RAISE(ABORT, 'Relief conflicts with an existing rostered assignment') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_relief_no_leave_or_training_update
BEFORE UPDATE OF staff_id,duty_date,status,target_department_id,shift_code ON workforce_relief_assignments
WHEN NEW.status IN ('pending','approved')
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM leave_requests l
    WHERE l.staff_id=NEW.staff_id AND l.date=NEW.duty_date
      AND l.status IN ('pending','approved')
  ) THEN RAISE(ABORT, 'Relief conflicts with pending or approved leave') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM workforce_staff_markers m
    WHERE m.staff_id=NEW.staff_id AND m.date=NEW.duty_date
      AND m.marker_code='T' AND m.status='approved'
  ) THEN RAISE(ABORT, 'Relief conflicts with an approved trainee assignment') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM shift_assignments sa
    JOIN schedules sc ON sc.id=sa.schedule_id
    WHERE sa.staff_id=NEW.staff_id AND sa.date=NEW.duty_date
      AND sa.shift_code NOT IN ('O','L','PL','ML','SL')
      AND NOT (
        sa.coverage_department_id=NEW.target_department_id
        AND sa.coverage_shift_code=NEW.shift_code
      )
      AND sc.id=(
        SELECT latest.id FROM schedules latest
        WHERE latest.month=sc.month AND latest.department_id=sc.department_id
        ORDER BY latest.generated_at DESC LIMIT 1
      )
  ) THEN RAISE(ABORT, 'Relief conflicts with an existing rostered assignment') END;
END;
