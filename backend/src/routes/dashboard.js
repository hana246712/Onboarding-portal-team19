// Dashboard & Monitoring - Owner: Jana Hossam
// Endpoints for the dashboard, notifications, audit log and the daily job
// go here (proposal section 5.1).

const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

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

module.exports = router;


