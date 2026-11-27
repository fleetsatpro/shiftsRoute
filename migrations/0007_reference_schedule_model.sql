-- 0007_reference_schedule_model.sql
-- Reference roster semantics, employment windows and strict cross-team relief.
-- No credentials or PINs are created.

ALTER TABLE staff ADD COLUMN employment_start TEXT;
ALTER TABLE staff ADD COLUMN employment_end TEXT;
ALTER TABLE staff ADD COLUMN position_title TEXT;
ALTER TABLE staff_department_qualifications
  ADD COLUMN allocation_mode TEXT NOT NULL DEFAULT 'standard'
  CHECK (allocation_mode IN ('standard','critical_shortage_only'));
ALTER TABLE leave_requests
  ADD COLUMN leave_code TEXT NOT NULL DEFAULT 'L'
  CHECK (leave_code IN ('L','PL','ML','SL'));

-- Historical November roster remains available through David's final service date.
UPDATE staff SET employment_end = '2026-11-30' WHERE id = 'david';

-- Mercy Dorice is an operational ISOC member; Mercy Wanyoike remains HR.
INSERT OR IGNORE INTO staff
  (id, name, department_id, active, role, pin_set, employment_start)
VALUES ('mercy-dorice', 'Mercy Dorice', 'ISOC', 1, 'staff', 0, '2026-07-01');

-- Clinton Juma is the Field Supervisor shown as FSA in the reference rosters.
INSERT OR IGNORE INTO staff
  (id, name, department_id, active, role, pin_set, employment_start, position_title)
VALUES ('clinton-juma', 'Clinton Juma', 'ISOC', 1, 'staff', 0, '2026-08-01', 'Field Supervisor');

INSERT OR IGNORE INTO staff_shift_policies
  (staff_id, night_mode, max_consecutive_days, min_rest_hours, effective_from)
VALUES
  ('mercy-dorice', 'allowed', 5, 11, '2026-07-01'),
  ('clinton-juma', 'allowed', 5, 11, '2026-08-01');

INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id, department_id, can_day, can_night, priority, effective_from, approval_note)
VALUES
  ('mercy-dorice', 'ISOC', 1, 1, 100, '2026-07-01', 'Operational ISOC qualification from reference roster');

-- Every SCE/SCM member is ISOC-qualified for critical-minimum relief only.
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id, department_id, can_day, can_night, priority, effective_from, approval_note, allocation_mode)
SELECT id, 'ISOC', 1, 1, 1000, '2026-06-01',
       'SCE/SCM cross-qualified for ISOC only when home-team minimum cannot be met',
       'critical_shortage_only'
FROM staff WHERE department_id = 'SCE';

-- Existing 0006 rows for Benson, Joan and Wayne must be tightened, not ignored.
UPDATE staff_department_qualifications
SET allocation_mode = 'critical_shortage_only', priority = 1000
WHERE staff_id IN ('benson','joan','wayne')
  AND department_id = 'SCE' AND effective_to IS NULL;

-- ISOC members can relieve SCE/SCM only for a true minimum deficit.
-- Wayne's emergency-only night setting is not relaxed.
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id, department_id, can_day, can_night, priority, effective_from, approval_note, allocation_mode)
VALUES
  ('benson', 'SCE', 1, 1, 1000, '2026-11-27', 'ISOC cross-qualified for critical SCE/SCM relief only', 'critical_shortage_only'),
  ('joan', 'SCE', 1, 1, 1000, '2026-11-27', 'ISOC cross-qualified for critical SCE/SCM relief only', 'critical_shortage_only'),
  ('wayne', 'SCE', 1, 1, 1000, '2026-11-27', 'ISOC cross-qualified for critical SCE/SCM relief only; night policy remains exception-only', 'critical_shortage_only'),
  ('mercy-dorice', 'SCE', 1, 1, 1000, '2026-11-27', 'ISOC cross-qualified for critical SCE/SCM relief only', 'critical_shortage_only');

-- Clinton is Field Supervisor and can relieve either desk on day or night shifts.
INSERT OR IGNORE INTO staff_department_qualifications
  (staff_id, department_id, can_day, can_night, priority, effective_from, approval_note, allocation_mode)
VALUES
  ('clinton-juma', 'ISOC', 1, 1, 1000, '2026-08-01', 'Field Supervisor relief capacity for ISOC day/night', 'critical_shortage_only'),
  ('clinton-juma', 'SCE', 1, 1, 1000, '2026-08-01', 'Field Supervisor relief capacity for SCE/SCM day/night', 'critical_shortage_only');

-- DOMs cover either team through an explicit Duty Ops allocation or a genuine shortage,
-- never as routine extra day-shift capacity.
UPDATE staff_department_qualifications
SET allocation_mode = 'critical_shortage_only'
WHERE staff_id IN ('hilda','mukasa')
  AND department_id IN ('ISOC','SCE') AND effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_qual_allocation_mode
  ON staff_department_qualifications(department_id, allocation_mode, effective_from, effective_to);
