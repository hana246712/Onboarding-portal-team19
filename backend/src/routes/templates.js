// Template & Workflow Rules - Owner: Hana Fady (issue #5)
//
//   POST  /api/templates              Admin         create template with its tasks and rules   201
//   GET   /api/templates              Admin, Staff  list templates (?status=active|archived|all) 200
//   GET   /api/templates/:id          Admin, Staff  one template with its ordered tasks         200
//   PUT   /api/templates/:id          Admin         edit template and task rules (version + 1)  200
//   PATCH /api/templates/:id/archive  Admin         archive (blocks new plans only)             200
//
// Errors: 400 bad input, 401 not logged in, 403 wrong role,
//         404 unknown template, 409 editing an archived template.
// Running plans never change: they keep their own copy of the tasks
// (made by Plan & Task Management when a plan starts).
// Week 3 (issue #7) adds reorder, duplicate and search.

const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { validateTemplate, parseId } = require('../lib/templateRules');

const router = express.Router();

function toTemplate(row, tasks) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      position: t.position,
      offsetDays: t.offset_days,
      visibility: t.visibility,
      actor: t.actor,
    })),
  };
}

async function loadTemplate(client, id) {
  const { rows } = await client.query(
    `SELECT id, title, description, status, version, created_at, updated_at
       FROM templates WHERE id = $1`,
    [id]
  );
  if (!rows[0]) return null;
  const tasks = await client.query(
    `SELECT id, title, position, offset_days, visibility, actor
       FROM template_tasks WHERE template_id = $1 ORDER BY position`,
    [id]
  );
  return toTemplate(rows[0], tasks.rows);
}

async function insertTasks(client, templateId, tasks) {
  for (const t of tasks) {
    await client.query(
      `INSERT INTO template_tasks (template_id, title, position, offset_days, visibility, actor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [templateId, t.title, t.position, t.offsetDays, t.visibility, t.actor]
    );
  }
}

// Runs fn inside one database transaction: all of it is saved, or none of it.
async function inTransaction(fn) {
  const client = await pool.db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- create --------------------------------------------------------------
router.post('/templates', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const input = validateTemplate(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const { title, description, tasks } = input.value;

    const template = await inTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO templates (title, description, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [title, description, req.user.id]
      );
      await insertTasks(client, rows[0].id, tasks);
      return loadTemplate(client, rows[0].id);
    });

    await recordAudit({ actorId: req.user.id, action: 'template_create', entity: 'template', entityId: template.id, result: 'allowed', ip: req.ip });
    return res.status(201).json(template);
  } catch (err) {
    return next(err);
  }
});

// ---- list ------------------------------------------------------------------
router.get('/templates', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    const status = req.query.status || 'active';
    if (!['active', 'archived', 'all'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active', 'archived' or 'all'" });
    }
    const { rows } = await pool.db().query(
      `SELECT t.id, t.title, t.description, t.status, t.version, t.updated_at,
              COUNT(tt.id)::int AS task_count
         FROM templates t
         LEFT JOIN template_tasks tt ON tt.template_id = t.id
        WHERE ($1 = 'all' OR t.status = $1)
        GROUP BY t.id
        ORDER BY t.title, t.id`,
      [status]
    );
    return res.json(rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      version: r.version,
      updatedAt: r.updated_at,
      taskCount: r.task_count,
    })));
  } catch (err) {
    return next(err);
  }
});

// ---- get one -------------------------------------------------------------
router.get('/templates/:id', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const template = id && (await loadTemplate(pool.db(), id));
    if (!template) return res.status(404).json({ error: 'Template not found' });
    return res.json(template);
  } catch (err) {
    return next(err);
  }
});

// ---- edit (replaces title, description and the whole task list) ----------
router.put('/templates/:id', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Template not found' });
    const input = validateTemplate(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const { title, description, tasks } = input.value;

    const outcome = await inTransaction(async (client) => {
      // Lock the row so two edits at once can't both bump the same version.
      const { rows } = await client.query('SELECT status FROM templates WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) return { status: 404 };
      if (rows[0].status === 'archived') return { status: 409 };

      await client.query(
        `UPDATE templates
            SET title = $2, description = $3, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [id, title, description]
      );
      await client.query('DELETE FROM template_tasks WHERE template_id = $1', [id]);
      await insertTasks(client, id, tasks);
      return { status: 200, template: await loadTemplate(client, id) };
    });

    if (outcome.status === 404) return res.status(404).json({ error: 'Template not found' });
    if (outcome.status === 409) return res.status(409).json({ error: 'Archived templates cannot be edited' });

    await recordAudit({ actorId: req.user.id, action: 'template_update', entity: 'template', entityId: id, result: 'allowed', ip: req.ip });
    return res.json(outcome.template);
  } catch (err) {
    return next(err);
  }
});

// ---- archive -----------------------------------------------------------------
router.patch('/templates/:id/archive', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Template not found' });
    const { rowCount } = await pool.db().query(
      `UPDATE templates SET status = 'archived', updated_at = now() WHERE id = $1`,
      [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Template not found' });

    await recordAudit({ actorId: req.user.id, action: 'template_archive', entity: 'template', entityId: id, result: 'allowed', ip: req.ip });
    return res.json(await loadTemplate(pool.db(), id));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
