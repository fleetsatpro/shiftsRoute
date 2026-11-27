-- 0006_workforce_operating_model.sql
-- Data-driven workforce roles, qualifications, shift policies and Duty Ops rota.
-- This migration preserves historical assignments and does not set credentials.

ALTER TABLE departments ADD COLUMN operational_team INTEGER NOT NULL DEFAULT 1;
INSERT INTO departments
  (id, name, day_min, day_max, night_min, night_max, day_code, night_code,
   night_rest_rule, weekend_staffed, operational_team)
SELECT 'ROC', 'ROC Operations Management', 0, 0, 0, 0, 'MD', 'MN', 1, 1, 0
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE id = 'ROC');
INSERT INTO departments
  (id, name, day_min, day_max, night_min, night_max, day_code, night_code,
   night_rest_rule, weekend_staffed, operational_team)
SELECT 'HR', 'Human Resources', 0, 0, 0, 0, 'HRD', 'HRN', 1, 0, 0
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE id = 'HR');

CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

INSERT OR IGNORE INTO role_permissions (role, permission) VALUES
  ('admin', 'system.configure'),
  ('admin', 'staff.manage'),
  ('admin', 'roles.manage'),
  ('admin', 'schedules.generate'),
  ('admin', 'schedules.publish'),
  ('admin', 'exceptions.approve'),
  ('admin', 'audit.read'),
  ('admin', 'roster.read'),
  ('admin', 'coverage.read'),
  ('admin', 'coverage.allocate'),
  ('admin', 'handover.manage'),
  ('admin', 'exceptions.request'),
  ('admin', 'exceptions.review'),
  ('hr', 'staff.read'),
  ('hr', 'staff.lifecycle'),
  ('hr', 'leave.manage'),
  ('hr', 'availability.manage'),
  ('hr', 'qualifications.manage'),
  ('hr', 'hr_reports.read'),
  ('duty_ops_manager', 'system.configure'),
  ('duty_ops_manager', 'staff.manage'),
  ('duty_ops_manager', 'roles.manage'),
  ('duty_ops_manager', 'schedules.generate'),
  ('duty_ops_manager', 'schedules.publish'),
  ('duty_ops_manager', 'exceptions.approve'),
  ('duty_ops_manager', 'audit.read'),
  ('duty_ops_manager', 'roster.read'),
  ('duty_ops_manager', 'coverage.read'),
  ('duty_ops_manager', 'coverage.allocate'),
  ('duty_ops_manager', 'handover.manage'),
  ('duty_ops_manager', 'exceptions.request'),
  ('duty_ops_manager', 'exceptions.review'),
  ('technical_assistant', 'roster.read'),
  ('technical_assistant', 'technical.workspace'),
  ('staff', 'roster.self'),
  ('staff', 'leave.self'),
  ('staff', 'swaps.self');

CREATE TABLE IF NOT EXISTS role_hierarchy (
  role TEXT PRIMARY KEY,
  authority_level INTEGER NOT NULL UNIQUE,
  description TEXT NOT NULL
);
INSERT OR REPLACE INTO role_hierarchy (role, authority_level, description) VALUES
  ('admin', 1000, 'System owner / platform administrator'),
  ('duty_ops_manager', 900, 'Duty Ops Manager; full administrative authority, operationally superior to all controllers'),
  ('hr', 700, 'Human Resources'),
  ('technical_assistant', 400, 'Technical Assistant'),
  ('staff', 300, 'Controller / operational staff');

CREATE TABLE IF NOT EXISTS staff_department_qualifications (
  staff_id TEXT NOT NULL REFERENCES staff(id),
  department_id TEXT NOT NULL REFERENCES departments(id),
  can_day INTEGER NOT NULL DEFAULT 1 CHECK (can_day IN (0,1)),
  can_night INTEGER NOT NULL DEFAULT 1 CHECK (can_night IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 100,
  effective_from TEXT NOT NULL DEFAULT '2026-01-01',
  effective_to TEXT,
  approved_by TEXT REFERENCES staff(id),
  approval_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (staff_id, department_id, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_staff_qual_dept
  ON staff_department_qualifications(department_id, can_day, can_night, effective_from, effective_to);

-- Every existing staff member receives an explicit qualification for their home team.
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id, department_id, can_day, can_night, priority, effective_from, approval_note)
SELECT id, department_id, 1, 1, 100, '2026-01-01', 'Migrated home-team qualification'
FROM staff WHERE active = 1 AND department_id IN ('ISOC', 'SCE');

CREATE TABLE IF NOT EXISTS staff_shift_policies (
  staff_id TEXT PRIMARY KEY REFERENCES staff(id),
  night_mode TEXT NOT NULL DEFAULT 'allowed'
    CHECK (night_mode IN ('allowed','restricted','exception_only','prohibited')),
  max_consecutive_days INTEGER NOT NULL DEFAULT 5,
  min_rest_hours INTEGER NOT NULL DEFAULT 11,
  max_weekly_hours REAL,
  effective_from TEXT NOT NULL DEFAULT '2026-01-01',
  effective_to TEXT,
  updated_by TEXT REFERENCES staff(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO staff_shift_policies (staff_id, night_mode, max_consecutive_days, min_rest_hours, effective_from)
SELECT id, 'allowed', 5, 11, '2026-01-01' FROM staff WHERE active = 1;

CREATE TABLE IF NOT EXISTS duty_ops_assignments (
  id TEXT PRIMARY KEY,
  duty_date TEXT NOT NULL UNIQUE,
  manager_staff_id TEXT REFERENCES staff(id),
  assignment_type TEXT NOT NULL DEFAULT 'floating'
    CHECK (assignment_type IN ('floating','team_cover')),
  coverage_department_id TEXT REFERENCES departments(id),
  shift_code TEXT NOT NULL DEFAULT 'MD',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned','confirmed','exception')),
  created_by TEXT REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (assignment_type = 'floating' AND coverage_department_id IS NULL)
    OR (assignment_type = 'team_cover' AND coverage_department_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_duty_ops_manager_date
  ON duty_ops_assignments(manager_staff_id, duty_date);

-- Initial workforce configuration requested by operations.
UPDATE staff SET role = 'admin', name = 'Griffin' WHERE id = 'griffin';
UPDATE staff SET role = 'duty_ops_manager' WHERE id = 'hilda';
UPDATE staff SET role = 'technical_assistant' WHERE id = 'wayne';
UPDATE staff SET active = 0 WHERE id = 'david';

INSERT OR IGNORE INTO staff (id, name, department_id, active, role, pin_set)
VALUES
  ('mukasa', 'Mukasa', 'ROC', 1, 'duty_ops_manager', 0),
  ('mercy', 'Mercy Wanyoike', 'HR', 1, 'hr', 0),
  ('cate', 'Cate', 'ISOC', 1, 'staff', 0),
  ('oliera', 'Oliera', 'ISOC', 1, 'staff', 0);

INSERT OR IGNORE INTO staff_shift_policies (staff_id, night_mode, max_consecutive_days, min_rest_hours, effective_from)
SELECT id, 'allowed', 5, 11, '2026-11-27' FROM staff WHERE id IN ('mukasa','mercy','cate','oliera');

-- Duty Ops Managers can provide day coverage to either operational team.
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id, department_id, can_day, can_night, priority, effective_from, approval_note)
VALUES
  ('hilda', 'ISOC', 1, 0, 20, '2026-11-27', 'Duty Ops Manager day-cover eligibility'),
  ('hilda', 'SCE', 1, 0, 20, '2026-11-27', 'Duty Ops Manager day-cover eligibility'),
  ('mukasa', 'ISOC', 1, 0, 20, '2026-11-27', 'Duty Ops Manager day-cover eligibility'),
  ('mukasa', 'SCE', 1, 0, 20, '2026-11-27', 'Duty Ops Manager day-cover eligibility');

-- Technical Assistant: day-only cross-team support by default.
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id, department_id, can_day, can_night, priority, effective_from, approval_note)
VALUES
  ('wayne', 'ISOC', 1, 0, 50, '2026-11-27', 'Technical Assistant day-cover eligibility'),
  ('wayne', 'SCE', 1, 0, 50, '2026-11-27', 'Technical Assistant day-cover eligibility');
UPDATE staff_shift_policies SET night_mode = 'exception_only'
WHERE staff_id = 'wayne';

-- Cross-trained SCE support: home-team membership is retained.
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id, department_id, can_day, can_night, priority, effective_from, approval_note)
VALUES
  ('benson', 'SCE', 1, 1, 60, '2026-11-27', 'Cross-trained at SCE; rotation and shortage support'),
  ('joan', 'SCE', 1, 1, 60, '2026-11-27', 'Cross-trained at SCE; rotation and shortage support');

-- New ISOC staff receive standard home-team eligibility. Mercy Wanyoike is HR and is not placed on the ISOC roster.
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id, department_id, can_day, can_night, priority, effective_from, approval_note)
SELECT id, 'ISOC', 1, 1, 100, '2026-11-27', 'ISOC onboarding qualification'
FROM staff WHERE id IN ('cate','oliera');

-- Hilda's existing home-team row is updated to day-only, consistent with the
-- Duty Ops day-coverage policy; all policy changes remain editable in HR/Admin UI.
UPDATE staff_department_qualifications
SET can_day = 1, can_night = 0, priority = 20
WHERE staff_id = 'hilda' AND department_id = 'ISOC' AND effective_to IS NULL;

-- No initial Duty Ops assignments are fabricated. The rota generator must
-- create a complete, validated daily rotation before publication.

CREATE TABLE IF NOT EXISTS workforce_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL REFERENCES staff(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workforce_audit_created ON workforce_audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_workforce_audit_entity ON workforce_audit_events(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS workforce_shift_exceptions (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  date TEXT NOT NULL,
  shift_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by TEXT NOT NULL REFERENCES staff(id),
  reviewed_by TEXT REFERENCES staff(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(staff_id, date, shift_code)
);
CREATE INDEX IF NOT EXISTS idx_shift_exceptions_date_status
  ON workforce_shift_exceptions(date, status);
