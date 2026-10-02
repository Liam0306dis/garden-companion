import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderCalculators, setCalculatorTab } from '../src/features/calculators.js';

test('the XP calculator counts Amber Moon events with a Red Fox booster', () => {
  setCalculatorTab('xp');
  const host = document.createElement('div');
  host.innerHTML = renderCalculators();

  // No pets owned, so the pet is set by hand from 70 to 100 and the one booster sits at STR 100:
  // 600 XP from the pet plus 600s x 1.5%/s x 1400 = 12,600 from the fox, per event.
  assert.equal(host.querySelectorAll('.gc-xp-stats b')[2].textContent, '13,200');
  assert.match(host.querySelector('[data-xp-booster]')!.textContent!, /Amber XP Boost - Amber Moon only/);
});

test('boosters that ignore weather are offered alongside the weather ones', () => {
  setCalculatorTab('xp');
  const host = document.createElement('div');
  host.innerHTML = renderCalculators();
  const options = [...host.querySelectorAll<HTMLOptionElement>('[data-xp-booster] option')].map(option => option.value);
  assert.ok(options.includes('PetXpBoostII'), options.join());
});
