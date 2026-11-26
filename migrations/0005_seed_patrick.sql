-- 0005_seed_patrick.sql
-- Patrick's row depends on role/pin_set columns introduced by 0002_auth.
INSERT INTO staff (id, name, department_id, active, role, pin_set)
SELECT 'patrick', 'Patrick', 'SCE', 1, 'staff', 0
WHERE NOT EXISTS (SELECT 1 FROM staff WHERE id = 'patrick');
