// test/budget.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { createBudget, BudgetError } = require('../src/interpreter');

test('iterations under the cap are allowed', () => {
  const budget = createBudget({ maxIterations: 3 });
  budget.iteration();
  budget.iteration();
  budget.iteration();
});

test('one iteration past the cap throws BudgetError naming the cap', () => {
  const budget = createBudget({ maxIterations: 2 });
  budget.iteration();
  budget.iteration();
  assert.throws(() => budget.iteration(), (err) => {
    assert.ok(err instanceof BudgetError);
    assert.match(err.message, /200|2 iterations|iteration/i);
    return true;
  });
});

test('clock throws once wall time passes maxMs', () => {
  let t = 1000;
  const budget = createBudget({ maxMs: 500, now: () => t });
  budget.clock();
  t = 1600;
  assert.throws(() => budget.clock(), BudgetError);
});

test('iteration also enforces the clock', () => {
  let t = 0;
  const budget = createBudget({ maxIterations: 100, maxMs: 10, now: () => t });
  t = 50;
  assert.throws(() => budget.iteration(), BudgetError);
});

test('defaults are 200 iterations and 60s', () => {
  const budget = createBudget();
  for (let i = 0; i < 200; i++) budget.iteration();
  assert.throws(() => budget.iteration(), BudgetError);
});
