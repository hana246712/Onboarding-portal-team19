// Template & Workflow Rules - input validation. Owner: Hana Fady.
//
// Pure functions (no database), so the rules can be unit-tested anywhere.
// Each template task carries its workflow rules:
//   visibility: 'internal' (staff only) or 'customer' (customer can see it)
//   actor:      'staff' or 'customer' (who completes it)
//   offsetDays: due date = plan start date + offsetDays (0-365)
// A customer can only be the actor of a task they can see.

const VISIBILITY = ['internal', 'customer'];
const ACTORS = ['staff', 'customer'];
const MAX_TASKS = 100;

function cleanText(value, { field, max, required }) {
  if (value === undefined || value === null || value === '') {
    return required ? { error: `${field} is required` } : { value: null };
  }
  if (typeof value !== 'string') return { error: `${field} must be text` };
  const trimmed = value.trim();
  if (required && !trimmed) return { error: `${field} is required` };
  if (trimmed.length > max) return { error: `${field} must be at most ${max} characters` };
  return { value: trimmed || null };
}

function validateTask(task, index) {
  const where = `tasks[${index}]`;
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return { error: `${where} must be an object` };
  }
  const title = cleanText(task.title, { field: `${where}.title`, max: 200, required: true });
  if (title.error) return title;

  const offsetDays = task.offsetDays === undefined ? 0 : task.offsetDays;
  if (!Number.isInteger(offsetDays) || offsetDays < 0 || offsetDays > 365) {
    return { error: `${where}.offsetDays must be a whole number from 0 to 365` };
  }
  if (!VISIBILITY.includes(task.visibility)) {
    return { error: `${where}.visibility must be 'internal' or 'customer'` };
  }
  if (!ACTORS.includes(task.actor)) {
    return { error: `${where}.actor must be 'staff' or 'customer'` };
  }
  if (task.actor === 'customer' && task.visibility === 'internal') {
    return { error: `${where}: a customer cannot complete an internal task` };
  }
  return {
    value: { title: title.value, offsetDays, visibility: task.visibility, actor: task.actor, position: index + 1 },
  };
}

// Validates the body of POST /api/templates and PUT /api/templates/:id.
// Returns { value } with clean data, or { error } with a message for a 400.
function validateTemplate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const title = cleanText(body.title, { field: 'title', max: 150, required: true });
  if (title.error) return title;
  const description = cleanText(body.description, { field: 'description', max: 2000, required: false });
  if (description.error) return description;

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return { error: 'tasks must be a list with at least one task' };
  }
  if (body.tasks.length > MAX_TASKS) {
    return { error: `A template can have at most ${MAX_TASKS} tasks` };
  }
  const tasks = [];
  for (let i = 0; i < body.tasks.length; i += 1) {
    const result = validateTask(body.tasks[i], i);
    if (result.error) return result;
    tasks.push(result.value);
  }
  return { value: { title: title.value, description: description.value, tasks } };
}

// Route ids must be positive whole numbers; anything else is treated as "not found".
function parseId(raw) {
  return /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : null;
}

module.exports = { validateTemplate, parseId, VISIBILITY, ACTORS, MAX_TASKS };
