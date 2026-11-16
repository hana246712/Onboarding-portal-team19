# API contract: Plans, Tasks and Internal Notes

**Service:** Plan & Task Management · **Owner:** Hana Anwar · **Code:** `backend/src/routes/plans.js`
**Status:** Week 1 draft, for team review before implementation (Weeks 2–3).
**Based on:** proposal section 5.1, `backend/db/schema.sql`, `backend/db/roles.sql`.

This document is the agreement between the backend, the frontend screens (`frontend/plans/`), the dashboard (Jana) and the template/auth services (Hana Fady). If an endpoint has to change, update this file in the same pull request.

---

## 1. Conventions (same for every endpoint)

| Item | Rule |
|---|---|
| Base path | `/api` |
| Format | JSON in and out. `Content-Type: application/json`. Body limit 100 kb (already set in `app.js`). |
| Authentication | `Authorization: Bearer <JWT>` on every endpoint below. Uses Hana Fady's token, role and active-user middleware. |
| Roles | `Admin`, `Staff`, `Customer` (from `users.role`). "Staff side" means Admin or Staff. |
| Dates | `due_date` and `start_date` are `YYYY-MM-DD`. Timestamps are ISO 8601 UTC. |
| IDs | Positive integers. A non-integer id in the path returns `400`. |
| Errors | Always `{ "error": "<short message>" }`, optionally `"details": [{ "field": "...", "message": "..." }]` for `400`. Never stack traces or SQL text. |
| Unknown fields | Ignored (not stored). |
| SQL | Parameterized queries only (`$1, $2`). |
| Database role | All endpoints use `app_rw` (`DATABASE_URL`). |

### Status codes used

| Code | Meaning in this service |
|---|---|
| 200 | Read or update succeeded |
| 201 | Plan or note created |
| 400 | Validation failed (missing field, wrong type, bad date, invalid status change) |
| 401 | No token, invalid or expired token, or deactivated user (middleware) |
| 403 | Role not allowed for this endpoint (e.g. Customer calling a staff-only endpoint) |
| 404 | Not found **or not yours**. A customer asking for another customer's plan or an internal task gets `404`, not `403`, so ids cannot be probed. |
| 409 | Conflict with current state (template archived, plan not Active) |
| 500 | Unexpected error (generic message only) |

### Pagination (list endpoints)

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
  "start_date": "2026-12-01",
  "customer": { "id": 31, "name": "Acme Ltd" },
  "template": { "id": 4, "title": "Standard SaaS onboarding", "version": 3 },
  "cancel_reason": null,
  "progress": { "done": 3, "total": 9 },
  "created_at": "2026-11-20T09:15:00Z",
  "updated_at": "2026-11-22T14:02:11Z"
}
```

- `status`: `Active` | `Completed` | `Cancelled`.
- `progress` counts **only the tasks the caller can see** (customers: customer-visible tasks only).
- `template.version` is the version copied when the plan was created; later template edits do not change the plan.
- `cancel_reason` is returned to the staff side only. Customers see `status: "Cancelled"` without the reason.

### Task (`tasks`)

```json
{
  "id": 140,
  "plan_id": 12,
  "title": "Upload signed contract",
  "position": 2,
  "visibility": "customer",
  "actor": "customer",
  "assignee": { "id": 31, "name": "Acme Ltd" },
  "due_date": "2026-12-04",
  "status": "Not Started",
  "overdue": false,
  "completed_at": null,
  "updated_at": "2026-11-20T09:15:00Z"
}
```

- `visibility`: `internal` (staff side only) | `customer`.
- `actor`: who completes it, `staff` | `customer`. A customer task can never be internal (database check).
- `status`: `Not Started` | `In Progress` | `Done`.
- `overdue` is calculated: `status <> 'Done' AND due_date < today`.
- `assignee` returns id and name only, never email.

### Internal note (`internal_notes`)

```json
{
  "id": 7,
  "plan_id": 12,
  "task_id": 140,
  "author": { "id": 5, "name": "Sara (Staff)" },
  "body": "Customer asked for a call before uploading the contract.",
  "created_at": "2026-11-21T10:00:00Z"
}
```

Notes are append-only: no edit or delete endpoint, so they serve as a record.

---

## 3. Endpoints

Summary:

| # | Method | Path | Admin | Staff | Customer | Week |
|---|---|---|---|---|---|---|
| P1 | POST | `/api/plans` | ✓ | ✓ | ✗ | 2 |
| P2 | GET | `/api/plans` | all | all | own only | 2 |
| P3 | GET | `/api/plans/:id` | ✓ | ✓ | own only | 2 |
| P4 | PATCH | `/api/plans/:id` | ✓ | ✓ | ✗ | 3 |
| P5 | POST | `/api/plans/:id/cancel` | ✓ | ✓ | ✗ | 3 |
| T1 | GET | `/api/plans/:id/tasks` | ✓ | ✓ | own, customer-visible only | 2 |
| T2 | PATCH | `/api/tasks/:id/status` | ✓ | assigned staff tasks | own customer tasks | 3 |
| T3 | PATCH | `/api/tasks/:id/assignee` | ✓ | ✓ | ✗ | 3 |
| N1 | GET | `/api/plans/:id/notes` | ✓ | ✓ | ✗ (403) | 3 |
| N2 | POST | `/api/plans/:id/notes` | ✓ | ✓ | ✗ (403) | 3 |

---

### P1. Create a plan from a template

`POST /api/plans` · Admin, Staff

Request:

```json
{
  "template_id": 4,
  "customer_id": 31,
  "title": "Acme Ltd onboarding",
  "start_date": "2026-12-01",
  "staff_owner_id": 5
}
```

| Field | Rules |
|---|---|
| `template_id` | Required integer. Template must exist (`404`) and be `active` (`409 "Template is archived"`). |
| `customer_id` | Required integer. Must be an **active user with role Customer** (`400` otherwise). |
| `title` | Optional, 1–150 characters, trimmed. Default: `<template title> – <customer name>`. |
| `start_date` | Required, valid `YYYY-MM-DD`. May be in the past (backdated onboarding) but not more than 365 days ahead. |
| `staff_owner_id` | Optional integer. Active Admin or Staff user. Default: the caller. |

What happens, in **one transaction**:

1. Insert the plan with `template_version` = the template's current `version` and `created_by` = caller.
2. Copy every `template_tasks` row (ordered by `position`) into `tasks`, keeping `title`, `position`, `visibility`, `actor`, `template_task_id`.
3. `due_date = start_date + offset_days`.
4. Owner: `actor = customer` → `customer_id`; `actor = staff` → `staff_owner_id`.
5. All tasks start `Not Started`.
6. Write audit `plan.create` (allowed). Emit event `task.assigned` for each assignee (see section 5).

If the template has no tasks → `400 "Template has no tasks"`.

Response `201`: the full plan (as P3, staff view).

---

### P2. List plans

`GET /api/plans?status=Active&customer_id=31&search=acme&page=1&limit=20`

- Staff side: all plans; optional filters `status`, `customer_id`, `search` (title, case-insensitive, max 100 chars).
- Customer: only plans where `customer_id = caller`. A `customer_id` filter from a customer is ignored.
- Sorted by `created_at` newest first.

Response `200`: paginated list of plans (without tasks).

---

### P3. Get one plan with its tasks

`GET /api/plans/:id`

- Staff side: plan + **all** tasks ordered by `position`.
- Customer: `404` unless the plan is theirs; tasks filtered with `visibility = 'customer'` **in the SQL query**, not afterwards in JavaScript.
- Notes are **never** included here; they are only returned by N1.

Response `200`:

```json
{ "plan": { ...Plan }, "tasks": [ ...Task ] }
```

---

### P4. Edit plan details

`PATCH /api/plans/:id` · Admin, Staff

```json
{ "title": "Acme Ltd onboarding (EU)" }
```

- Only `title` is editable. To change dates or tasks, cancel the plan and create a new one, so due dates stay consistent with the template.
- Plan must be `Active` (`409 "Plan is not active"`).

Response `200`: updated plan.

---

### P5. Cancel a plan

`POST /api/plans/:id/cancel` · Admin, Staff

```json
{ "reason": "Customer postponed the project to Q2." }
```

- `reason` required, 1–500 characters.
- Only `Active` → `Cancelled` (`409` otherwise). Cancellation is final; there is no un-cancel.
- A cancelled plan is read-only: every task status change, reassignment, title edit or new note on it returns `409`.
- Audit `plan.cancel`.

Response `200`: updated plan.

---

### T1. List tasks of a plan

`GET /api/plans/:id/tasks?status=In%20Progress&assignee_id=5&overdue=true`

Same access rules as P3. Filters: `status`, `assignee_id` (staff side only), `overdue=true`. Ordered by `position`.

Response `200`: `{ "items": [ ...Task ] }` (not paginated; a plan has at most a few dozen tasks).

---

### T2. Change a task's status

`PATCH /api/tasks/:id/status`

```json
{ "status": "Done" }
```

**Allowed status changes:**

| From → To | Who |
|---|---|
| Not Started → In Progress | owner |
| Not Started → Done | owner |
| In Progress → Done | owner |
| In Progress → Not Started | owner |
| Done → In Progress (reopen) | Admin or Staff only |

Same status → `400 "Task already has this status"`. Anything else → `400 "Status change not allowed"`.

**Who is the owner:**

- `actor = customer`: only the plan's customer. Staff cannot complete a customer task for them.
- `actor = staff`: the assigned Staff user, or any Admin.
- A customer calling this on an internal task or a task in another customer's plan gets `404`.
- A Staff user who is not the assignee gets `403`.

Side effects (same transaction):

- `Done` sets `completed_at = now()`; leaving `Done` clears it (database check `tasks_done_has_time`).
- **Auto-complete:** if after the change every task of the plan is `Done`, the plan becomes `Completed` and event `plan.completed` is emitted.
- **Reopen:** reopening a task in a `Completed` plan sets the plan back to `Active`.
- Plan `Cancelled` → `409`.
- Audit `task.status` with old → new status.

Response `200`:

```json
{ "task": { ...Task }, "plan_status": "Completed" }
```

---

### T3. Reassign a task

`PATCH /api/tasks/:id/assignee` · Admin, Staff

```json
{ "assignee_id": 8 }
```

- Only `actor = staff` tasks can be reassigned. Customer tasks always belong to the plan's customer → `400 "Customer tasks cannot be reassigned"`.
- New assignee must be an **active Admin or Staff user** (`400` otherwise). Reassigning to the current assignee → `400`.
- Task must not be `Done` (`409`), and the plan must be `Active` (`409`).
- Audit `task.reassign` (old and new assignee ids). Emit `task.assigned` for the new assignee.

Response `200`: updated task.

---

### N1. List internal notes

`GET /api/plans/:id/notes?task_id=140` · Admin, Staff

- Customer → `403` (role check runs before any database lookup).
- Ordered newest first. Optional filter `task_id`.

Response `200`: `{ "items": [ ...Note ] }`

### N2. Add an internal note

`POST /api/plans/:id/notes` · Admin, Staff

```json
{ "body": "Customer asked for a call first.", "task_id": 140 }
```

- `body` required, 1–2000 characters after trimming. Stored as plain text; the frontend shows it with `textContent`.
- `task_id` optional; if given it must belong to this plan (`400`).
- Plan must not be `Cancelled` (`409`). Notes on `Completed` plans are allowed (follow-ups).
- Audit `note.create` with the note id only. The note text is never written to logs or the audit log.

Response `201`: the new note.

---

## 4. Security rules this service enforces

| Threat | Control |
|---|---|
| Customer reads another customer's plan (IDOR) | Every query filters by `customer_id = caller` for customers; `404` if no row. |
| Customer sees internal tasks or notes | Customer queries add `visibility = 'customer'`; notes only from N1/N2, which reject customers with `403`; `cancel_reason` hidden. |
| Customer completes a staff task, or staff fakes customer completion | Ownership rules in T2. |
| Privilege escalation via body fields | `customer_id`, `status`, `created_by`, `template_version` are never taken from the body except where listed above. |
| Invalid status jumps | Server-side transition table (T2). Hidden buttons are not a control. |
| SQL injection | Parameterized SQL only; `search` passed as a parameter with `ILIKE $n`. |
| Stored XSS via titles/notes | Stored as text; frontend renders with `textContent`. |
| Partial plan creation | P1 runs in one transaction; any failure rolls back. |
| Missing evidence | Every create, cancel, status change, reassignment and note is written to `audit_log`; denied attempts (403) are logged with `result = 'denied'`. |

## 5. Events for other services

| Event | When | Payload | Consumer |
|---|---|---|---|
| `task.assigned` | P1 (each assignee) and T3 | `{ plan_id, task_id, assignee_id }` | Notifications (Jana): in-app `assigned` notification |
| `plan.completed` | T2 auto-complete | `{ plan_id, customer_id }` | Dashboard / notifications |

Weeks 2–3: the event is written as an in-app notification row in the same request. Weeks 4–5 (Floci): the same payload is sent to an emulated Amazon SQS queue (`plan-events`) and the notifier reads from it. The payload never contains emails, note text or tokens.

## 6. Dependencies

- Hana Fady: JWT middleware (`req.user = { id, role }`), active-user check, templates and `template_tasks` (Week 2).
- Jana Hossam: shared audit helper (Week 2), notifications table usage, dashboard reads plans/tasks through `dashboard_ro`.

## 7. Open questions for the team

1. Should Staff be allowed to see **all** plans, or only plans where they own at least one task? (This draft: all.)
2. Should an Admin be able to mark a customer task Done on the customer's behalf (e.g. contract received by email)? (This draft: no.)
3. Maximum tasks per plan, to cap P1 work: suggest 100.
