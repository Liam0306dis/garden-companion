import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guarded, hookDisabled, resetHookFailures } from '../src/safe-hook.js';

test('a guarded call hands back its result, or the fallback when it throws', () => {
  resetHookFailures();
  assert.equal(guarded('a', () => 2, 1), 2);
  assert.equal(guarded('a', () => { throw new Error('x'); }, 1), 1);
});

test('after three throws the work is no longer run at all', () => {
  resetHookFailures();
  const warn = console.warn;
  console.warn = () => {};
  try {
    let runs = 0;
    for (let i = 0; i < 5; i++) guarded('b', () => { runs++; throw new Error('x'); }, 0);
    assert.equal(runs, 3);
    assert.equal(hookDisabled('b'), true);
    assert.equal(guarded('b', () => 9, 0), 0);
    assert.equal(hookDisabled('c'), false);
  } finally {
    console.warn = warn;
  }
});
