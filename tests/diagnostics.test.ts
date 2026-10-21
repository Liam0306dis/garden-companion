import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnosticsAlert, diagnosticsChecks, diagnosticsIssues, noteIssue, setCheck } from '../src/diagnostics.js';
import { buildReport, scrub } from '../src/diagnostics-report.js';

test('a repeating issue is counted on one entry rather than filling the list', () => {
  const before = diagnosticsIssues().length;
  for (let index = 0; index < 5; index++) noteIssue('warn', 'A repeating job failed.', new Error('boom'));
  const issues = diagnosticsIssues();
  assert.equal(issues.length, before + 1);
  assert.equal(issues.at(-1)?.count, 5);
});

test('a check keeps only its latest state, and a failed one raises the alert', () => {
  setCheck('the test hook', 'waiting');
  setCheck('the test hook', 'failed', 'kept failing');
  const check = diagnosticsChecks().find(entry => entry.name === 'the test hook');
  assert.equal(check?.status, 'failed');
  assert.equal(check?.detail, 'kept failing');
  assert.ok(diagnosticsAlert());
});

test('the report blanks player ids, item ids and room codes', () => {
  const text = scrub('player u_1ek7UvdMiH2DDRxgzKE5 item 3f2b1c4d-1111-2222-3333-444455556666 at https://magicgarden.gg/r/ABCD?x=1');
  assert.ok(!text.includes('u_1ek7'));
  assert.ok(!text.includes('3f2b1c4d'));
  assert.ok(!text.includes('ABCD'));
  assert.ok(text.includes('/r/<room>'));
});

test('the report lists problems ahead of what is working', () => {
  setCheck('the working hook', 'ok');
  const report = buildReport();
  assert.ok(report.startsWith('Garden Companion diagnostics'));
  assert.ok(report.indexOf('the test hook') < report.indexOf('Working ('));
});
