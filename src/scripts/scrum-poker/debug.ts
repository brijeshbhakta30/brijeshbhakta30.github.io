import {
  activePlayers,
  presenceFor,
  votingStatusFor,
  type Player,
  type RoomState,
} from './state';
import { DEBUG_CHEAT_CODE, DEBUG_SESSION_KEY } from './constants';
import type { ConnectionDiagnostics } from './network';

declare global {
  interface Window {
    scrumPoker?: {
      help: () => void;
      showValues: () => void;
      showParticipants: () => void;
      showRoomState: () => void;
      showConnections: () => void;
    };
  }
}

export const enableDebugApi = ({
  getState,
  getCurrentRoom,
  getLocalPlayerId,
  getLocalVote,
  getDiagnostics,
  hasOpenConnection,
  debugBuild,
}: {
  getState: () => RoomState;
  getCurrentRoom: () => string;
  getLocalPlayerId: () => string;
  getLocalVote: () => string | null;
  getDiagnostics: () => Map<string, ConnectionDiagnostics>;
  hasOpenConnection: (player: Player) => boolean;
  debugBuild: boolean;
}) => {
  const visiblePlayers = () => activePlayers(getState());
  const playerPresence = (player: Player) =>
    presenceFor(player, Date.now(), hasOpenConnection(player));

  sessionStorage.setItem(DEBUG_SESSION_KEY, 'true');
  window.scrumPoker = {
    help: () =>
      console.table([
        {
          command: 'scrumPoker.help()',
          description: 'List debug commands.',
        },
        {
          command: 'scrumPoker.showValues()',
          description: 'Show vote values when the privacy policy permits it.',
        },
        {
          command: 'scrumPoker.showParticipants()',
          description: 'Show participant, voting, and presence state.',
        },
        {
          command: 'scrumPoker.showRoomState()',
          description: 'Show synchronized round, timer, and configuration.',
        },
        {
          command: 'scrumPoker.showConnections()',
          description: 'Show WebRTC state for every direct connection.',
        },
      ]),
    showValues: () => {
      const state = getState();
      if (!state.revealed && !debugBuild) {
        console.info('Hidden vote inspection is disabled in production.');
        return;
      }
      console.table(
        visiblePlayers().map((player) => ({
          name: player.name,
          estimate:
            player.voteRoundId !== state.roundId
              ? '—'
              : player.id === getLocalPlayerId() && !state.revealed
                ? (getLocalVote() ?? '—')
                : (player.vote ?? (player.hasVoted ? '?' : '—')),
          status: votingStatusFor(player, state, playerPresence(player)),
        })),
      );
      if (!state.revealed)
        console.info(
          'Other hidden estimates are not transmitted to this peer, including in development.',
        );
    },
    showParticipants: () => {
      const state = getState();
      console.table(
        visiblePlayers().map((player) => ({
          name: player.name,
          participantId: player.id,
          peerId: player.peerId,
          status: votingStatusFor(player, state, playerPresence(player)),
          presenceState: playerPresence(player),
          lastSeenAt: new Date(player.lastSeenAt).toISOString(),
          hasVoted: player.voteRoundId === state.roundId && player.hasVoted,
        })),
      );
    },
    showRoomState: () => {
      const state = getState();
      console.table([
        {
          roomCode: getCurrentRoom(),
          round: state.round,
          roundId: state.roundId,
          version: state.version,
          revealed: state.revealed,
          timerDuration: state.timerDuration,
          timerEndsAt: state.timerEndsAt
            ? new Date(state.timerEndsAt).toISOString()
            : null,
          autoReveal: state.autoReveal,
          allowVoteChangesAfterReveal: state.allowVoteChangesAfterReveal,
          participantCount: visiblePlayers().length,
        },
      ]);
    },
    showConnections: () => {
      const state = getState();
      console.table(
        [...getDiagnostics().values()].map((row) => {
          const player = state.players.find(
            (item) => item.id === row.participantId,
          );
          return {
            participant: player?.name ?? 'Unknown',
            participantId: row.participantId ?? 'Unknown',
            peerId: row.peerId,
            connectionState: row.connectionState,
            iceConnectionState: row.iceConnectionState,
            iceGatheringState: row.iceGatheringState,
            signalingState: row.signalingState,
            presenceState: player ? playerPresence(player) : 'reconnecting',
            lastChangedAt: new Date(row.lastChangedAt).toISOString(),
          };
        }),
      );
    },
  };
  console.info(
    'Scrum Poker debug mode enabled. Run scrumPoker.help() for available commands.',
  );
};

export const createDebugCheatCodeHandler = ({
  enable,
  showToast,
}: {
  enable: () => void;
  showToast: (message: string) => void;
}) => {
  let cheatCodeBuffer = '';

  return (event: KeyboardEvent) => {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.key.length !== 1
    )
      return;
    cheatCodeBuffer = `${cheatCodeBuffer}${event.key.toLowerCase()}`.slice(
      -DEBUG_CHEAT_CODE.length,
    );
    if (cheatCodeBuffer !== DEBUG_CHEAT_CODE) return;
    enable();
    showToast('Developer debug mode enabled for this session');
    cheatCodeBuffer = '';
  };
};
