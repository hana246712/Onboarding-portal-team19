# End-to-end test on the live site (issue #28), 2026-11-25

**44 of 44 checks passed, 0 failed** (30 requests).

| Result | Check | Detail |
|---|---|---|
| PASS | API health on the live site – 200 | 200 |
| PASS | API health on the live site – security headers on the live API | 200 |
| PASS | Login as Admin – 200 - check adminEmail / adminPassword | 200 |
| PASS | Login as Admin – role Admin | 200 |
| PASS | Dashboard before: completed plans – 200 | 200 |
| PASS | Create test Staff account – 201 | 201 |
| PASS | Create test Customer account – 201 | 201 |
| PASS | Login as the test Staff – 200 | 200 |
| PASS | Login as the test Customer – 200 | 200 |
| PASS | Admin creates a template with 3 task rules – 201 | 201 |
| PASS | Admin creates the customer's plan – 201 | 201 |
| PASS | Admin creates the customer's plan – 3 tasks copied with due dates from the offsets | 201 |
| PASS | Admin creates the customer's plan – owners: staff, customer, staff | 201 |
| PASS | Customer sees the plan without the internal task – 200 | 200 |
| PASS | Customer sees the plan without the internal task – 2 customer-visible tasks, no internal title | 200 |
| PASS | Staff sees all 3 tasks – 200 | 200 |
| PASS | Staff sees all 3 tasks – 3 tasks | 200 |
| PASS | Staff adds an internal note – 201 | 201 |
| PASS | Customer cannot read internal notes – 403 | 403 |
| PASS | Staff starts the kick-off call – 200 | 200 |
| PASS | Staff finishes the kick-off call – 200 | 200 |
| PASS | Customer starts the upload – 200 | 200 |
| PASS | Customer finishes the upload – 200 | 200 |
| PASS | Staff starts the internal check – 200 | 200 |
| PASS | Last task done -> plan Completed automatically – 200 | 200 |
| PASS | Last task done -> plan Completed automatically – planStatus Completed | 200 |
| PASS | Customer sees the plan as Completed – 200 | 200 |
| PASS | Customer sees the plan as Completed – Completed, 2 of 2 visible tasks done | 200 |
| PASS | Dashboard summary: one more completed plan – 200 | 200 |
| PASS | Dashboard summary: one more completed plan – completed count went up | 200 |
| PASS | Dashboard plan progress: 100% – 200 | 200 |
| PASS | Dashboard plan progress: 100% – plan listed with 3 of 3 done, 100% | 200 |
| PASS | Staff got an 'assigned' notification – 200 | 200 |
| PASS | Staff got an 'assigned' notification – assigned notification for this plan | 200 |
| PASS | Customer got an 'assigned' notification – 200 | 200 |
| PASS | Customer got an 'assigned' notification – assigned notification for this plan | 200 |
| PASS | Audit log recorded the automatic completion – 200 | 200 |
| PASS | Audit log recorded the automatic completion – plan_complete entry for this plan | 200 |
| PASS | Audit log recorded the automatic completion – no emails in the audit API | 200 |
| PASS | Customer cannot open the dashboard – 403 | 403 |
| PASS | Archive the test template – 200 | 200 |
| PASS | Deactivate the test Staff – 200 | 200 |
| PASS | Deactivate the test Customer – 200 | 200 |
| PASS | Deactivated customer is refused at once – 401 | 401 |

