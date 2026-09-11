import assert from 'node:assert/strict';
import test from 'node:test';

import {
  multipliedEntries,
  normalizeEntryMultiplier,
  parseEntries,
  serializeEntries,
  sourceIndexForEffectiveIndex,
} from './state.ts';

test('pasted quoted list entries are normalized', () => {
  const entries = parseEntries(`'Ada',
&#x20; 'Arthur',
&#x20; 'Finn',
&#x20; 'Grace',
&#x20; 'John',
&#x20; 'Polly',`);

  assert.deepEqual(entries, [
    'Ada',
    'Arthur',
    'Finn',
    'Grace',
    'John',
    'Polly',
  ]);
  assert.equal(
    serializeEntries(entries),
    'Ada\nArthur\nFinn\nGrace\nJohn\nPolly',
  );
});

test('markdown struck-through entries are skipped', () => {
  const entries = parseEntries(String.raw`Ada
\~Arthur\~
&#x20;Finn
&#x20;\~Grace\~
John
&#x20;Polly`);

  assert.deepEqual(entries, ['Ada', 'Finn', 'John', 'Polly']);
  assert.equal(serializeEntries(entries), 'Ada\nFinn\nJohn\nPolly');
});

test('entries are multiplied by repeating the whole sequence', () => {
  assert.deepEqual(multipliedEntries(['A', 'B', 'C'], 1), ['A', 'B', 'C']);
  assert.deepEqual(multipliedEntries(['A', 'B', 'C'], 3), [
    'A',
    'B',
    'C',
    'A',
    'B',
    'C',
    'A',
    'B',
    'C',
  ]);
});

test('effective entry indexes map back to source entry indexes', () => {
  assert.equal(sourceIndexForEffectiveIndex(0, 3), 0);
  assert.equal(sourceIndexForEffectiveIndex(1, 3), 1);
  assert.equal(sourceIndexForEffectiveIndex(2, 3), 2);
  assert.equal(sourceIndexForEffectiveIndex(3, 3), 0);
  assert.equal(sourceIndexForEffectiveIndex(7, 3), 1);
});

test('entry multiplier values are normalized', () => {
  assert.equal(normalizeEntryMultiplier(), 1);
  assert.equal(normalizeEntryMultiplier(0), 1);
  assert.equal(normalizeEntryMultiplier(-2), 1);
  assert.equal(normalizeEntryMultiplier(2), 2);
  assert.equal(normalizeEntryMultiplier(5), 5);
  assert.equal(normalizeEntryMultiplier(6), 5);
  assert.equal(normalizeEntryMultiplier(2.5), 1);
  assert.equal(normalizeEntryMultiplier('2' as unknown as number), 1);
});
