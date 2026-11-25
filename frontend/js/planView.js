// Rules for what the plan screens show to each user. Owner: Hana Anwar (issue #23).
//
// These only decide which buttons appear. The API checks every change again
// (docs/api/plans-tasks-notes.md, T2/T3), so a button that should not be
// there would still be refused by the server.
//
// Pure functions (no browser needed), unit-tested in backend/test/planView.test.js.

(function (root) {
  const NEXT_STATUS = { 'Not Started': 'In Progress', 'In Progress': 'Done' };
  const ACTION_LABEL = { 'In Progress': 'Start', Done: 'Mark done' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const isStaffSide = (user) => user.role === 'Admin' || user.role === 'Staff';

  // The next step for a task, or null when it is finished.
  function nextStatus(task) {
    return NEXT_STATUS[task.status] || null;
  }

  // Is this user the one who does the task? (same rule as the API)
  function isOwner(user, plan, task) {
    if (task.actor === 'customer') return user.role === 'Customer' && plan.customer.id === user.id;
    if (user.role === 'Admin') return true;
    return user.role === 'Staff' && Boolean(task.assignee) && task.assignee.id === user.id;
  }

  // Show "Start" / "Mark done"?
  function canAdvance(user, plan, task) {
    return plan.status === 'Active' && nextStatus(task) !== null && isOwner(user, plan, task);
  }

  // Show "Reopen"? Admin only, for a finished task on a plan that is not cancelled.
  function canReopen(user, plan, task) {
    return user.role === 'Admin' && task.status === 'Done' && plan.status !== 'Cancelled';
  }

  // Show the reassign list? Staff tasks that are not finished, on an active plan.
  // Admin only on screen, because the user list (GET /api/users) is Admin-only;
  // Staff can still reassign through the API.
  function canReassign(user, plan, task) {
    return user.role === 'Admin' && task.actor === 'staff' && task.status !== 'Done' && plan.status === 'Active';
  }

  // Rename, cancel and internal notes: Admin and Staff.
  function canManagePlan(user, plan) {
    return isStaffSide(user) && plan.status === 'Active';
  }

  function canSeeNotes(user) {
    return isStaffSide(user);
  }

  function canCreatePlan(user) {
    return user.role === 'Admin';
  }

  // "2026-12-01" -> "1 Dec 2026". Reads the text directly: new Date('2026-12-01')
  // is midnight UTC and can show the day before in time zones west of UTC.
  function formatDay(value) {
    const m = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return value ? String(value) : '';
    return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  }

  function progressPercent(progress) {
    if (!progress || !progress.total) return 0;
    return Math.round((progress.done / progress.total) * 100);
  }

  function actionLabel(status) {
    return ACTION_LABEL[status] || status;
  }

  // CSS class for a status badge: "Not Started" -> "status-not-started"
  function statusClass(status) {
    return `status-${String(status).toLowerCase().replace(/\s+/g, '-')}`;
  }

  // Only ids from the URL (?id=12); anything else means "show the list".
  function planIdFromSearch(search) {
    const raw = new URLSearchParams(search).get('id');
    return raw && /^[1-9][0-9]{0,9}$/.test(raw) && Number(raw) <= 2147483647 ? Number(raw) : null;
  }

  const planView = {
    nextStatus, isOwner, canAdvance, canReopen, canReassign, canManagePlan,
    canSeeNotes, canCreatePlan, formatDay, progressPercent, actionLabel, statusClass, planIdFromSearch,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = planView; // for tests
  if (root && root.document) root.planView = planView;
})(typeof window !== 'undefined' ? window : globalThis);
