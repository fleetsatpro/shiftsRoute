# Reference roster semantics

This document is the operational code and coverage contract used by ShiftsRoute. The supplied monthly reference schedules take precedence over generic roster assumptions.

## Shift-code contract

| Code | Meaning | Counts as work | Counts as independent desk coverage |
|---|---|---:|---:|
| D | ISOC day | Yes | Yes, ISOC day |
| N | ISOC night | Yes | Yes, ISOC night |
| DC | SCE/SCM day | Yes | Yes, SCE/SCM day |
| NC | SCE/SCM night | Yes | Yes, SCE/SCM night |
| O | Off/rest day | No | No |
| L | General/legacy leave | No | No |
| PL | Paternity leave | No | No |
| ML | Maternity leave | No | No |
| SL | Sick leave | No | No |
| T | Supervised trainee assignment | Yes | No, trainee is not independent headcount |
| FSA | Field Supervisor assignment | Yes | Only the target desk/shift stored in coverage metadata |

An unknown code is a data-quality fault. It must remain visibly unknown; it must never become O or be counted as rest.

The visible code and the actual coverage assignment are intentionally separate. For an FSA cell, coverage_department_id and coverage_shift_code identify the desk and shift being relieved. This means a Field Supervisor can display FSA while contributing to one precise day/night minimum.

## Cross-desk relief policy

Cross-qualification is not routine roster eligibility. A relief-only qualification proves that an employee may be considered for a named desk; it does not allow the solver to select them automatically.

A cross-desk request requires:
1. An already-generated receiving-desk roster for the requested month.
2. An uncovered minimum for the exact date and day/night code after counting ordinary staff and pending/approved relief.
3. An active employee with an effective-dated relief-only qualification for the requested desk and shift.
4. No pending/approved leave, trainee marker, same-date duty, active relief or conflicting rotation.
5. Compliance with the employee's night-work policy, the stricter of the home and receiving desk night-to-day recovery rules, and maximum consecutive work-day limit across both teams.
6. A reason describing the operational shortage.
7. Approval by a different Duty Ops Manager or the platform administrator.

Pending and approved requests reserve one slot of the remaining shortage. D1 capacity triggers prevent simultaneous requests from exceeding that minimum. Additional D1 triggers make pending/approved leave, trainee markers and relief mutually exclusive at the database write boundary, even if two requests race. The API rechecks shortage and eligibility at approval; the receiving desk must be regenerated after approval to materialize the relief into its roster. The employee's home-team schedule is also regenerated so the borrowed day remains visible without being counted twice.

## Named workforce records

- Mercy Wanyoike is HR; Mercy Dorice is a distinct operational ISOC staff member.
- Joan, Benson, Wayne and Mercy Dorice have SCE relief-only qualifications.
- Active SCE staff have ISOC relief-only qualifications. Future SCE staff receive this at onboarding after their home-team qualification is created.
- Clinton Juma is recorded as Field Supervisor and relief-capable for ISOC and SCE/SCM, day and night. His approved deployments use FSA display semantics.
- Hilda and Mukasa are Duty Ops Managers. They are not normal controller candidates; a manager appears in a team roster only on an explicit day-duty team-cover assignment.
- David's employment end date is 30 November 2026. His account is inactive for future scheduling; historic schedules remain retained.

## Release boundary and verification

Draft PR #5 adds migration 0007. Production D1 has migrations 0001–0006; 0007 is not applied by this branch. Do not issue staff credentials, modify live schedules, run the production migration or deploy this branch as part of PR validation.

The CI acceptance surface includes:
- Solver tests for typed leave/training/FSA states, relief-only exclusion, locked rotations, rest and deterministic balancing.
- Worker + isolated local D1 tests for eligibility, shortage enforcement, independent approval, home/receiving roster mirroring, both Field Supervisor desks/shifts, Mercy identity separation and David's retained history.
- Desktop and mobile browser acceptance.
