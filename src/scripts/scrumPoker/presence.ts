import type { RoomActions } from './actions';
import type {
  ParticipantIdentity,
  RelayedMessage,
  ScrumPokerNetwork,
} from './network';

import {
  activePlayers,
  PRESENCE_TIMEOUT_MS,
  type RoomState,
} from './state';

export type PresenceController = {
  announcePresence: () => void;
  bindPresenceHandlers: () => void;
  disposePresenceHandlers: () => void;
  processPresence: (
    message: Extract<RelayedMessage, { type: 'presence' }>,
  ) => void;
  startPresenceHeartbeat: () => void;
  stopPresenceHeartbeat: () => void;
};

type PresenceContext = {
  actions: RoomActions;
  getIdentity: () => ParticipantIdentity;
  getLocalPlayerId: () => string;
  getNetwork: () => ScrumPokerNetwork;
  getState: () => RoomState;
  render: () => void;
};

export const createPresenceController = ({
  actions,
  getIdentity,
  getLocalPlayerId,
  getNetwork,
  getState,
  render,
}: PresenceContext): PresenceController => {
  let presenceInterval: ReturnType<typeof setInterval> | undefined;

  const announcePresence = () => {
    const localPlayerId = getLocalPlayerId();
    if (!localPlayerId) return;
    const player = getState().players.find((item) => item.id === localPlayerId);
    if (player) {
      player.lastSeenAt = Date.now();
      player.pageHidden = document.visibilityState !== 'visible';
    }
    getNetwork().relay({
      type: 'presence',
      participant: getIdentity(),
      pageHidden: document.visibilityState !== 'visible',
      sentAt: Date.now(),
    });
    getNetwork().sendRegistryDiscover();
  };

  const processPresence = (
    message: Extract<RelayedMessage, { type: 'presence' }>,
  ) => {
    const player = getState().players.find(
      (item) => item.id === message.participant.id,
    );
    if (!player) return;
    player.lastSeenAt = Date.now();
    player.pageHidden = message.pageHidden;
    if (message.participant.peerId !== player.peerId) {
      player.peerId = message.participant.peerId;
      getNetwork().ensureTopology();
    }
    render();
  };

  const startPresenceHeartbeat = () => {
    stopPresenceHeartbeat();
    presenceInterval = globalThis.setInterval(() => {
      const localPlayerId = getLocalPlayerId();
      if (!localPlayerId) return;
      announcePresence();
      const now = Date.now();
      for (const player of activePlayers(getState())) {
        if (
          player.id !== localPlayerId &&
          now - player.lastSeenAt >= PRESENCE_TIMEOUT_MS
        )
          actions.dispatchAction(
            actions.makeAction('leave', { playerId: player.id }),
          );
      }
      getNetwork().pingPeers(now);
      getNetwork().broadcastDirectory();
      render();
    }, getNetwork().heartbeatIntervalMs);
  };

  function stopPresenceHeartbeat() {
    globalThis.clearInterval(presenceInterval);
    presenceInterval = undefined;
  }

  const handleResume = () => {
    if (document.visibilityState !== 'visible' || !getLocalPlayerId()) return;
    actions.announceJoin();
    announcePresence();
    getNetwork().connectToRegistry();
    getNetwork().ensureTopology();
  };

  const handleVisibilityChange = () => {
    if (!getLocalPlayerId()) return;
    announcePresence();
    handleResume();
  };

  const bindPresenceHandlers = () => {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handleResume);
    globalThis.addEventListener('online', handleResume);
  };

  const disposePresenceHandlers = () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pageshow', handleResume);
    globalThis.removeEventListener('online', handleResume);
    stopPresenceHeartbeat();
  };

  return {
    announcePresence,
    bindPresenceHandlers,
    disposePresenceHandlers,
    processPresence,
    startPresenceHeartbeat,
    stopPresenceHeartbeat,
  };
};
