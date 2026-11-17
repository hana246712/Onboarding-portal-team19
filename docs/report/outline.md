# Final report: outline

**Customer Onboarding Checklist Portal · Team 19 · Cloud Computing and Cloud Security (26CSCN29H)**
Report coordinator: Hana Anwar · Status: Week 1 outline

Each section lists its owner and the evidence to collect while working, so nothing has to be reconstructed at the end. Owners draft their sections in Week 4; Hana Anwar merges and edits in Week 5.

| Owner | Code |
|---|---|
| Hana Fady | HF |
| Hana Anwar | HA |
| Jana Hossam | JH |

---

## 1. Introduction (HA)
- 1.1 Problem: onboarding tracked in emails and spreadsheets; no shared view of who owns what.
- 1.2 Goal and scope: templates, plans, tasks, role-based visibility, dashboard.
- 1.3 Changes since the Phase 1 proposal (from TA feedback), as a short table: *proposal → final → why*.

## 2. Requirements (HA)
- 2.1 Users and roles: Admin, Staff, Customer, with a permission matrix.
- 2.2 Functional requirements, numbered so tests can refer to them.
- 2.3 Non-functional requirements: security, availability, cost (free tier), maintainability.

## 3. System architecture (all; HA edits)
- 3.1 Architecture diagram: frontend on Vercel → API on Vercel (serverless function) → Neon PostgreSQL; Brevo email.
- 3.2 Three services in one API: Template & Workflow Rules (HF), Plan & Task Management (HA), Dashboard & Monitoring (JH).
- 3.3 Why serverless and a managed database (cloud service models: PaaS/DBaaS, shared-responsibility model).
- 3.4 Request flow example: a customer completes a task (sequence diagram).

## 4. Data design (HF)
- 4.1 ER diagram from `schema.sql`.
- 4.2 Snapshot design: tasks are copied from templates so template edits don't change running plans.
- 4.3 Database constraints that enforce business rules (e.g. customer tasks can't be internal).
- 4.4 Least-privilege database roles: `app_rw`, `dashboard_ro`, `notifier`; `check.sql` results.
- *Evidence:* screenshot of `check.sql` all PASS on Neon dev and main.

## 5. Service design and implementation
- 5.1 Auth and users (HF): JWT, bcrypt, lockout, deactivation.
- 5.2 Templates and workflow rules (HF): visibility, actor, offset days, versioning, archive.
- 5.3 Plans and tasks (HA): plan creation from a template, due dates, status transition table, auto-complete/cancel, reassignment, internal notes. Source: `docs/api/plans-tasks-notes.md`.
- 5.4 Dashboard and notifications (JH): progress, overdue, at-risk, daily cron, in-app and email notifications.
- 5.5 API reference: endpoint table for all services (link to the Postman collections).
- 5.6 Frontend screens: one screenshot per main screen, per role.

## 6. Cloud deployment (JH)
- 6.1 Vercel: two projects, environment variables, preview vs production.
- 6.2 Neon: dev and main branches, connection pooling, one connection string per role.
- 6.3 Scheduled job (Vercel Cron) and `CRON_SECRET`.
- 6.4 Free-tier limits and cost review.
- *Evidence:* deployment screenshots, live URLs.

## 7. AWS architecture emulated with Floci (all)
Same system deployed on an AWS architecture, emulated locally with Floci. Floci runs locally only and does not replace the live site.
- 7.1 Architecture mapping table: *Vercel/Neon component → AWS service*.
- 7.2 Amazon RDS for PostgreSQL: same `schema.sql`, `roles.sql`, `check.sql` (HF).
- 7.3 IAM roles and least-privilege policies, each with a description (HF).
- 7.4 Secrets Manager for database passwords (JH).
- 7.5 SQS: `task.assigned` and `plan.completed` events go through the `plan-events` queue to the notifier (HA).
- 7.6 `docker-compose.yml` and GitHub Actions CI against Floci (JH).
- *Evidence:* `docker compose up` output, queue messages, CI run screenshot.

## 8. Security (HF leads; all contribute)
- 8.1 Threat model: proposal section 6.4 threats → implemented control → test that proves it.
- 8.2 Authentication and session security.
- 8.3 Authorization: role **and** ownership checks on the server; `404` instead of `403` for other customers' data.
- 8.4 Data protection: internal notes and tasks never reach customers; secrets never committed; parameterized SQL; `textContent`.
- 8.5 Logging and audit: insert-only `audit_log`, what is and isn't logged.
- 8.6 Remaining risks and what we would add with more time.

## 9. Testing and evaluation (all; HA edits)
- 9.1 Automated tests (`npm test`): what they cover.
- 9.2 Postman collections: success and error cases per service (400/401/403/404/409/429).
- 9.3 End-to-end cloud test: template → plan → customer completes tasks → plan auto-completes → dashboard updates (HA).
- 9.4 Security test results table.
- 9.5 Requirements coverage: each requirement from section 2 → test.

## 10. Project management (HA)
- 10.1 Weekly plan vs actual.
- 10.2 GitHub workflow: branches, pull requests, reviews, issues (screenshots).
- 10.3 Individual contributions table: member, service, main files, number of commits and PRs.

## 11. Conclusion and future work (HA)

## References

## Appendices
- A. Full API reference
- B. `schema.sql` and `roles.sql`
- C. Postman export list
- D. Setup and deployment guide (from README)

---

## Evidence checklist (collect as you go)

| Evidence | Owner | Week |
|---|---|---|
| `check.sql` PASS screenshots (dev, main) | HF | 1–2 |
| Vercel and Neon project screenshots, live URLs | JH | 1 |
| Postman runs per service | all | 4 |
| Screens per role (Admin, Staff, Customer) | all | 4 |
| Customer cannot see internal task/note (API + UI) | HA | 3–4 |
| Floci: RDS, IAM, Secrets Manager, SQS, CI | all | 4–5 |
| GitHub insights: commits, PRs, issues per member | JH | 5 |
