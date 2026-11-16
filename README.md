# Customer Onboarding Checklist Portal (Team 19)

Cloud Computing and Cloud Security (26CSCN29H), group project.

Reusable onboarding templates with task rules, customer plans with owners and due dates, role-based access that hides internal tasks and notes, and a dashboard that flags overdue tasks and at-risk plans.

**Stack:** HTML/CSS/JS frontend · Node.js + Express REST API · Neon PostgreSQL · Vercel (two projects) · Brevo email (optional channel)

## Team and ownership

| Member | Service | Main folders and files |
|---|---|---|
| Hana Fady | Template & Workflow Rules; leads Auth & identity (login, users) and database setup | `backend/src/routes/templates.js`, `auth.js`, `users.js`, `backend/src/middleware/`, `backend/db/` |
| Hana Anwar | Plan & Task Management | `backend/src/routes/plans.js`, `frontend/plans/` |
| Jana Hossam | Dashboard & Monitoring; leads deployment and logging | `backend/src/routes/dashboard.js`, `frontend/dashboard/`, `backend/vercel.json` |

Each member works only in their own files and branch, so each person's commits show their own work.

## Repository layout

```
backend/
  src/app.js            Express app (Vercel runs this as one function)
  src/routes/           one file per service
  src/middleware/       token, role and ownership checks (shared)
  src/db/pool.js        Neon connections (one per database role)
  db/schema.sql         all tables
  db/roles.sql          the three least-privilege database roles
  db/seed.js            creates the first Admin account
  test/                 automated tests (node:test + supertest)
  local.js              local development server
frontend/               static pages (Vercel static project)
docs/                   design notes, issue list, Postman exports
```

## Branches

- `main` is always deployable. Nobody pushes to it directly; changes arrive through reviewed pull requests.
- Feature branches:
  - `feature/auth-login` and `feature/template-management` (Hana Fady)
  - `feature/onboarding-tasks` (Hana Anwar)
  - `feature/dashboard-monitoring` and `feature/deployment` (Jana Hossam)

Workflow: create your branch from the latest `main`, commit your work, push the branch, and open a pull request. Another member reviews it before it is merged.

## Database setup (Neon)

1. In the Neon project, use the **SQL Editor** on the `dev` branch.
2. Run `backend/db/schema.sql`.
3. Open `backend/db/roles.sql`, replace the three `CHANGE_ME` passwords with long random values (do not commit them), and run it.
4. Repeat steps 2–3 on the `main` (production) branch with different passwords.
5. Build the three connection strings (`app_rw`, `dashboard_ro`, `notifier`) from the Neon connection details and put them in `backend/.env` locally and in the Vercel project's environment variables.

| Role | Variable | Can do |
|---|---|---|
| `app_rw` | `DATABASE_URL` | read/write application tables; audit log is insert-only |
| `dashboard_ro` | `DASHBOARD_DATABASE_URL` | read only; no password hashes, emails or internal notes |
| `notifier` | `NOTIFIER_DATABASE_URL` | read plans and tasks; add notifications only |

To prove the roles and data rules work, run `backend/db/check.sql` as the owner. Every line should say `PASS`, and nothing is saved.

If you add a new table later, also add its grants to `roles.sql`; new tables are not visible to any role until they are granted.

## Run locally

```bash
cd backend
cp .env.example .env      # then fill in the values
npm install
npm run seed              # creates the first Admin account
npm run dev               # API on http://localhost:3000
npm test                  # automated tests
```

Open `frontend/index.html` with a local static server (for example the VS Code Live Server extension on port 5500). The page shows whether it can reach the API.

## Deployment (Vercel)

- **API project:** root directory `backend`. Vercel detects Express automatically. Set every variable from `.env.example` in the project's Environment Variables.
- **Frontend project:** root directory `frontend`, no build step. Put the API project's URL in `frontend/js/config.js`, and add the frontend URL to `CORS_ORIGINS` in the API project.

## Security rules for everyone

- Never commit `.env`, passwords, connection strings or API keys.
- Use parameterized SQL only (`$1, $2`), never string concatenation.
- Check role **and** ownership on the server in every route; hiding a button is not a control.
- Never return internal notes or internal tasks to customers.
- Never log tokens, passwords or internal notes.
- Show data in the browser with `textContent`, not `innerHTML`.
