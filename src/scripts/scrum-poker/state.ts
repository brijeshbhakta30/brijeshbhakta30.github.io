export type PresenceState =
  'connected' | 'away' | 'reconnecting' | 'disconnected';

export type VotingStatus = 'choosing' | 'voted' | 'revealed' | PresenceState;

export type Clock = { counter: number; id: string };

export type Player = {
  id: string;
  peerId: string;
  name: string;
  hasVoted: boolean;
  vote: string | null;
  voteRoundId: string;
  lastSeenAt: number;
  pageHidden: boolean;
  removed: boolean;
  clocks: {
    membership: Clock;
    name: Clock;
    vote: Clock;
  };
  /** Deprecated fields are accepted from older snapshots and ignored. */
  isHost?: boolean;
  isFacilitator?: boolean;
};

export type RoomState = {
  players: Player[];
  revealed: boolean;
  round: number;
  roundId: string;
  roundBaseId: string;
  timerDuration: number;
  timerEndsAt: number | null;
  autoReveal: boolean;
  allowVoteChangesAfterReveal: boolean;
  version: number;
  clocks: {
    round: Clock;
    reveal: Clock;
    timer: Clock;
    votingConfig: Clock;
  };
  /** Deprecated ownership fields are deliberately non-authoritative. */
  facilitatorId?: string;
  hostId?: string;
};

export type RoomAction =
  | Action<
      'join',
      { playerId: string; peerId: string; name: string; now: number }
    >
  | Action<'leave', { playerId: string }>
  | Action<'rename', { playerId: string; name: string }>
  | Action<
      'vote',
      {
        playerId: string;
        roundId: string;
        hasVoted: boolean;
        vote: string | null;
      }
    >
  | Action<'reveal', { roundId: string }>
  | Action<'new-round', { baseRoundId: string }>
  | Action<
      'timer',
      {
        roundId: string;
        duration: number;
        endsAt: number | null;
        autoReveal: boolean;
      }
    >
  | Action<'voting-config', { allowVoteChangesAfterReveal: boolean }>;

type Action<T extends string, P> = {
  id: string;
  actorId: string;
  counter: number;
  type: T;
  payload: P;
};

const ZERO_CLOCK: Clock = { counter: 0, id: '' };

export const makeRandomId = () => {
  if (typeof globalThis.crypto.randomUUID === 'function')
    return globalThis.crypto.randomUUID();

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
};

export const DEFAULT_TIMER_SECONDS = 30;
export const MIN_TIMER_SECONDS = 10;
export const MAX_TIMER_SECONDS = 60 * 60;
export const PRESENCE_AWAY_MS = 30_000;
export const PRESENCE_TIMEOUT_MS = 10 * 60_000;

export const freshRoomState = (): RoomState => ({
  players: [],
  revealed: false,
  round: 1,
  roundId: 'round-1',
  roundBaseId: '',
  timerDuration: DEFAULT_TIMER_SECONDS,
  timerEndsAt: null,
  autoReveal: false,
  allowVoteChangesAfterReveal: true,
  version: 0,
  clocks: {
    round: ZERO_CLOCK,
    reveal: ZERO_CLOCK,
    timer: ZERO_CLOCK,
    votingConfig: ZERO_CLOCK,
  },
});

export const actionClock = (action: RoomAction): Clock => ({
  counter: action.counter,
  id: action.id,
});

export const compareClock = (left: Clock, right: Clock) =>
  left.counter === right.counter
    ? left.id.localeCompare(right.id)
    : left.counter - right.counter;

const newer = (candidate: Clock, current: Clock) =>
  compareClock(candidate, current) > 0;

const playerTemplate = (
  id: string,
  peerId: string,
  name: string,
  now: number,
  clock: Clock,
): Player => ({
  id,
  peerId,
  name,
  hasVoted: false,
  vote: null,
  voteRoundId: '',
  lastSeenAt: now,
  pageHidden: false,
  removed: false,
  clocks: { membership: clock, name: clock, vote: ZERO_CLOCK },
});

export const normaliseTimerDuration = (value: number) =>
  Math.min(MAX_TIMER_SECONDS, Math.max(MIN_TIMER_SECONDS, Math.round(value)));

export const applyRoomAction = (
  current: RoomState,
  action: RoomAction,
): RoomState => {
  const clock = actionClock(action);
  let state = {
    ...current,
    version: Math.max(current.version, action.counter),
  };

  if (action.type === 'join') {
    const { playerId, peerId, name, now } = action.payload;
    const existing = state.players.find((player) => player.id === playerId);
    if (!existing) {
      return {
        ...state,
        players: [
          ...state.players,
          playerTemplate(playerId, peerId, name, now, clock),
        ],
      };
    }
    if (!newer(clock, existing.clocks.membership)) return state;
    return {
      ...state,
      players: state.players.map((player) =>
        player.id === playerId
          ? {
              ...player,
              peerId,
              name: name || player.name,
              lastSeenAt: now,
              pageHidden: false,
              removed: false,
              clocks: {
                ...player.clocks,
                membership: clock,
                name: newer(clock, player.clocks.name)
                  ? clock
                  : player.clocks.name,
              },
            }
          : player,
      ),
    };
  }

  if (action.type === 'leave') {
    return {
      ...state,
      players: state.players.map((player) =>
        player.id === action.payload.playerId &&
        newer(clock, player.clocks.membership)
          ? {
              ...player,
              removed: true,
              clocks: { ...player.clocks, membership: clock },
            }
          : player,
      ),
    };
  }

  if (action.type === 'rename') {
    return {
      ...state,
      players: state.players.map((player) =>
        player.id === action.payload.playerId &&
        newer(clock, player.clocks.name)
          ? {
              ...player,
              name: action.payload.name,
              clocks: { ...player.clocks, name: clock },
            }
          : player,
      ),
    };
  }

  if (action.type === 'vote') {
    if (action.payload.roundId !== state.roundId) return state;
    return {
      ...state,
      players: state.players.map((player) =>
        player.id === action.payload.playerId &&
        newer(clock, player.clocks.vote)
          ? {
              ...player,
              hasVoted: action.payload.hasVoted,
              vote: action.payload.vote,
              voteRoundId: action.payload.roundId,
              clocks: { ...player.clocks, vote: clock },
            }
          : player,
      ),
    };
  }

  if (action.type === 'new-round') {
    const isNextRound = action.payload.baseRoundId === state.roundId;
    const isConcurrentCandidate =
      action.payload.baseRoundId === state.roundBaseId &&
      state.roundId !== action.payload.baseRoundId;
    if (
      (!isNextRound && !isConcurrentCandidate) ||
      !newer(clock, state.clocks.round)
    )
      return state;
    return {
      ...state,
      round: isNextRound ? state.round + 1 : state.round,
      roundBaseId: action.payload.baseRoundId,
      roundId: action.id,
      revealed: false,
      timerEndsAt: null,
      clocks: { ...state.clocks, round: clock, reveal: clock, timer: clock },
    };
  }

  if (action.type === 'reveal') {
    if (
      action.payload.roundId !== state.roundId ||
      !newer(clock, state.clocks.reveal)
    )
      return state;
    return {
      ...state,
      revealed: true,
      timerEndsAt: null,
      clocks: { ...state.clocks, reveal: clock, timer: clock },
    };
  }

  if (action.type === 'timer') {
    if (
      action.payload.roundId !== state.roundId ||
      !newer(clock, state.clocks.timer)
    )
      return state;
    return {
      ...state,
      timerDuration: normaliseTimerDuration(action.payload.duration),
      timerEndsAt: action.payload.endsAt,
      autoReveal: action.payload.autoReveal,
      clocks: { ...state.clocks, timer: clock },
    };
  }

  if (!newer(clock, state.clocks.votingConfig)) return state;
  return {
    ...state,
    allowVoteChangesAfterReveal: action.payload.allowVoteChangesAfterReveal,
    clocks: { ...state.clocks, votingConfig: clock },
  };
};

const mergePlayer = (local: Player | undefined, remote: Player): Player => {
  if (!local) return remote;
  const membership = newer(remote.clocks.membership, local.clocks.membership);
  const name = newer(remote.clocks.name, local.clocks.name);
  const vote = newer(remote.clocks.vote, local.clocks.vote);
  return {
    ...local,
    ...(membership
      ? {
          peerId: remote.peerId,
          removed: remote.removed,
          lastSeenAt: remote.lastSeenAt,
          pageHidden: remote.pageHidden,
        }
      : {}),
    ...(name ? { name: remote.name } : {}),
    ...(vote
      ? {
          hasVoted: remote.hasVoted,
          vote: remote.vote,
          voteRoundId: remote.voteRoundId,
        }
      : {}),
    clocks: {
      membership: membership
        ? remote.clocks.membership
        : local.clocks.membership,
      name: name ? remote.clocks.name : local.clocks.name,
      vote: vote ? remote.clocks.vote : local.clocks.vote,
    },
  };
};

export const mergeRoomState = (
  local: RoomState,
  remoteInput: RoomState,
): RoomState => {
  const remote = migrateRoomState(remoteInput);
  const remoteRoundWins = newer(remote.clocks.round, local.clocks.round);
  let merged = { ...local };
  if (remoteRoundWins) {
    merged = {
      ...merged,
      revealed: remote.revealed,
      round: remote.round,
      roundId: remote.roundId,
      roundBaseId: remote.roundBaseId,
      timerDuration: remote.timerDuration,
      timerEndsAt: remote.timerEndsAt,
      autoReveal: remote.autoReveal,
      clocks: {
        ...merged.clocks,
        round: remote.clocks.round,
        reveal: remote.clocks.reveal,
        timer: remote.clocks.timer,
      },
    };
  }

  if (remote.roundId === merged.roundId) {
    if (newer(remote.clocks.reveal, merged.clocks.reveal)) {
      merged.revealed = remote.revealed;
      merged.clocks = { ...merged.clocks, reveal: remote.clocks.reveal };
    }
    if (newer(remote.clocks.timer, merged.clocks.timer)) {
      merged.timerDuration = remote.timerDuration;
      merged.timerEndsAt = remote.timerEndsAt;
      merged.autoReveal = remote.autoReveal;
      merged.clocks = { ...merged.clocks, timer: remote.clocks.timer };
    }
  }
  if (newer(remote.clocks.votingConfig, merged.clocks.votingConfig)) {
    merged.allowVoteChangesAfterReveal = remote.allowVoteChangesAfterReveal;
    merged.clocks = {
      ...merged.clocks,
      votingConfig: remote.clocks.votingConfig,
    };
  }

  const players = new Map(merged.players.map((player) => [player.id, player]));
  for (const player of remote.players)
    players.set(player.id, mergePlayer(players.get(player.id), player));
  return {
    ...merged,
    players: [...players.values()],
    version: Math.max(local.version, remote.version),
  };
};

export const migrateRoomState = (input: RoomState): RoomState => {
  const fresh = freshRoomState();
  const raw = input as RoomState & { players?: Partial<Player>[] };
  return {
    ...fresh,
    ...raw,
    clocks: { ...fresh.clocks, ...(raw.clocks ?? {}) },
    players: (raw.players ?? []).map((rawPlayer) => {
      const player = rawPlayer as Partial<Player> & { vote?: string | null };
      return {
        ...playerTemplate(
          player.id ?? makeRandomId(),
          player.peerId ?? player.id ?? '',
          player.name ?? 'Anonymous',
          player.lastSeenAt ?? Date.now(),
          ZERO_CLOCK,
        ),
        ...player,
        hasVoted: player.hasVoted ?? player.vote != null,
        vote: player.vote === '__hidden__' ? null : (player.vote ?? null),
        clocks: {
          membership: player.clocks?.membership ?? ZERO_CLOCK,
          name: player.clocks?.name ?? ZERO_CLOCK,
          vote: player.clocks?.vote ?? ZERO_CLOCK,
        },
      };
    }),
  };
};

export const activePlayers = (state: RoomState) =>
  state.players.filter((player) => !player.removed);

export const presenceFor = (
  player: Player,
  now: number,
  hasOpenConnection: boolean,
): PresenceState => {
  const age = Math.max(0, now - player.lastSeenAt);
  if (age >= PRESENCE_TIMEOUT_MS || player.removed) return 'disconnected';
  if (player.pageHidden || age >= PRESENCE_AWAY_MS) return 'away';
  if (!hasOpenConnection && age > 5_000) return 'reconnecting';
  return 'connected';
};

export const votingStatusFor = (
  player: Player,
  state: RoomState,
  presence: PresenceState,
): VotingStatus => {
  if (presence !== 'connected') return presence;
  const hasVoted = player.voteRoundId === state.roundId && player.hasVoted;
  if (!hasVoted) return 'choosing';
  return state.revealed ? 'revealed' : 'voted';
};

export const votingStatusLabel = (status: VotingStatus) =>
  ({
    choosing: 'Choosing',
    voted: 'Voted',
    revealed: 'Revealed',
    connected: 'Choosing',
    away: 'Away',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected',
  })[status];
