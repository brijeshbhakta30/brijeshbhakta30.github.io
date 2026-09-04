import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAngle,
  POINTER_RESTING_ANGLE,
  pointerAngleForOffset,
  TAU,
  winningIndexForRotation,
} from './geometry.ts';

for (const entryCount of [2, 3, 6, 17, 64]) {
  test(`winner is selected from the slice center with ${entryCount} entries`, () => {
    const arc = TAU / entryCount;

    for (let index = 0; index < entryCount; index += 1) {
      const sliceCenter = index * arc + arc / 2;
      const rotation = normalizeAngle(POINTER_RESTING_ANGLE - sliceCenter);

      assert.equal(winningIndexForRotation(entryCount, rotation), index);
    }
  });
}

test('winner calculation accounts for the pointer resting angle', () => {
  const entryCount = 8;
  const arc = TAU / entryCount;
  const pointerAngle = pointerAngleForOffset(18, 120);
  const rotation = normalizeAngle(pointerAngle - (5 * arc + arc / 2));

  assert.equal(winningIndexForRotation(entryCount, rotation, pointerAngle), 5);
});

test('winner switches at slice boundaries without an off-by-one shift', () => {
  const entryCount = 4;
  const arc = TAU / entryCount;
  const boundary = arc;

  assert.equal(winningIndexForRotation(entryCount, 0, boundary - 1e-9), 0);
  assert.equal(winningIndexForRotation(entryCount, 0, boundary + 1e-9), 1);
});
