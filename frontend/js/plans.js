// Onboarding plans screen. Owner: Hana Anwar (issue #23).
//   plans.html          list of plans (customers: only their own); Admin: "New plan"
//   plans.html?id=12    one plan: tasks with Start / Mark done / Reopen / Reassign,
//                       rename and cancel, and staff-only internal notes
// API: docs/api/plans-tasks-notes.md. Every change is checked again by the API;
// the rules in planView.js only decide which buttons are shown.
// All text is added with textContent (ui.el), never innerHTML.

(async () => {
  const user = auth.requireLogin(['Admin', 'Staff', 'Customer']);
  if (!user) return;

  const { el, clear, showMessage, hideMessage, busy, debounce } = ui;
  const v = planView;
  const $ = (id) => document.getElementById(id);
  const pageMessage = $('page-message');
  const showError = (err) => showMessage(pageMessage, err.message || String(err), 'error');
  const showOk = (text) => showMessage(pageMessage, text, 'ok');

  const planId = v.planIdFromSearch(location.search);
  if (planId) {
    $('detail-view').hidden = false;
    await showPlan(planId);
  } else {
    $('list-view').hidden = false;
    setUpList();
  }

  // =================== List ===================
  function setUpList() {
    const state = { page: 1, limit: 20, total: 0 };

    async function load() {
      hideMessage(pageMessage);
      const params = new URLSearchParams({ page: state.page, limit: state.limit });
      const status = $('status-filter').value;
      const search = $('search').value.trim();
      if (status) params.set('status', status);
      if (search) params.set('search', search);
      try {
        const data = await api.get(`/api/plans?${params}`);
        state.total = data.total;
        renderRows(data.items);
      } catch (err) {
        showError(err);
      }
    }

    function renderRows(plans) {
      const body = $('plan-rows');
      clear(body);
      for (const p of plans) {
        const percent = v.progressPercent(p.progress);
        body.append(el('tr', {},
          el('td', {}, el('a', { href: `plans.html?id=${p.id}` }, p.title)),
          el('td', {}, p.customer.name),
          el('td', {}, el('span', { className: `badge ${v.statusClass(p.status)}` }, p.status)),
          el('td', {},
            el('span', { className: 'progress mini', 'aria-hidden': 'true' },
              el('span', { className: 'progress-bar', style: `display:block;width:${percent}%` })),
            `${p.progress.done} of ${p.progress.total}`),
          el('td', {}, v.formatDay(p.startDate))));
      }
      $('list-empty').hidden = plans.length > 0;
      const pages = Math.max(1, Math.ceil(state.total / state.limit));
      $('page-info').textContent = `Page ${state.page} of ${pages} · ${state.total} plan${state.total === 1 ? '' : 's'}`;
      $('prev-page').disabled = state.page <= 1;
      $('next-page').disabled = state.page >= pages;
    }

    $('filters').addEventListener('submit', (e) => e.preventDefault());
    $('status-filter').addEventListener('change', () => { state.page = 1; load(); });
    $('search').addEventListener('input', debounce(() => { state.page = 1; load(); }));
    $('prev-page').addEventListener('click', () => { state.page -= 1; load(); });
    $('next-page').addEventListener('click', () => { state.page += 1; load(); });

    if (v.canCreatePlan(user)) setUpNewPlan();
    load();
  }

  // New plan form (Admin): templates, customers and staff owners come from the API.
  function setUpNewPlan() {
    const button = $('new-plan-button');
    const form = $('new-plan-form');
    button.hidden = false;
    let loaded = false;

    button.addEventListener('click', async () => {
      form.hidden = false;
      button.hidden = true;
      if (!loaded) loaded = await fillNewPlanForm();
      $('np-template').focus();
    });
    $('np-cancel').addEventListener('click', () => { form.hidden = true; button.hidden = false; });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy($('np-submit'), async () => {
        hideMessage(pageMessage);
        const body = {
          templateId: Number($('np-template').value),
          customerId: Number($('np-customer').value),
          startDate: $('np-start').value,
        };
        if ($('np-owner').value) body.staffOwnerId = Number($('np-owner').value);
        if ($('np-title').value.trim()) body.title = $('np-title').value.trim();
        try {
          const created = await api.post('/api/plans', body);
          location.href = `plans.html?id=${created.plan.id}`;
        } catch (err) {
          showError(err);
        }
      });
    });
  }

  async function fillNewPlanForm() {
    const fill = (select, items, label, placeholder) => {
      clear(select);
      select.append(el('option', { value: '' }, placeholder));
      for (const item of items) select.append(el('option', { value: String(item.id) }, label(item)));
    };
    try {
      const [templates, customers, staff, admins] = await Promise.all([
        api.get('/api/templates?status=active'),
        api.get('/api/users?role=Customer&active=true'),
        api.get('/api/users?role=Staff&active=true'),
        api.get('/api/users?role=Admin&active=true'),
      ]);
      fill($('np-template'), templates, (t) => `${t.title} (${t.taskCount} tasks, v${t.version})`, 'Choose a template');
      fill($('np-customer'), customers, (c) => c.name, 'Choose a customer');
      fill($('np-owner'), [...staff, ...admins], (s) => `${s.name} (${s.role})`, 'Me (default)');
      $('np-start').value = new Date().toISOString().slice(0, 10);
      if (!templates.length) showMessage(pageMessage, 'There are no active templates yet. Create one on the Templates page first.', 'error');
      return true;
    } catch (err) {
      showError(err);
      return false;
    }
  }

  // =================== One plan ===================
  async function showPlan(id) {
    let data;
    try {
      data = await api.get(`/api/plans/${id}`);
    } catch (err) {
      showError(err.status === 404 ? new Error('This plan was not found.') : err);
      return;
    }
    const { plan, tasks } = data;
    document.title = `${plan.title} · Onboarding Portal`;

    $('plan-title').textContent = plan.title;
    const badge = $('plan-status');
    badge.textContent = plan.status;
    badge.className = `badge ${v.statusClass(plan.status)}`;
    $('plan-meta').textContent =
      `Customer: ${plan.customer.name} · Template: ${plan.template.title} (version ${plan.template.version}) · Start: ${v.formatDay(plan.startDate)}`;
    const reason = $('plan-cancel-reason');
    reason.hidden = !plan.cancelReason;
    reason.textContent = plan.cancelReason ? `Cancelled: ${plan.cancelReason}` : '';
    $('progress-bar').style.width = `${v.progressPercent(plan.progress)}%`;
    $('progress-text').textContent = `${plan.progress.done} of ${plan.progress.total} tasks done (${v.progressPercent(plan.progress)}%)`;

    const staffList = v.canReassign(user, plan, { actor: 'staff', status: 'Not Started' }) ? await loadStaffList() : [];
    renderTasks(plan, tasks, staffList);
    setUpPlanActions(plan);
    if (v.canSeeNotes(user)) await showNotes(plan, tasks);
  }

  async function loadStaffList() {
    try {
      const [staff, admins] = await Promise.all([
        api.get('/api/users?role=Staff&active=true'),
        api.get('/api/users?role=Admin&active=true'),
      ]);
      return [...staff, ...admins];
    } catch {
      return []; // reassigning is simply not offered
    }
  }

  const reload = () => location.reload();

  // A short message that survives the reload after a change (this tab only).
  function flash(text) {
    try { sessionStorage.setItem('plans_flash', text); } catch { /* storage blocked: no message */ }
  }
  function takeFlash() {
    try {
      const text = sessionStorage.getItem('plans_flash');
      sessionStorage.removeItem('plans_flash');
      return text;
    } catch {
      return null;
    }
  }

  function renderTasks(plan, tasks, staffList) {
    const body = $('task-rows');
    clear(body);
    for (const task of tasks) {
      const title = el('td', { className: 'task-title' }, task.title);
      if (task.visibility === 'internal') title.append(' ', el('span', { className: 'badge internal' }, 'internal'));

      const status = el('td', {}, el('span', { className: `badge ${v.statusClass(task.status)}` }, task.status));
      if (task.overdue) status.append(' ', el('span', { className: 'badge overdue' }, 'overdue'));

      body.append(el('tr', { className: task.status === 'Done' ? 'done' : '' },
        el('td', {}, String(task.position)),
        title,
        el('td', {}, task.assignee ? task.assignee.name : '—', el('div', { className: 'muted small' }, task.actor === 'customer' ? 'customer task' : 'staff task')),
        el('td', {}, v.formatDay(task.dueDate)),
        status,
        el('td', {}, taskActions(plan, task, staffList))));
    }
  }

  function taskActions(plan, task, staffList) {
    const box = el('div', { className: 'actions' });

    const setStatus = (to, button, done) => busy(button, async () => {
      hideMessage(pageMessage);
      try {
        const res = await api.patch(`/api/tasks/${task.id}`, { status: to });
        flash(done(res));
        reload();
      } catch (err) {
        showError(err);
      }
    });

    if (v.canAdvance(user, plan, task)) {
      const to = v.nextStatus(task);
      const button = el('button', { type: 'button', className: 'small' }, v.actionLabel(to));
      button.addEventListener('click', () => setStatus(to, button, (res) =>
        res.planStatus === 'Completed' ? 'All tasks are done. The plan is now Completed.' : `"${task.title}" is now ${to}.`));
      box.append(button);
    }
    if (v.canReopen(user, plan, task)) {
      const button = el('button', { type: 'button', className: 'secondary small' }, 'Reopen');
      button.addEventListener('click', () => setStatus('In Progress', button, (res) =>
        res.planStatus === 'Active' && plan.status === 'Completed' ? 'Task reopened. The plan is Active again.' : 'Task reopened.'));
      box.append(button);
    }
    if (v.canReassign(user, plan, task) && staffList.length) {
      const select = el('select', { 'aria-label': `New owner for ${task.title}`, className: 'small' },
        el('option', { value: '' }, 'Reassign to…'),
        staffList.filter((s) => !task.assignee || s.id !== task.assignee.id)
          .map((s) => el('option', { value: String(s.id) }, `${s.name} (${s.role})`)));
      select.addEventListener('change', () => {
        if (!select.value) return;
        busy(select, async () => {
          hideMessage(pageMessage);
          try {
            await api.patch(`/api/tasks/${task.id}/assignment`, { assigneeId: Number(select.value) });
            flash(`"${task.title}" was reassigned.`);
            reload();
          } catch (err) {
            select.value = '';
            showError(err);
          }
        });
      });
      box.append(select);
    }
    if (!box.childNodes.length) box.append(el('span', { className: 'muted small' }, '—'));
    return box;
  }

  function setUpPlanActions(plan) {
    const message = takeFlash();
    if (message) showOk(message);
    if (!v.canManagePlan(user, plan)) return;
    $('plan-actions').hidden = false;

    const renameForm = $('rename-form');
    const cancelForm = $('cancel-form');
    $('rename-button').addEventListener('click', () => {
      cancelForm.hidden = true;
      renameForm.hidden = false;
      $('rename-input').value = plan.title;
      $('rename-input').focus();
    });
    $('rename-close').addEventListener('click', () => { renameForm.hidden = true; });
    $('cancel-button').addEventListener('click', () => {
      renameForm.hidden = true;
      cancelForm.hidden = false;
      $('cancel-reason').focus();
    });
    $('cancel-close').addEventListener('click', () => { cancelForm.hidden = true; });

    renameForm.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(renameForm.querySelector('button[type="submit"]'), async () => {
        try {
          await api.patch(`/api/plans/${plan.id}`, { title: $('rename-input').value.trim() });
          flash('Plan renamed.');
          reload();
        } catch (err) {
          showError(err);
        }
      });
    });
    cancelForm.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(cancelForm.querySelector('button[type="submit"]'), async () => {
        try {
          await api.patch(`/api/plans/${plan.id}`, { status: 'Cancelled', cancelReason: $('cancel-reason').value.trim() });
          flash('The plan was cancelled.');
          reload();
        } catch (err) {
          showError(err);
        }
      });
    });
  }

  // =================== Internal notes (Admin, Staff) ===================
  async function showNotes(plan, tasks) {
    $('notes-section').hidden = false;
    const taskSelect = $('note-task');
    clear(taskSelect);
    taskSelect.append(el('option', { value: '' }, 'Whole plan'),
      tasks.map((t) => el('option', { value: String(t.id) }, `${t.position}. ${t.title}`)));
    const taskTitle = new Map(tasks.map((t) => [t.id, t.title]));

    const form = $('note-form');
    if (plan.status === 'Cancelled') form.hidden = true; // the API refuses new notes (409)

    async function loadNotes() {
      try {
        const { items } = await api.get(`/api/plans/${plan.id}/notes`);
        const list = $('note-list');
        clear(list);
        for (const n of items) {
          const about = n.taskId ? ` · about "${taskTitle.get(n.taskId) || `task ${n.taskId}`}"` : '';
          list.append(el('li', {},
            el('div', { className: 'small muted' }, `${n.author.name} · ${new Date(n.createdAt).toLocaleString('en-GB')}${about}`),
            el('p', { className: 'note-body' }, n.body)));
        }
        $('notes-empty').hidden = items.length > 0;
      } catch (err) {
        showError(err);
      }
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form.querySelector('button[type="submit"]'), async () => {
        hideMessage(pageMessage);
        const body = { body: $('note-body').value.trim() };
        if (taskSelect.value) body.taskId = Number(taskSelect.value);
        try {
          await api.post(`/api/plans/${plan.id}/notes`, body);
          $('note-body').value = '';
          taskSelect.value = '';
          showOk('Note added.');
          await loadNotes();
        } catch (err) {
          showError(err);
        }
      });
    });

    await loadNotes();
  }
})();
