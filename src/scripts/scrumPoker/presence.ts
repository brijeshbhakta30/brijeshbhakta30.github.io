import type { RoomActions } from './actions';
import type {
  ParticipantIdentity,
  RelayedMessage,
  ScrumPokerNetwork,
} from './network';

import { incrementDebugCounter } from './debug';
import {
  activePlayers,
  PRESENCE_TIMEOUT_MS,
  presenceFor,
  type RoomState,
} from './state';

export type PresenceController = {
  announcePresence: () => void;
  bindPresenceHandlers: () => void;
  disposePresenceHandlers: () => void;
  processPresence: (
    message: Extract<RelayedMessage, { type: 'presence' }>,
  ) => boolean;
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
  let pingInterval: ReturnType<typeof setInterval> | undefined;
  let statusInterval: ReturnType<typeof setInterval> | undefined;
  let renderedPresenceSnapshot = '';

  const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;
  const PING_INTERVAL_MS = 20_000;
  const PRESENCE_STATUS_INTERVAL_MS = 5000;

  const presenceSnapshot = (now: number) =>
    activePlayers(getState())
      .map((player) =>
        [
          player.id,
          presenceFor(player, now, getNetwork().hasOpenConnection(player)),
        ].join(':'),
      )
      .join('|');

  const renderIfPresenceStatusChanged = (now = Date.now()) => {
    const nextSnapshot = presenceSnapshot(now);
    if (nextSnapshot === renderedPresenceSnapshot) return;
    renderedPresenceSnapshot = nextSnapshot;
    render();
  };

  const announcePresence = () => {
    const localPlayerId = getLocalPlayerId();
    const identity = getIdentity();
    if (!localPlayerId || !identity.peerId) return;
    const sentAt = Date.now();
    const player = getState().players.find((item) => item.id === localPlayerId);
    if (player) {
      const pageHidden = document.visibilityState !== 'visible';
      player.lastSeenAt = sentAt;
      player.pageHidden = pageHidden;
      player.pageHiddenAt = pageHidden
        ? (player.pageHiddenAt ?? sentAt)
        : undefined;
      player.presenceSentAt = sentAt;
    }
    incrementDebugCounter('presenceMessagesSent');
    getNetwork().relay({
      type: 'presence',
      participant: identity,
      pageHidden: document.visibilityState !== 'visible',
      sentAt,
    });
  };

  const processPresence = (
    message: Extract<RelayedMessage, { type: 'presence' }>,
  ) => {
    const now = Date.now();
    const player = getState().players.find(
      (item) => item.id === message.participant.id,
    );
    if (!player) return false;
    const previousStatus = presenceFor(
      player,
      now,
      getNetwork().hasOpenConnection(player),
    );
    const previousPageHidden = player.pageHidden;
    const previousPeerId = player.peerId;
    player.lastSeenAt = now;

    const latestPresenceSentAt = player.presenceSentAt ?? 0;
    const stalePresence = message.sentAt < latestPresenceSentAt;
    if (stalePresence) {
      incrementDebugCounter('presenceStaleMessagesIgnored');
    } else {
      player.pageHidden = message.pageHidden;
      player.pageHiddenAt = message.pageHidden
        ? (previousPageHidden ? player.pageHiddenAt : now)
        : undefined;
      player.presenceSentAt = message.sentAt;
    }

    if (!stalePresence && message.participant.peerId !== player.peerId) {
      player.peerId = message.participant.peerId;
      getNetwork().ensureTopology();
    }
    const nextStatus = presenceFor(
      player,
      now,
      getNetwork().hasOpenConnection(player),
    );
    if (
      previousStatus !== nextStatus ||
      previousPageHidden !== player.pageHidden ||
      previousPeerId !== player.peerId
    ) {
      renderIfPresenceStatusChanged(now);
    }
    return previousPeerId !== player.peerId;
  };

  const startPresenceHeartbeat = () => {
    stopPresenceHeartbeat();
    announcePresence();
    renderedPresenceSnapshot = presenceSnapshot(Date.now());
    presenceInterval = globalThis.setInterval(() => {
      const localPlayerId = getLocalPlayerId();
      if (!localPlayerId) return;
      announcePresence();
    }, PRESENCE_HEARTBEAT_INTERVAL_MS);
    pingInterval = globalThis.setInterval(() => {
      if (!getLocalPlayerId()) return;
      getNetwork().pingPeers(Date.now());
    }, PING_INTERVAL_MS);
    statusInterval = globalThis.setInterval(() => {
      const localPlayerId = getLocalPlayerId();
      if (!localPlayerId) return;
      const now = Date.now();
      let removedPlayer = false;
      for (const player of activePlayers(getState())) {
        if (
          player.id !== localPlayerId &&
          now - player.lastSeenAt >= PRESENCE_TIMEOUT_MS
        ) {
          actions.dispatchAction(
            actions.makeAction('leave', { playerId: player.id }),
          );
          removedPlayer = true;
        }
      }
      if (!removedPlayer) renderIfPresenceStatusChanged(now);
    }, PRESENCE_STATUS_INTERVAL_MS);
  };

  function stopPresenceHeartbeat() {
    globalThis.clearInterval(presenceInterval);
    globalThis.clearInterval(pingInterval);
    globalThis.clearInterval(statusInterval);
    presenceInterval = undefined;
    pingInterval = undefined;
    statusInterval = undefined;
    renderedPresenceSnapshot = '';
  }

  const handleResume = () => {
    if (document.visibilityState !== 'visible' || !getLocalPlayerId()) return;
    actions.announceJoin();
    announcePresence();
    getNetwork().connectToRegistry();
    getNetwork().sendRegistryDiscover();
    getNetwork().ensureTopology();
  };

  const handleVisibilityChange = () => {
    if (!getLocalPlayerId()) return;
    if (document.visibilityState === 'visible') {
      handleResume();
      renderIfPresenceStatusChanged();
      return;
    }
    announcePresence();
    renderIfPresenceStatusChanged();
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
