// Unit tests for the template workflow rules (issue #5). No database needed.

const { test } = require('node:test');
const assert = require('node:assert');
const { validateTemplate, parseId } = require('../src/lib/templateRules');

const task = (over = {}) => ({ title: 'Send welcome pack', offsetDays: 2, visibility: 'customer', actor: 'staff', ...over });
const valid = (over = {}) => ({ title: 'Standard onboarding', description: 'For new customers', tasks: [task()], ...over });

test('a valid template is accepted, trimmed and numbered in order', () => {
  const result = validateTemplate(valid({
    title: '  Standard onboarding  ',
    tasks: [task({ title: ' First ' }), task({ title: 'Second', visibility: 'internal', actor: 'staff' })],
  }));
  assert.ifError(result.error);
  assert.strictEqual(result.value.title, 'Standard onboarding');
  assert.deepStrictEqual(result.value.tasks.map((t) => [t.title, t.position]), [['First', 1], ['Second', 2]]);
});

test('offsetDays defaults to 0 when left out', () => {
  const { offsetDays, ...noOffset } = task();
  const result = validateTemplate(valid({ tasks: [noOffset] }));
  assert.strictEqual(result.value.tasks[0].offsetDays, 0);
});

test('description is optional', () => {
  const result = validateTemplate(valid({ description: undefined }));
  assert.strictEqual(result.value.description, null);
});

test('a customer cannot be the actor of an internal task', () => {
  const result = validateTemplate(valid({ tasks: [task({ visibility: 'internal', actor: 'customer' })] }));
  assert.match(result.error, /customer cannot complete an internal task/);
});

test('missing or blank title is rejected', () => {
  assert.match(validateTemplate(valid({ title: '   ' })).error, /title is required/);
  assert.match(validateTemplate(valid({ title: undefined })).error, /title is required/);
});

test('text that is too long is rejected', () => {
  assert.match(validateTemplate(valid({ title: 'x'.repeat(151) })).error, /at most 150/);
  assert.match(validateTemplate(valid({ tasks: [task({ title: 'x'.repeat(201) })] })).error, /at most 200/);
});

test('a template needs at least one task and at most 100', () => {
  assert.match(validateTemplate(valid({ tasks: [] })).error, /at least one task/);
  assert.match(validateTemplate(valid({ tasks: 'not a list' })).error, /at least one task/);
  assert.match(validateTemplate(valid({ tasks: Array.from({ length: 101 }, () => task()) })).error, /at most 100/);
});

test('offsetDays must be a whole number from 0 to 365', () => {
  for (const bad of [-1, 366, 1.5, '3', null]) {
    assert.match(validateTemplate(valid({ tasks: [task({ offsetDays: bad })] })).error, /offsetDays/, `offsetDays ${bad}`);
  }
});

test('visibility and actor must be one of the allowed values', () => {
  assert.match(validateTemplate(valid({ tasks: [task({ visibility: 'public' })] })).error, /visibility/);
  assert.match(validateTemplate(valid({ tasks: [task({ actor: 'admin' })] })).error, /actor/);
});

test('wrong types are rejected', () => {
  assert.ok(validateTemplate(null).error);
  assert.ok(validateTemplate([]).error);
  assert.match(validateTemplate(valid({ title: 42 })).error, /must be text/);
  assert.match(validateTemplate(valid({ tasks: [null] })).error, /must be an object/);
});

test('route ids must be positive whole numbers', () => {
  assert.strictEqual(parseId('7'), 7);
  for (const bad of ['0', '-1', 'abc', '1.5', '7;DROP', '', '12345678901']) {
    assert.strictEqual(parseId(bad), null, `id ${bad}`);
  }
});
