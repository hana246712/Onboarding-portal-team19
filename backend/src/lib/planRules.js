// Plan & Task Management - input validation. Owner: Hana Anwar.
//
// Pure functions (no database), so the rules can be unit-tested anywhere.
// See docs/api/plans-tasks-notes.md for the contract these follow.

const PLAN_STATUSES = ['Active', 'Completed', 'Cancelled'];
const TASK_STATUSES = ['Not Started', 'In Progress', 'Done'];
const MAX_START_OFFSET_DAYS = 365; // startDate at most this far from today
const DAY_MS = 24 * 60 * 60 * 1000;

function isPositiveId(value) {
  return Number.isInteger(value) && value > 0 && value <= 2147483647;
}

// Accepts only a real calendar date written as YYYY-MM-DD.
// Returns the same string, or null ("2026-02-30" and "2026-1-5" are rejected).
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? value : null;
}

function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

// Validates the body of POST /api/plans.
// Returns { value } with clean data, or { error } with a message for a 400.
function validateCreatePlan(body, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const { templateId, customerId, staffOwnerId } = body;
  if (!isPositiveId(templateId)) return { error: 'templateId must be a positive whole number' };
  if (!isPositiveId(customerId)) return { error: 'customerId must be a positive whole number' };
  if (staffOwnerId !== undefined && staffOwnerId !== null && !isPositiveId(staffOwnerId)) {
    return { error: 'staffOwnerId must be a positive whole number' };
  }

  const startDate = parseDate(body.startDate);
  if (!startDate) return { error: 'startDate must be a real date written as YYYY-MM-DD' };
  if (Math.abs(daysBetween(todayUtc(now), startDate)) > MAX_START_OFFSET_DAYS) {
    return { error: `startDate must be within ${MAX_START_OFFSET_DAYS} days of today` };
  }

  let title = null;
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== 'string') return { error: 'title must be text' };
    title = body.title.trim();
    if (!title) return { error: 'title cannot be empty' };
    if (title.length > 150) return { error: 'title must be at most 150 characters' };
  }

  return {
    value: { templateId, customerId, staffOwnerId: staffOwnerId || null, startDate, title },
  };
}

// Query-string ids arrive as text; same rule as route ids.
function parseQueryId(raw) {
  return typeof raw === 'string' && /^[1-9][0-9]{0,9}$/.test(raw) && Number(raw) <= 2147483647
    ? Number(raw)
    : null;
}

// Validates ?status=&customerId=&search=&page=&limit= for GET /api/plans.
function validatePlanListQuery(query = {}) {
  const out = { status: null, customerId: null, search: null, page: 1, limit: 20 };

  if (query.status !== undefined) {
    if (!PLAN_STATUSES.includes(query.status)) {
      return { error: `status must be one of: ${PLAN_STATUSES.join(', ')}` };
    }
    out.status = query.status;
  }
  if (query.customerId !== undefined) {
    out.customerId = parseQueryId(query.customerId);
    if (!out.customerId) return { error: 'customerId must be a positive whole number' };
  }
  if (query.search !== undefined) {
    if (typeof query.search !== 'string') return { error: 'search must be text' };
    const search = query.search.trim();
    if (search.length > 100) return { error: 'search must be at most 100 characters' };
    out.search = search || null;
  }
  if (query.page !== undefined) {
    out.page = parseQueryId(query.page);
    if (!out.page || out.page > 100000) return { error: 'page must be a positive whole number' };
  }
  if (query.limit !== undefined) {
    out.limit = parseQueryId(query.limit);
    if (!out.limit || out.limit > 100) return { error: 'limit must be a whole number from 1 to 100' };
  }
  return { value: out };
}

// Validates ?status=&assigneeId=&overdue= for GET /api/plans/:id/tasks.
function validateTaskListQuery(query = {}) {
  const out = { status: null, assigneeId: null, overdue: false };
  if (query.status !== undefined) {
    if (!TASK_STATUSES.includes(query.status)) {
      return { error: `status must be one of: ${TASK_STATUSES.join(', ')}` };
    }
    out.status = query.status;
  }
  if (query.assigneeId !== undefined) {
    out.assigneeId = parseQueryId(query.assigneeId);
    if (!out.assigneeId) return { error: 'assigneeId must be a positive whole number' };
  }
  if (query.overdue !== undefined) {
    if (query.overdue !== 'true' && query.overdue !== 'false') {
      return { error: "overdue must be 'true' or 'false'" };
    }
    out.overdue = query.overdue === 'true';
  }
  return { value: out };
}

// Escapes % and _ so a search for "50%" matches the text "50%", not everything.
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---- Week 3 ------------------------------------------------------------------

// Allowed task status changes (proposal, contract T2).
//   'owner' = the person who does the task (customer task: the plan's
//             customer; staff task: the assigned Staff user or any Admin)
//   'admin' = Admin only (reopening a finished task, any actor)
const TRANSITIONS = {
  'Not Started': { 'In Progress': 'owner' },
  'In Progress': { Done: 'owner' },
  Done: { 'In Progress': 'admin' },
};

// Returns 'owner', 'admin', or null when the change is not allowed at all.
function transitionRule(from, to) {
  return (TRANSITIONS[from] && TRANSITIONS[from][to]) || null;
}

function isObject(body) {
  return body && typeof body === 'object' && !Array.isArray(body);
}

// Body of PATCH /api/tasks/:id -> { value: { status } } or { error }.
function validateTaskStatus(body) {
  if (!isObject(body)) return { error: 'Request body must be a JSON object' };
  if (!TASK_STATUSES.includes(body.status)) {
    return { error: `status must be one of: ${TASK_STATUSES.join(', ')}` };
  }
  return { value: { status: body.status } };
}

// Body of PATCH /api/plans/:id: either a new title, or cancelling.
// -> { value: { action: 'rename', title } | { action: 'cancel', cancelReason } } or { error }.
function validatePlanUpdate(body) {
  if (!isObject(body)) return { error: 'Request body must be a JSON object' };
  const hasTitle = body.title !== undefined;
  const hasStatus = body.status !== undefined;
  if (hasTitle === hasStatus) {
    return { error: 'Send either a new title, or status "Cancelled" with a cancelReason' };
  }
  if (hasTitle) {
    if (typeof body.title !== 'string') return { error: 'title must be text' };
    const title = body.title.trim();
    if (!title) return { error: 'title cannot be empty' };
    if (title.length > 150) return { error: 'title must be at most 150 characters' };
    return { value: { action: 'rename', title } };
  }
  if (body.status !== 'Cancelled') {
    return { error: 'status can only be changed to Cancelled (plans complete automatically)' };
  }
  if (typeof body.cancelReason !== 'string' || !body.cancelReason.trim()) {
    return { error: 'cancelReason is required when cancelling a plan' };
  }
  const cancelReason = body.cancelReason.trim();
  if (cancelReason.length > 500) return { error: 'cancelReason must be at most 500 characters' };
  return { value: { action: 'cancel', cancelReason } };
}

// Body of PATCH /api/tasks/:id/assignment -> { value: { assigneeId } } or { error }.
function validateAssignment(body) {
  if (!isObject(body)) return { error: 'Request body must be a JSON object' };
  if (!isPositiveId(body.assigneeId)) return { error: 'assigneeId must be a positive whole number' };
  return { value: { assigneeId: body.assigneeId } };
}

// Body of POST /api/plans/:id/notes -> { value: { body, taskId } } or { error }.
function validateNote(body) {
  if (!isObject(body)) return { error: 'Request body must be a JSON object' };
  if (typeof body.body !== 'string') return { error: 'body must be text' };
  const text = body.body.trim();
  if (!text) return { error: 'body cannot be empty' };
  if (text.length > 2000) return { error: 'body must be at most 2000 characters' };
  const { taskId } = body;
  if (taskId !== undefined && taskId !== null && !isPositiveId(taskId)) {
    return { error: 'taskId must be a positive whole number' };
  }
  return { value: { body: text, taskId: taskId || null } };
}

// ?taskId= for GET /api/plans/:id/notes.
function validateNoteListQuery(query = {}) {
  if (query.taskId === undefined) return { value: { taskId: null } };
  const taskId = parseQueryId(query.taskId);
  if (!taskId) return { error: 'taskId must be a positive whole number' };
  return { value: { taskId } };
}

module.exports = {
  PLAN_STATUSES,
  TASK_STATUSES,
  parseDate,
  validateCreatePlan,
  validatePlanListQuery,
  validateTaskListQuery,
  escapeLike,
  transitionRule,
  validateTaskStatus,
  validatePlanUpdate,
  validateAssignment,
  validateNote,
  validateNoteListQuery,
};
