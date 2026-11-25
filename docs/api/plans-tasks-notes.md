# API contract: Plans, Tasks and Internal Notes

**Service:** Plan & Task Management · **Owner:** Hana Anwar · **Code:** `backend/src/routes/plans.js`
**Status:** v2.1 (22 Nov 2026). v2 aligned the contract with proposal 5.1/6.1 after Hana Fady's review of PR #14; v2.1 fills in the exact Week 3 responses (P4, T2, T3, N2) as built.
**Based on:** proposal sections 5.1 and 6.1, `backend/db/schema.sql`, `backend/db/roles.sql`, `backend/src/routes/templates.js`.

This document is the agreement between the backend, the frontend screens (`frontend/plans/`), the dashboard (Jana) and the template/auth services (Hana Fady). If an endpoint has to change, update this file in the same pull request.

### Decisions recorded in v2 (from the PR #14 review)

| # | Question | Decision |
|---|---|---|
| 1 | JSON field names | **camelCase in JSON** (`templateId`, `dueDate`), snake_case only inside the database. Same as templates. |
| 2 | Endpoint names | **Follow proposal 5.1** (approved by the TA): `PATCH /api/tasks/:id`, `PATCH /api/tasks/:id/assignment`, `PATCH /api/plans/:id` (cancel is a status change on this endpoint). |
| 3 | Who creates plans | **Admin only** (proposal 6.1). Staff can view all plans and work on their tasks. |
| 4 | Task status changes | **Proposal table:** Not Started → In Progress → Done, plus Admin reopen (Done → In Progress). No other moves. |
| 5 | Invalid ids | **404** for unknown or malformed ids (`/api/plans/abc`), same as templates. |
| – | Already agreed | Staff see all plans; at most 100 tasks per plan (same cap as templates). |

---

## 1. Conventions (same for every endpoint)

| Item | Rule |
|---|---|
| Base path | `/api` |
| Format | JSON in and out. Body limit 100 kb (set in `app.js`). Field names in camelCase. |
| Authentication | `Authorization: Bearer <JWT>` on every endpoint below (`requireAuth` from `src/middleware/auth.js`). |
| Roles | `Admin`, `Staff`, `Customer`. "Staff side" means Admin or Staff. Role checks use `requireRole(...)`. |
| Dates | `startDate` and `dueDate` are `YYYY-MM-DD`. Timestamps are ISO 8601 UTC. |
| IDs | Positive whole numbers. Anything else is treated as "not found" → `404`. |
| Errors | Always `{ "error": "<short message>" }`. Never stack traces or SQL text. |
| Unknown fields | Ignored (not stored). |
| SQL | Parameterized queries only (`$1, $2`). |
| Database role | All endpoints use `app_rw` (`DATABASE_URL`). |

### Status codes used

| Code | Meaning in this service |
|---|---|
| 200 | Read or update succeeded |
| 201 | Plan or note created |
| 400 | Validation failed (missing field, wrong type, bad date, status change not allowed) |
| 401 | No token, invalid or expired token, or deactivated user |
| 403 | Role not allowed for this endpoint (e.g. Staff creating a plan, Customer reading notes) |
| 404 | Not found, malformed id, **or not yours**. A customer asking for another customer's plan or an internal task gets `404`, not `403`, so ids cannot be probed. |
| 409 | Conflict with current state (template archived, plan not Active) |
| 500 | Unexpected error (generic message only) |

### Pagination (plan list)

Query `?page=1&limit=20` (limit 1–100, default 20). Response:

```json
{ "items": [ ... ], "page": 1, "limit": 20, "total": 57 }
```

---

## 2. Resources

### Plan (`onboarding_plans`)

```json
{
  "id": 12,
  "title": "Acme Ltd onboarding",
  "status": "Active",
  "startDate": "2026-12-01",
  "customer": { "id": 31, "name": "Acme Ltd" },
  "template": { "id": 4, "title": "Standard SaaS onboarding", "version": 3 },
  "cancelReason": null,
  "progress": { "done": 3, "total": 9 },
  "createdAt": "2026-11-20T09:15:00.000Z",
  "updatedAt": "2026-11-22T14:02:11.000Z"
}
```

- `status`: `Active` | `Completed` | `Cancelled`.
- `progress` counts **only the tasks the caller can see** (customers: customer-visible tasks only).
- `template.version` is the version copied when the plan was created; later template edits do not change the plan.
- `cancelReason` is returned to the staff side only. Customers get `null`.

### Task (`tasks`)

```json
{
  "id": 140,
  "planId": 12,
  "title": "Upload signed contract",
  "position": 2,
  "visibility": "customer",
  "actor": "customer",
  "assignee": { "id": 31, "name": "Acme Ltd" },
  "dueDate": "2026-12-04",
  "status": "Not Started",
  "overdue": false,
  "completedAt": null,
  "updatedAt": "2026-11-20T09:15:00.000Z"
}
```

- `visibility`: `internal` (staff side only) | `customer`.
- `actor`: who completes it, `staff` | `customer`. A customer task can never be internal (database check).
- `status`: `Not Started` | `In Progress` | `Done`.
- `overdue` is calculated: `status <> 'Done' AND dueDate < today`.
- `assignee` returns id and name only, never email.

### Internal note (`internal_notes`)

```json
{
  "id": 7,
  "planId": 12,
  "taskId": 140,
  "author": { "id": 5, "name": "Sara (Staff)" },
  "body": "Customer asked for a call before uploading the contract.",
  "createdAt": "2026-11-21T10:00:00.000Z"
}
```

Notes are append-only: no edit or delete endpoint, so they serve as a record.

---

## 3. Endpoints

| # | Method | Path | Admin | Staff | Customer | Week | Issue |
|---|---|---|---|---|---|---|---|
| P1 | POST | `/api/plans` | ✓ | ✗ (403) | ✗ (403) | 2 | #17 |
| P2 | GET | `/api/plans` | all | all | own only | 2 | #18 |
| P3 | GET | `/api/plans/:id` | ✓ | ✓ | own only | 2 | #18 |
| T1 | GET | `/api/plans/:id/tasks` | ✓ | ✓ | own, customer-visible only | 2 | #18 |
| P4 | PATCH | `/api/plans/:id` | ✓ | ✓ | ✗ (403) | 3 | #19 |
| T2 | PATCH | `/api/tasks/:id` | ✓ | assigned staff tasks | own customer tasks | 3 | #19 |
| T3 | PATCH | `/api/tasks/:id/assignment` | ✓ | ✓ | ✗ (403) | 3 | #20 |
| N1 | GET | `/api/plans/:id/notes` | ✓ | ✓ | ✗ (403) | 3 | #21 |
| N2 | POST | `/api/plans/:id/notes` | ✓ | ✓ | ✗ (403) | 3 | #21 |

---

### P1. Create a plan from a template

`POST /api/plans` · Admin

```json
{
  "templateId": 4,
  "customerId": 31,
  "title": "Acme Ltd onboarding",
  "startDate": "2026-12-01",
  "staffOwnerId": 5
}
```

| Field | Rules |
|---|---|
| `templateId` | Required whole number. Template must exist (`404 "Template not found"`) and be `active` (`409 "Template is archived"`). |
| `customerId` | Required whole number. Must be an **active user with role Customer** (`400`). |
| `title` | Optional, 1–150 characters, trimmed. Default: `<template title> – <customer name>`, cut to 150. |
| `startDate` | Required real date `YYYY-MM-DD`, at most 365 days before or after today. |
| `staffOwnerId` | Optional whole number: who owns the staff tasks. Must be an active Admin or Staff user (`400`). Default: the caller. |

What happens, in **one transaction**:

1. Lock the template row (`FOR SHARE`) so it cannot be archived or edited halfway through.
2. Insert the plan with `template_version` = the template's current `version` and `created_by` = caller.
3. Copy every `template_tasks` row (ordered by `position`) into `tasks`, keeping `title`, `position`, `visibility`, `actor`, `template_task_id`.
4. `dueDate = startDate + offsetDays` (calculated in SQL).
5. Owner: `actor = customer` → `customerId`; `actor = staff` → `staffOwnerId`.
6. All tasks start `Not Started`.
7. One in-app `assigned` notification per assignee for this plan (event `task.assigned`, see section 5).
8. Audit `plan_create`.

Response `201`: `{ "plan": Plan, "tasks": [Task] }` (staff view).

---

### P2. List plans

`GET /api/plans?status=Active&customerId=31&search=acme&page=1&limit=20`

- Staff side: all plans; optional filters `status`, `customerId`, `search` (in title, case-insensitive, max 100 characters).
- Customer: only their own plans. A `customerId` filter from a customer is ignored.
- Newest first.

Response `200`: paginated list of plans (without tasks).

---

### P3. Get one plan with its tasks

`GET /api/plans/:id`

- Staff side: plan + **all** tasks ordered by `position`.
- Customer: `404` unless the plan is theirs; tasks filtered with `visibility = 'customer'` **in the SQL query**, not afterwards in JavaScript.
- Notes are **never** included; they are only returned by N1.

Response `200`: `{ "plan": Plan, "tasks": [Task] }`

---

### T1. List tasks of a plan

`GET /api/plans/:id/tasks?status=In%20Progress&assigneeId=5&overdue=true`

Same access rules as P3. Filters: `status`, `assigneeId` (ignored for customers), `overdue=true`. Ordered by `position`.

Response `200`: `{ "items": [Task] }` (not paginated; a plan has at most 100 tasks).

---

### P4. Edit or cancel a plan (Week 3, issue #19)

`PATCH /api/plans/:id` · Admin, Staff

Rename:

```json
{ "title": "Acme Ltd onboarding (EU)" }
```

Cancel:

```json
{ "status": "Cancelled", "cancelReason": "Customer postponed the project to Q2." }
```

- Send **either** `title` **or** `status` + `cancelReason`, not both (`400`).
- Only `title` and the change to `Cancelled` are accepted. `Completed` is never set by hand (see auto-complete in T2). Dates and tasks cannot be edited: cancel and create a new plan instead, so due dates stay consistent with the template.
- `cancelReason` required when cancelling, 1–500 characters.
- Plan must be `Active` (`409 "Plan is not active"`). Cancellation is final.
- A cancelled plan is read-only: task changes, reassignment, renames and new notes on it return `409`.
- Audit `plan_update` or `plan_cancel`.

Response `200`: `{ "plan": Plan }` (staff view).

---

### T2. Change a task's status (Week 3, issue #19)

`PATCH /api/tasks/:id`

```json
{ "status": "Done" }
```

**Allowed status changes (proposal):**

| From → To | Who |
|---|---|
| Not Started → In Progress | owner |
| In Progress → Done | owner |
| Done → In Progress (reopen) | **Admin only**, for any task (staff or customer) |

Same status → `400 "Task already has this status"`. Anything else → `400 "Status change not allowed"`.

Checks run in this order: task visible to the caller (`404`) → plan cancelled (`409`) → same status (`400`) → allowed change (`400`) → who may make it (`403`).

**Who is the owner:**

- `actor = customer`: only the plan's customer.
- `actor = staff`: the assigned Staff user, or any Admin.
- A customer calling this on an internal task or a task in another customer's plan gets `404`.
- A Staff user who is not the assignee gets `403`.

Side effects (same transaction):

- `Done` sets `completedAt`; reopening clears it (database check `tasks_done_has_time`).
- **Auto-complete:** when every task of the plan is `Done`, the plan becomes `Completed` and event `plan.completed` is emitted.
- **Reopen:** reopening a task in a `Completed` plan sets the plan back to `Active`.
- Plan `Cancelled` → `409`.
- Audit `task_status` (`denied` for a 403), plus `plan_complete` or `plan_reopen` when the plan status changes.
- The task row and its plan row are locked (`FOR UPDATE`) for the whole change, so two tasks finishing at the same moment cannot both miss the auto-complete.

Response `200`: `{ "task": Task, "planStatus": "Completed" }`

---

### T3. Reassign a task (Week 3, issue #20)

`PATCH /api/tasks/:id/assignment` · Admin, Staff

```json
{ "assigneeId": 8 }
```

- Only `actor = staff` tasks can be reassigned. Customer tasks always belong to the plan's customer → `400 "Customer tasks cannot be reassigned"`.
- New assignee must be an **active Admin or Staff user** (`400`). Same assignee as now → `400`.
- Task must not be `Done` (`409`), and the plan must be `Active` (`409`).
- Audit `task_reassign`. Emit `task.assigned` for the new assignee.

Response `200`: `{ "task": Task }`

---

### N1. List internal notes (Week 3, issue #21)

`GET /api/plans/:id/notes?taskId=140` · Admin, Staff

- Customer → `403` (role check runs before any database lookup).
- Newest first. Optional filter `taskId`.

Response `200`: `{ "items": [Note] }`

### N2. Add an internal note (Week 3, issue #21)

`POST /api/plans/:id/notes` · Admin, Staff

```json
{ "body": "Customer asked for a call first.", "taskId": 140 }
```

- `body` required, 1–2000 characters after trimming. Stored as plain text; the frontend shows it with `textContent`.
- `taskId` optional; if given it must belong to this plan (`400`).
- Plan must not be `Cancelled` (`409`). Notes on `Completed` plans are allowed (follow-ups).
- Audit `note_create` with the note id only. The note text is never written to logs or the audit log.

Response `201`: `{ "note": Note }`

---

## 4. Security rules this service enforces

| Threat | Control |
|---|---|
| Customer reads another customer's plan (IDOR) | Every customer query filters by `customer_id = caller`; `404` if no row. |
| Customer sees internal tasks or notes | Customer queries add `visibility = 'customer'` in SQL; notes only from N1/N2, which reject customers with `403`; `cancelReason` hidden. |
| Customer completes a staff task, or staff fakes customer completion | Ownership rules in T2. |
| Privilege escalation via body fields | `status`, `createdBy`, `templateVersion`, `assigneeId` of tasks are never taken from the P1 body. |
| Invalid status jumps | Server-side transition table (T2). Hidden buttons are not a control. |
| SQL injection | Parameterized SQL only; `search` passed as a parameter with `ILIKE`, and `%` / `_` in it are escaped. |
| Stored XSS via titles/notes | Stored as text; frontend renders with `textContent`. |
| Partial plan creation | P1 runs in one transaction; any failure rolls back. |
| Missing evidence | Create, cancel, status change, reassignment and note are written to `audit_log`; denied role checks are logged by `requireRole`. |

## 5. Events for other services

| Event | When | Payload | Consumer |
|---|---|---|---|
| `task.assigned` | P1 (one per assignee) and T3 | `{ planId, taskId, assigneeId }` (`taskId` null on P1) | Notifications (Jana): in-app `assigned` notification |
| `plan.completed` | T2 auto-complete | `{ planId, customerId }` | Dashboard (reads plan status); SQS in Weeks 4–5 |

Weeks 2–3: `src/lib/planEvents.js` writes the in-app notification row for `task.assigned` in the same transaction. `plan.completed` stores nothing yet (the notifications table has no "completed" type; the dashboard reads the plan status). Weeks 4–5 (Floci): the same function sends the payload to an emulated Amazon SQS queue (`plan-events`) instead, and the notifier reads from it. The payload never contains emails, note text or tokens.

**Known limit (from Jana's review of PR #46):** notifications have a once-per-day unique key (user, plan, task, type). If a task is reassigned A → B → A on the same day, A does not get a second "assigned" notification, even if they already read the first one. The reassignment itself and its audit entry still happen. Accepted for this project; a fix would be to reset `read_at` on the existing row instead of skipping it.

## 6. Dependencies

- Hana Fady: `requireAuth` / `requireRole` (PR #29), templates and `template_tasks` (PR #30).
- Hana Fady: `recordAudit` (`src/lib/audit.js`, PR #29).
- Jana Hossam: reads the `notifications` rows in her notifications API; dashboard reads plans/tasks through `dashboard_ro`.
