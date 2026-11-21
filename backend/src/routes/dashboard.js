// Dashboard & Monitoring - Owner: Jana Hossam
// Endpoints for the dashboard, notifications, audit log and the daily job
// go here (proposal section 5.1).

const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const PLAN_STATUSES = ['Active', 'Completed', 'Cancelled'];

// Reads page and limit from the URL. Returns { page, limit } or { error } for a 400.
function readPaging(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(page) || page < 1) return { error: 'page must be a whole number of 1 or more' };
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be a whole number from 1 to 100' };
  return { page, limit };
}

router.get('/dashboard/summary', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    const db = pool.dashboardDb();   // read-only role
     const plans = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM onboarding_plans GROUP BY status`
    );
     const tasks = await db.query(
      `SELECT t.status, COUNT(*)::int AS count
         FROM tasks t JOIN onboarding_plans p ON p.id = t.plan_id
        WHERE p.status = 'Active'
        GROUP BY t.status`
    );

    const overdue = await db.query(
      `SELECT COUNT(*)::int AS count
         FROM tasks t JOIN onboarding_plans p ON p.id = t.plan_id
        WHERE p.status = 'Active' AND t.status <> 'Done' AND t.due_date < CURRENT_DATE`
    );

        const planCounts = { active: 0, completed: 0, cancelled: 0 };
    for (const row of plans.rows) {
      planCounts[row.status.toLowerCase()] = row.count;
    }

        const taskKeys = { 'Not Started': 'notStarted', 'In Progress': 'inProgress', Done: 'done' };
    const taskCounts = { notStarted: 0, inProgress: 0, done: 0 };
    for (const row of tasks.rows) {
      taskCounts[taskKeys[row.status]] = row.count;
    }
    return res.json({
      plans: planCounts,
      tasks: taskCounts,
      overdueTasks: overdue.rows[0].count,
    });

  } catch (err) {
    return next(err);
  }
});
router.get('/dashboard/plans', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    // 1. check the URL options
    const status = req.query.status;
    if (status !== undefined && !PLAN_STATUSES.includes(status)) {
      return res.status(400).json({ error: "status must be 'Active', 'Completed' or 'Cancelled'" });
    }
    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ error: paging.error });
    const offset = (paging.page - 1) * paging.limit;

    // 2. run the query (read-only role)
    const { rows } = await pool.dashboardDb().query(
      `SELECT p.id, p.title, p.status, p.start_date, u.name AS customer_name,
              COUNT(t.id)::int                                            AS total_tasks,
              COUNT(t.id) FILTER (WHERE t.status = 'Done')::int           AS done_tasks,
              COUNT(t.id) FILTER (WHERE t.status <> 'Done'
                                    AND t.due_date < CURRENT_DATE)::int   AS overdue_tasks,
              MIN(t.due_date) FILTER (WHERE t.status <> 'Done')           AS next_due_date
         FROM onboarding_plans p
         JOIN users u      ON u.id = p.customer_id
         LEFT JOIN tasks t ON t.plan_id = p.id
        WHERE ($1::text IS NULL OR p.status = $1)
        GROUP BY p.id, u.name
        ORDER BY overdue_tasks DESC, p.id
        LIMIT $2 OFFSET $3`,
      [status ?? null, paging.limit, offset]
    );

    // 3. TODO: turn each row into camelCase JSON, and work out progress
    
          // 3. turn each row into camelCase JSON, and work out progress
    const plans = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      startDate: r.start_date,
      customerName: r.customer_name,
      totalTasks: r.total_tasks,
      doneTasks: r.done_tasks,
      overdueTasks: r.overdue_tasks,
      progress: r.total_tasks ? Math.round((r.done_tasks / r.total_tasks) * 100) : 0,
      nextDueDate: r.next_due_date,
    }));
    

    return res.json({ page: paging.page, limit: paging.limit, plans });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;


