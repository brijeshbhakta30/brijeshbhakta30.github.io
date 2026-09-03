import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRoomAction,
  freshRoomState,
  makeRandomId,
  mergeRoomState,
  PRESENCE_TIMEOUT_MS,
  presenceFor,
  type RoomAction,
  type RoomState,
  votingStatusFor,
  votingStatusLabel,
} from './state.ts';

const action = <T extends RoomAction['type']>(
  type: T,
  counter: number,
  actorId: string,
  payload: Extract<RoomAction, { type: T }>['payload'],
) =>
  ({
    id: `${String(counter).padStart(3, '0')}-${actorId}`,
    actorId,
    counter,
    type,
    payload,
  }) as Extract<RoomAction, { type: T }>;

const joined = (): RoomState =>
  applyRoomAction(
    freshRoomState(),
    action('join', 1, 'a', {
      playerId: 'a',
      peerId: 'peer-a',
      name: 'Alex',
      now: 1000,
    }),
  );

const withMockedNow = <T>(now: number, callback: () => T) => {
  const descriptor = Object.getOwnPropertyDescriptor(Date, 'now');
  Object.defineProperty(Date, 'now', {
    configurable: true,
    value: () => now,
  });
  try {
    return callback();
  } finally {
    if (descriptor) Object.defineProperty(Date, 'now', descriptor);
  }
};

test('random IDs work when crypto.randomUUID is unavailable', () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.crypto,
    'randomUUID',
  );
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: undefined,
  });
  try {
    assert.match(
      makeRandomId(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  } finally {
    if (cryptoDescriptor)
      Object.defineProperty(globalThis.crypto, 'randomUUID', cryptoDescriptor);
    else Reflect.deleteProperty(globalThis.crypto, 'randomUUID');
  }
});

test('a returning participant reclaims the same identity and vote', () => {
  let state = joined();
  state = applyRoomAction(
    state,
    action('vote', 2, 'a', {
      playerId: 'a',
      roundId: state.roundId,
      hasVoted: true,
      vote: null,
    }),
  );
  state = applyRoomAction(
    state,
    action('join', 3, 'a', {
      playerId: 'a',
      peerId: 'peer-a-new',
      name: 'Alex',
      now: 2000,
    }),
  );
  assert.equal(state.players.length, 1);
  assert.equal(state.players[0].peerId, 'peer-a-new');
  assert.equal(state.players[0].hasVoted, true);
});

test('presence remains recoverable until the ten minute expiry', () => {
  const player = joined().players[0];
  assert.notEqual(
    presenceFor(player, player.lastSeenAt + PRESENCE_TIMEOUT_MS - 1, false),
    'disconnected',
  );
  assert.equal(
    presenceFor(player, player.lastSeenAt + PRESENCE_TIMEOUT_MS, false),
    'disconnected',
  );
});

test('canonical voting status and label are shared', () => {
  let state = joined();
  const player = state.players[0];
  assert.equal(votingStatusFor(player, state, 'connected'), 'choosing');
  assert.equal(votingStatusLabel('choosing'), 'Choosing');
  state = applyRoomAction(
    state,
    action('vote', 2, 'a', {
      playerId: 'a',
      roundId: state.roundId,
      hasVoted: true,
      vote: null,
    }),
  );
  assert.equal(votingStatusFor(state.players[0], state, 'connected'), 'voted');
  assert.equal(votingStatusLabel('voted'), 'Voted');
  assert.equal(votingStatusFor(state.players[0], state, 'away'), 'away');
  assert.equal(votingStatusLabel('away'), 'Away');
});

test('simultaneous reveal operations are idempotent', () => {
  const initial = joined();
  const first = action('reveal', 2, 'a', { roundId: initial.roundId });
  const second = action('reveal', 2, 'b', { roundId: initial.roundId });
  const left = applyRoomAction(applyRoomAction(initial, first), second);
  const right = applyRoomAction(applyRoomAction(initial, second), first);
  assert.equal(left.revealed, true);
  assert.equal(right.revealed, true);
  assert.deepEqual(left.clocks.reveal, right.clocks.reveal);
});

test('simultaneous new rounds converge without incrementing twice', () => {
  const initial = joined();
  const first = action('new-round', 2, 'a', {
    baseRoundId: initial.roundId,
  });
  const second = action('new-round', 2, 'b', {
    baseRoundId: initial.roundId,
  });
  const left = applyRoomAction(applyRoomAction(initial, first), second);
  const right = applyRoomAction(applyRoomAction(initial, second), first);
  assert.equal(left.round, 2);
  assert.equal(right.round, 2);
  assert.equal(left.roundId, right.roundId);
  assert.deepEqual(left.clocks.round, right.clocks.round);
});

test('old facilitator fields have no effect on room actions', () => {
  const legacy = {
    ...joined(),
    facilitatorId: 'missing',
    hostId: 'missing',
  };
  const next = applyRoomAction(
    legacy,
    action('reveal', 2, 'any-participant', {
      roundId: legacy.roundId,
    }),
  );
  assert.equal(next.revealed, true);
});

test('a reveal for an old round cannot reveal the new round', () => {
  const initial = joined();
  const nextRound = applyRoomAction(
    initial,
    action('new-round', 2, 'a', { baseRoundId: initial.roundId }),
  );
  const staleReveal = applyRoomAction(
    nextRound,
    action('reveal', 3, 'b', { roundId: initial.roundId }),
  );
  assert.equal(staleReveal.revealed, false);
});

test('sixteen simultaneous joins remain distinct', () => {
  let state = freshRoomState();
  for (let index = 0; index < 16; index += 1) {
    const id = `participant-${index}`;
    state = applyRoomAction(
      state,
      action('join', 1, id, {
        playerId: id,
        peerId: `peer-${index}`,
        name: `Person ${index}`,
        now: 1000,
      }),
    );
  }
  assert.equal(state.players.length, 16);
  assert.equal(new Set(state.players.map((player) => player.id)).size, 16);
});

test('concurrent configuration and round actions merge independently', () => {
  const initial = joined();
  const roundState = applyRoomAction(
    initial,
    action('new-round', 2, 'a', { baseRoundId: initial.roundId }),
  );
  const configuredState = applyRoomAction(
    initial,
    action('voting-config', 2, 'b', {
      allowVoteChangesAfterReveal: false,
    }),
  );
  const left = mergeRoomState(roundState, configuredState);
  const right = mergeRoomState(configuredState, roundState);
  assert.equal(left.round, 2);
  assert.equal(right.round, 2);
  assert.equal(left.allowVoteChangesAfterReveal, false);
  assert.equal(right.allowVoteChangesAfterReveal, false);
});

test('timer actions preserve remaining time across clock skew', () => {
  const state = joined();
  const next = withMockedNow(206_000, () =>
    applyRoomAction(
      state,
      {
        ...action('timer', 2, 'a', {
          roundId: state.roundId,
          duration: 30,
          endsAt: 130_000,
          autoReveal: true,
        }),
        sentAt: 100_000,
      },
    ),
  );

  assert.equal(next.timerDuration, 30);
  assert.equal(next.timerEndsAt, 236_000);
});

test('active timers in snapshots preserve remaining time across clock skew', () => {
  const local = joined();
  const remote = {
    ...local,
    timerEndsAt: 130_000,
    timerDuration: 30,
    autoReveal: true,
    clocks: {
      ...local.clocks,
      timer: { counter: 2, id: '002-a' },
    },
    version: 2,
  };

  const merged = withMockedNow(206_000, () =>
    mergeRoomState(local, remote, 100_000),
  );

  assert.equal(merged.timerDuration, 30);
  assert.equal(merged.timerEndsAt, 236_000);
  assert.equal(merged.autoReveal, true);
});
