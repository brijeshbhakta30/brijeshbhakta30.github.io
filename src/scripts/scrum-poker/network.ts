import Peer, { type DataConnection } from 'peerjs';
import {
  activePlayers,
  makeRandomId,
  mergeRoomState,
  type Player,
  type RoomAction,
  type RoomState,
} from './state';
import { DEBUG_SESSION_KEY } from './constants';
import type { ConnectionStatus } from './render';

export type ParticipantIdentity = { id: string; peerId: string; name: string };

type DirectMessage =
  | { type: 'hello'; participant: ParticipantIdentity; state: RoomState }
  | { type: 'snapshot'; state: RoomState }
  | { type: 'ping'; sentAt: number }
  | { type: 'pong'; sentAt: number };

export type RelayedMessage =
  | { type: 'action'; action: RoomAction }
  | {
      type: 'presence';
      participant: ParticipantIdentity;
      pageHidden: boolean;
      sentAt: number;
    };

type Envelope = {
  type: 'relay';
  id: string;
  originId: string;
  payload: RelayedMessage;
};

type RegistryMessage =
  | { type: 'discover'; participant: ParticipantIdentity }
  | { type: 'welcome'; peerIds: string[]; state: RoomState }
  | { type: 'directory'; peerIds: string[] };

export type ConnectionDiagnostics = {
  participantId?: string;
  peerId: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  lastChangedAt: number;
};

const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 3_000;
const REGISTRY_RETRY_MS = 2_000;

const configuredStunUrls = (
  import.meta.env.PUBLIC_STUN_URLS ?? 'stun:stun.l.google.com:19302'
)
  .split(',')
  .map((url: string) => url.trim())
  .filter(Boolean)
  .slice(0, 5);
const configuredTurnUrls = (import.meta.env.PUBLIC_TURN_URLS ?? '')
  .split(',')
  .map((url: string) => url.trim())
  .filter(Boolean)
  .slice(0, 5);
const iceServers: RTCIceServer[] = configuredStunUrls.length
  ? [{ urls: configuredStunUrls }]
  : [];
if (configuredTurnUrls.length) {
  iceServers.push({
    urls: configuredTurnUrls,
    username: import.meta.env.PUBLIC_TURN_USERNAME ?? '',
    credential: import.meta.env.PUBLIC_TURN_CREDENTIAL ?? '',
  });
}
const PEER_OPTIONS = {
  debug: 0 as const,
  config: {
    iceServers,
    iceTransportPolicy: (import.meta.env.PUBLIC_ICE_TRANSPORT_POLICY === 'relay'
      ? 'relay'
      : 'all') as RTCIceTransportPolicy,
    sdpSemantics: 'unified-plan',
  },
};

export const DEBUG_BUILD =
  import.meta.env.DEV || import.meta.env.PUBLIC_SCRUM_POKER_DEBUG === 'true';

const registryPeerId = (roomCode: string) =>
  `brijesh-scrum-${roomCode.toLowerCase()}`;

const sendOpen = (connection: DataConnection | undefined, message: unknown) => {
  if (connection?.open) connection.send(message);
};

export const createScrumPokerNetwork = ({
  getState,
  setState,
  getRoomCode,
  getLocalPeerId,
  setLocalPeerId,
  getLocalPlayerId,
  getIdentity,
  onAction,
  onPresence,
  announceJoin,
  restoreLocalVote,
  render,
  setConnection,
  showToast,
  showError,
}: {
  getState: () => RoomState;
  setState: (state: RoomState) => void;
  getRoomCode: () => string;
  getLocalPeerId: () => string;
  setLocalPeerId: (peerId: string) => void;
  getLocalPlayerId: () => string;
  getIdentity: () => ParticipantIdentity;
  onAction: (action: RoomAction, shouldRelay: boolean) => void;
  onPresence: (message: Extract<RelayedMessage, { type: 'presence' }>) => void;
  announceJoin: () => void;
  restoreLocalVote: () => void;
  render: () => void;
  setConnection: (label: string, status: ConnectionStatus) => void;
  showToast: (message: string) => void;
  showError: (message: string) => void;
}) => {
  let peer: Peer | undefined;
  let registryPeer: Peer | undefined;
  let registryConnection: DataConnection | undefined;
  const registryConnections = new Map<string, DataConnection>();
  const connections = new Map<string, DataConnection>();
  const connectionParticipants = new Map<string, string>();
  const diagnostics = new Map<string, ConnectionDiagnostics>();
  const reconnectTimers = new Map<string, number>();
  const connectionAttemptTimers = new Map<string, number>();
  let registryRetryTimer: number | undefined;
  let seenMessages = new Set<string>();
  let disposed = false;

  const visiblePlayers = () => activePlayers(getState());

  const rememberSeen = (id: string) => {
    seenMessages.add(id);
    if (seenMessages.size > 2_000)
      seenMessages = new Set([...seenMessages].slice(-1_000));
  };

  const broadcastRaw = (message: unknown, exceptPeerId = '') => {
    for (const [peerId, connection] of connections) {
      if (peerId !== exceptPeerId) sendOpen(connection, message);
    }
  };

  const relay = (payload: RelayedMessage) => {
    const envelope: Envelope = {
      type: 'relay',
      id: makeRandomId(),
      originId: getLocalPlayerId(),
      payload,
    };
    rememberSeen(envelope.id);
    broadcastRaw(envelope);
  };

  const mergeState = (remoteState: RoomState) => {
    const merged = mergeRoomState(getState(), remoteState);
    setState(merged);
  };

  const handleRelay = (sourcePeerId: string, envelope: Envelope) => {
    if (seenMessages.has(envelope.id)) return;
    rememberSeen(envelope.id);
    broadcastRaw(envelope, sourcePeerId);
    if (envelope.payload.type === 'action')
      onAction(envelope.payload.action, false);
    else onPresence(envelope.payload);
  };

  const logConnectionTransition = (
    peerId: string,
    reason: string,
    connection: DataConnection,
  ) => {
    const rtc = connection.peerConnection;
    const row: ConnectionDiagnostics = {
      participantId: connectionParticipants.get(peerId),
      peerId,
      connectionState: rtc.connectionState,
      iceConnectionState: rtc.iceConnectionState,
      iceGatheringState: rtc.iceGatheringState,
      signalingState: rtc.signalingState,
      lastChangedAt: Date.now(),
    };
    diagnostics.set(peerId, row);
    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true')
      console.debug('[Scrum Poker WebRTC]', reason, row);
  };

  const updateOverallConnection = () => {
    const others = visiblePlayers().filter(
      (player) => player.id !== getLocalPlayerId(),
    );
    const openCount = [...connections.values()].filter(
      (connection) => connection.open,
    ).length;
    if (!others.length || openCount)
      setConnection('Peer-to-peer room live', 'connected');
    else setConnection('Reconnecting…', 'connecting');
  };

  const scheduleReconnect = (remotePeerId: string) => {
    if (reconnectTimers.has(remotePeerId) || disposed) return;
    const timer = window.setTimeout(() => {
      reconnectTimers.delete(remotePeerId);
      if (
        activePlayers(getState()).some(
          (player) => player.peerId === remotePeerId,
        )
      )
        ensureMesh([remotePeerId]);
    }, RECONNECT_DELAY_MS);
    reconnectTimers.set(remotePeerId, timer);
  };

  const attachDiagnostics = (connection: DataConnection) => {
    const rtc = connection.peerConnection;
    const update = (reason: string) => {
      logConnectionTransition(connection.peer, reason, connection);
      if (rtc.connectionState === 'failed') {
        scheduleReconnect(connection.peer);
        connection.close();
      }
      if (rtc.connectionState === 'disconnected') {
        window.setTimeout(() => {
          if (rtc.connectionState === 'disconnected') {
            scheduleReconnect(connection.peer);
            connection.close();
          }
        }, 8_000);
      }
    };
    for (const eventName of [
      'connectionstatechange',
      'iceconnectionstatechange',
      'icegatheringstatechange',
      'signalingstatechange',
    ] as const)
      rtc.addEventListener(eventName, () => update(eventName));
    update('created');
  };

  const handleDirectMessage = (
    connection: DataConnection,
    message: DirectMessage | Envelope,
  ) => {
    if (message.type === 'relay') {
      handleRelay(connection.peer, message);
      return;
    }
    if (message.type === 'ping') {
      sendOpen(connection, { type: 'pong', sentAt: message.sentAt });
      return;
    }
    if (message.type === 'pong') return;
    if (message.type === 'snapshot') {
      mergeState(message.state);
      render();
      return;
    }
    connectionParticipants.set(connection.peer, message.participant.id);
    const diagnostic = diagnostics.get(connection.peer);
    if (diagnostic) diagnostic.participantId = message.participant.id;
    mergeState(message.state);
    const state = getState();
    const player = state.players.find(
      (item) => item.id === message.participant.id,
    );
    if (player) {
      player.peerId = message.participant.peerId;
      player.lastSeenAt = Date.now();
      player.pageHidden = false;
    }
    sendOpen(connection, { type: 'snapshot', state } satisfies DirectMessage);
    announceJoin();
    restoreLocalVote();
    render();
  };

  const registerConnection = (connection: DataConnection) => {
    const existing = connections.get(connection.peer);
    if (existing && existing !== connection && existing.open) {
      connection.close();
      return;
    }
    connections.set(connection.peer, connection);
    attachDiagnostics(connection);
    window.clearTimeout(connectionAttemptTimers.get(connection.peer));
    connectionAttemptTimers.set(
      connection.peer,
      window.setTimeout(() => {
        connectionAttemptTimers.delete(connection.peer);
        if (connection.open) return;
        if (connections.get(connection.peer) === connection)
          connections.delete(connection.peer);
        connection.close();
        scheduleReconnect(connection.peer);
      }, 15_000),
    );
    connection.on('open', () => {
      window.clearTimeout(connectionAttemptTimers.get(connection.peer));
      connectionAttemptTimers.delete(connection.peer);
      window.clearTimeout(reconnectTimers.get(connection.peer));
      reconnectTimers.delete(connection.peer);
      sendOpen(connection, {
        type: 'hello',
        participant: getIdentity(),
        state: getState(),
      } satisfies DirectMessage);
      updateOverallConnection();
    });
    connection.on('data', (data) =>
      handleDirectMessage(connection, data as DirectMessage | Envelope),
    );
    connection.on('error', (error) => {
      window.clearTimeout(connectionAttemptTimers.get(connection.peer));
      connectionAttemptTimers.delete(connection.peer);
      if (DEBUG_BUILD)
        console.debug(
          '[Scrum Poker WebRTC] data error',
          connection.peer,
          error.type,
        );
      scheduleReconnect(connection.peer);
    });
    connection.on('close', () => {
      window.clearTimeout(connectionAttemptTimers.get(connection.peer));
      connectionAttemptTimers.delete(connection.peer);
      if (connections.get(connection.peer) === connection)
        connections.delete(connection.peer);
      const previous = diagnostics.get(connection.peer);
      diagnostics.set(connection.peer, {
        participantId: previous?.participantId,
        peerId: connection.peer,
        connectionState: 'closed',
        iceConnectionState: previous?.iceConnectionState ?? 'closed',
        iceGatheringState: previous?.iceGatheringState ?? 'complete',
        signalingState: previous?.signalingState ?? 'closed',
        lastChangedAt: Date.now(),
      });
      scheduleReconnect(connection.peer);
      updateOverallConnection();
      render();
    });
  };

  function ensureMesh(peerIds: string[]) {
    const localPeerId = getLocalPeerId();
    if (!peer || !localPeerId) return;
    for (const remotePeerId of new Set(peerIds)) {
      if (
        !remotePeerId ||
        remotePeerId === localPeerId ||
        localPeerId.localeCompare(remotePeerId) <= 0 ||
        connections.has(remotePeerId)
      )
        continue;
      registerConnection(
        peer.connect(remotePeerId, {
          reliable: true,
          metadata: { room: getRoomCode(), participantId: getLocalPlayerId() },
        }),
      );
    }
  }

  const registryDirectory = () =>
    [
      ...new Set([
        getLocalPeerId(),
        ...activePlayers(getState()).map((player) => player.peerId),
        ...registryConnections.keys(),
      ]),
    ].filter(Boolean);

  const broadcastDirectory = () => {
    const peerIds = registryDirectory();
    const message = {
      type: 'directory',
      peerIds,
    } satisfies RegistryMessage;
    for (const connection of registryConnections.values())
      sendOpen(connection, message);
    ensureMesh(peerIds);
  };

  const registerRegistryClient = (connection: DataConnection) => {
    registryConnections.set(connection.peer, connection);
    connection.on('data', (raw) => {
      const message = raw as RegistryMessage;
      if (message.type !== 'discover') return;
      sendOpen(connection, {
        type: 'welcome',
        peerIds: registryDirectory(),
        state: getState(),
      } satisfies RegistryMessage);
      broadcastDirectory();
    });
    connection.on('close', () => registryConnections.delete(connection.peer));
    connection.on('error', () => registryConnections.delete(connection.peer));
  };

  const scheduleRegistryElection = () => {
    if (registryPeer || registryRetryTimer || disposed) return;
    const ids = visiblePlayers()
      .map((player) => player.id)
      .concat(getLocalPlayerId())
      .sort();
    const index = Math.max(0, ids.indexOf(getLocalPlayerId()));
    registryRetryTimer = window.setTimeout(
      () => {
        registryRetryTimer = undefined;
        claimRegistry();
      },
      300 + index * 300,
    );
  };

  const connectToRegistry = () => {
    if (!peer || !getLocalPeerId() || registryConnection?.open || disposed)
      return;
    registryConnection?.close();
    const connection = peer.connect(registryPeerId(getRoomCode()), {
      reliable: true,
      metadata: { discovery: true, room: getRoomCode() },
    });
    registryConnection = connection;
    const attemptTimeout = window.setTimeout(() => {
      if (connection.open) return;
      connection.close();
      scheduleRegistryElection();
    }, 15_000);
    connection.on('open', () => {
      window.clearTimeout(attemptTimeout);
      window.clearTimeout(registryRetryTimer);
      registryRetryTimer = undefined;
      sendOpen(connection, {
        type: 'discover',
        participant: getIdentity(),
      } satisfies RegistryMessage);
    });
    connection.on('data', (raw) => {
      const message = raw as RegistryMessage;
      if (message.type === 'welcome') {
        mergeState(message.state);
        ensureMesh(message.peerIds);
        announceJoin();
        restoreLocalVote();
        render();
      } else if (message.type === 'directory') ensureMesh(message.peerIds);
    });
    const lostRegistry = () => {
      window.clearTimeout(attemptTimeout);
      if (registryConnection === connection) registryConnection = undefined;
      scheduleRegistryElection();
    };
    connection.on('close', lostRegistry);
    connection.on('error', lostRegistry);
  };

  function claimRegistry() {
    const roomCode = getRoomCode();
    if (registryPeer || registryConnection?.open || disposed || !roomCode)
      return;
    const candidate = new Peer(registryPeerId(roomCode), PEER_OPTIONS);
    registryPeer = candidate;
    candidate.on('open', () => {
      registryConnection?.close();
      registryConnection = undefined;
      candidate.on('connection', registerRegistryClient);
      broadcastDirectory();
      announceJoin();
      restoreLocalVote();
      updateOverallConnection();
    });
    candidate.on('error', (error) => {
      if (registryPeer === candidate) registryPeer = undefined;
      if (!candidate.destroyed) candidate.destroy();
      if (error.type === 'unavailable-id') {
        window.setTimeout(connectToRegistry, REGISTRY_RETRY_MS);
        return;
      }
      scheduleRegistryElection();
    });
    candidate.on('disconnected', () => {
      if (
        disposed ||
        registryPeer !== candidate ||
        candidate.destroyed ||
        !candidate.disconnected
      )
        return;
      try {
        candidate.reconnect();
      } catch (error) {
        if (DEBUG_BUILD)
          console.debug(
            '[Scrum Poker WebRTC] discovery reconnect skipped',
            error,
          );
      }
    });
  }

  const start = () => {
    destroy();
    disposed = false;
    setConnection('Joining peer mesh', 'connecting');
    const roomPeer = new Peer(PEER_OPTIONS);
    peer = roomPeer;
    roomPeer.on('open', (id) => {
      if (peer !== roomPeer || roomPeer.destroyed) return;
      setLocalPeerId(id);
      roomPeer.on('connection', registerConnection);
      connectToRegistry();
      window.setTimeout(() => {
        if (!registryConnection?.open && !registryPeer)
          scheduleRegistryElection();
      }, REGISTRY_RETRY_MS);
    });
    roomPeer.on('error', (error) => {
      if (peer !== roomPeer || roomPeer.destroyed) return;
      if (error.type === 'peer-unavailable') {
        scheduleRegistryElection();
        return;
      }
      if (error.type === 'webrtc') {
        showToast('One peer connection failed; the room will keep retrying');
        return;
      }
      showError(
        'The peer-to-peer room could not be reached. Check your connection and try again.',
      );
    });
    roomPeer.on('disconnected', () => {
      if (peer !== roomPeer || disposed || roomPeer.destroyed) return;
      setConnection('Reconnecting…', 'connecting');
      if (!roomPeer.disconnected) return;
      try {
        roomPeer.reconnect();
      } catch (error) {
        if (DEBUG_BUILD)
          console.debug('[Scrum Poker WebRTC] reconnect skipped', error);
      }
    });
  };

  function destroy() {
    disposed = true;
    window.clearTimeout(registryRetryTimer);
    registryRetryTimer = undefined;
    for (const timer of reconnectTimers.values()) window.clearTimeout(timer);
    reconnectTimers.clear();
    for (const timer of connectionAttemptTimers.values())
      window.clearTimeout(timer);
    connectionAttemptTimers.clear();
    registryConnection?.close();
    registryConnection = undefined;
    for (const connection of connections.values()) connection.close();
    for (const connection of registryConnections.values()) connection.close();
    connections.clear();
    registryConnections.clear();
    connectionParticipants.clear();
    registryPeer?.destroy();
    peer?.destroy();
    registryPeer = undefined;
    peer = undefined;
  }

  return {
    start,
    destroy,
    relay,
    ensureMesh,
    connectToRegistry,
    broadcastDirectory,
    sendRegistryDiscover: () => {
      sendOpen(registryConnection, {
        type: 'discover',
        participant: getIdentity(),
      } satisfies RegistryMessage);
    },
    pingPeers: (sentAt: number) => {
      for (const connection of connections.values())
        sendOpen(connection, {
          type: 'ping',
          sentAt,
        } satisfies DirectMessage);
    },
    hasOpenConnection: (player: Player) => {
      if (player.id === getLocalPlayerId()) return true;
      const peerId = [...connectionParticipants.entries()].find(
        ([, participantId]) => participantId === player.id,
      )?.[0];
      return peerId ? connections.get(peerId)?.open === true : false;
    },
    diagnostics: () => diagnostics,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
};

export type ScrumPokerNetwork = ReturnType<typeof createScrumPokerNetwork>;
