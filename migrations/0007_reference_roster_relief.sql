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
