import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEntries, serializeEntries } from './state.ts';

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
