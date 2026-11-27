# ROC Workforce Operating Model

Status: implementation and release specification for PR #2. The workforce schema, core Worker APIs, solver eligibility controls, HR workspace and Duty Ops workspace are implemented on the feature branch. Production migration and deployment remain separate release steps.

## Product goals

1. Keep staff login simple: staff selection/identifier plus a short PIN, with first-use enrollment initiated by an administrator. Do not expose security complexity to staff.
2. Keep security and policy enforcement on the server. Browser visibility is never authorization.
3. Make roster membership, cross-training, shift eligibility, roles, staffing demand, exception approvals, and duty rotation data-driven.
4. Make every schedule explainable: show why each assignment was selected, which constraints applied, where support staff were borrowed, and any uncovered demand.
5. Never silently solve a shortage by violating a rest rule or a person's shift restriction.

## Role and access model

Use explicit permission capabilities rather than checking names or relying on a single `isAdmin` boolean.

- `admin`: system-wide configuration, staff and role administration, schedule generation/publishing, exception approvals, audit access.
- `hr`: staff lifecycle, leave/availability administration, employee records and HR reports; no authentication-secret access, no unrestricted schedule publication, and no security-policy editing.
- `duty_ops_manager`: full administrative capabilities equivalent to the admin permission set, plus daily duty desk, operational coverage, cross-team allocation, shortage and exception review, and handover. DOMs are the senior operational authority over all controllers and operational staff. The system owner/admin retains top-level platform ownership and can manage platform-wide identity/security controls.
- `technical_assistant`: technical support workspace and eligible coverage where configured; no HR or staff administration.
- `staff`: personal roster, leave requests, shift swaps, handover notices and own profile.

Permissions must be evaluated in API handlers and tested for every protected route. Interfaces are capability-filtered but are not a security boundary.

## Workforce data model

Store policy as records, not name-based branches in application code.

- Staff record: identity, active state, home department, role, account status.
- Department qualification: staff member, department, eligible day/night shifts, priority, effective dates, approving actor and evidence/reference.
- Shift policy: maximum consecutive work days, minimum rest between shifts, night-rest rule, weekly/period hour limits, night eligibility, emergency-only flag and effective dates.
- Coverage demand: per department, date pattern, shift, minimum/maximum headcount and required capabilities.
- Duty Ops rota: one daily day-duty assignment, manager, assignment type (floating or team-cover), coverage department when filling a shortage, reason and approval metadata.
- Schedule run: policy snapshot/version, solver version, input snapshot, objective score, hard-constraint results, soft-constraint/fairness metrics, warnings and audit trail.
- Exceptions: requested by, approved by, reason, affected person/date/shift, expiry and before/after values.

Changes to qualifications are effective-dated so historical schedules remain explainable. Shift-policy records currently store the configured minimum-rest target; exact hour-based rest enforcement requires department shift start/end windows to be configured. The solver currently enforces the department night-to-day rest rule and per-person maximum consecutive work days.

## Initial workforce configuration requested

- Griffin: system administrator / platform owner.
- Hilda and Mukasa: Duty Ops Managers with full administrative rights and senior operational authority over all controllers; rotate daily day-duty fairly. Both may cover day shortages in ISOC or SCE when qualified and available.
- Wayne: Technical Assistant; eligible for configured cross-team shortage support. Night work is disabled by default and only possible through a recorded emergency exception with authorized approval.
- Mercy Wanyoike: individual HR account and HR workspace; not an ISOC roster member.
- Cate and Oliera: ISOC staff.
- Benson and Joan: add SCE qualification for rotation/shortage support while preserving their home department.
- David: deactivate account and remove from future eligibility; preserve historical schedule/audit references.
- HR: Mercy Wanyoike is the named HR account holder. Create an individual account and HR workspace; never create a shared generic HR credential.

Existing Stephen and Murad administrator grants require an explicit least-privilege review. Do not silently retain or revoke either grant as a side effect of this migration.

## Scheduling policy

### Hard constraints

- A person cannot be assigned to two shifts or departments on the same date.
- A person must be active, available, qualified for the target department and shift, and within effective-dated work restrictions.
- Leave, minimum rest, night-to-day recovery, maximum consecutive work, and configured hour limits must be respected.
- Wayne cannot receive a night assignment without a valid emergency exception.
- Exactly one Duty Ops Manager must be assigned to day duty each calendar day. If both are unavailable, create an explicit uncovered-duty exception; do not fabricate an assignment.
- When a Duty Ops Manager is allocated to a department shortage, the person counts once toward that department's demand and is not simultaneously counted as floating duty coverage.
- Cross-team coverage must never exceed the staff member's available capacity or create overlapping assignments.

### Soft objectives

Optimize lexicographically or with documented weights for:
1. Full minimum coverage and required skill mix.
2. Rest, availability and contracted-hour compliance (these remain hard constraints, not trade-offs).
3. Fair distribution of total shifts, nights, weekends, duty-manager days, and cross-team support over a rolling history.
4. Honor approved preferences and minimize short-notice changes.
5. Minimize borrowed staff and preserve team continuity.

The optimizer must report infeasibility and explain the smallest shortage set rather than quietly relaxing constraints. Emergency overrides are separate audited actions, not solver defaults.

## Implemented behavior on the feature branch

- Role permissions are read from D1 capability records; DOMs and the platform administrator have the full operational permission set.
- DOMs have authority level 900; Griffin has platform-owner level 1000. DOMs cannot modify accounts at or above their own authority.
- The monthly Duty Ops rota balances manager duty counts and cross-team shortage coverage. Uncovered dates are explicit exceptions, never fabricated assignments.
- Team-cover Duty Ops assignments are locked into future generated department rosters; the solver preserves these fixed assignments.
- Cross-qualified staff are included once per department and can only receive shift types enabled by their effective qualification and shift policy.
- Wayne's Technical Assistant role is day-only. Night work requires a date-specific exception requested with a reason and approved by a different authorized reviewer.
- HR can onboard operational staff, manage leave, record qualifications and configure per-person shift policies. New employees have no scheduling qualification until HR records verified eligibility.
- David is deactivated and sessions are revoked; historical schedule records remain intact.

## Interfaces

- **Staff workspace:** simple sign-in; personal roster, leave, swaps, announcements and clear shift explanations.
- **Duty Ops workspace:** full admin-capable command workspace for Hilda and Mukasa, daily rota generation, day/night coverage by team, shortage-directed cross-team support, handover, policy controls, approvals, audit and emergency exception workflow. DOMs outrank all controllers in the operational hierarchy.
- **HR workspace:** staff lifecycle, onboarding/offboarding, leave, availability, qualification records, effective dates and HR reporting.
- **Admin workspace:** policy/coverage configuration, role and permission management, solver controls, audit log, schedule approval and publication.
- **Technical workspace:** service health, technical notices and eligible support assignments; no privileged HR data.

## Visual direction

No green or green-adjacent accent palette. Use a premium midnight/graphite foundation with restrained sapphire, electric blue, violet, amber and warm ivory. Distinct themes may be user-selectable, but all must preserve accessible contrast, focus visibility, reduced-motion support and clear status semantics. Use polished motion sparingly; never animate critical schedule data in ways that obscure changes.

## Required verification

- Migration tested against an isolated D1 database and rollback/export plan reviewed.
- Permission matrix tests for every role and endpoint.
- Solver property tests for qualification, overlap, night restrictions, manager duty, cross-team shortage, leave, rest, fairness and month boundaries.
- Deterministic seeds for reproducible schedules and explainable outputs.
- Browser tests at desktop and mobile sizes for all role workspaces.
- Real Worker + isolated D1 integration tests for enrollment, sign-in, staff changes, schedule generation, exception approvals and audit records.
- Production D1 migration, credential issuance, and deployment remain separate explicit release steps.
