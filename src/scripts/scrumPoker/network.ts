import Peer, { type DataConnection } from 'peerjs';

import type { ConnectionStatus } from './render';

import { DEBUG_SESSION_KEY } from './constants';
import {
  activePlayers,
  makeRandomId,
  mergeRoomState,
  type Player,
  type RoomAction,
  type RoomState,
} from './state';

export type ParticipantIdentity = { id: string; peerId: string; name: string };

type DirectMessage =
  | {
      type: 'hello';
      participant: ParticipantIdentity;
      state: RoomState;
      sentAt: number;
    }
  | { type: 'snapshot'; state: RoomState; sentAt: number }
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
  | { type: 'welcome'; peerIds: string[]; state: RoomState; sentAt: number }
  | { type: 'directory'; peerIds: string[] };

export type ConnectionDiagnostics = {
  participantId?: string;
  peerId: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  lastChangedAt: number;
  // Enhanced quality metrics
  connectionQuality: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
  latency?: number;
  packetsLost?: number;
  connectionAge: number;
  reconnectCount: number;
};

const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 3000;
const REGISTRY_RETRY_MS = 2000;
const CONNECTION_TIMEOUT_MS = 30_000; // Increased from 15s to 30s for high-latency regions
const REGISTRY_CONNECTION_TIMEOUT_MS = 30_000; // Increased for better reliability
const MESH_FAILURE_THRESHOLD = 3; // Number of connection failures before switching to fallback
// Enable fallback mode by default for better reliability with corporate proxies
// Can be disabled with PUBLIC_SCRUM_POKER_FALLBACK_MODE=false if needed
const FALLBACK_MODE_ENABLED = import.meta.env.PUBLIC_SCRUM_POKER_FALLBACK_MODE !== 'false';

const configuredStunUrls = (
  import.meta.env.PUBLIC_STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun2.l.google.com:19302'
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

const publicTurnServers = [
  // Asia-Pacific TURN servers (better for India users)
  'turn:turn.metered.ca:80?transport=tcp',
  'turn:turn.metered.ca:443?transport=tcp',
  'turn:turn.metered.ca:3478?transport=tcp',
  // EU/Global TURN servers (better for UK/Spain users)
  'turn:openrelay.metered.ca:80',
  'turn:openrelay.metered.ca:443',
  'turn:openrelay.metered.ca:443?transport=tcp',
  // Note: For better Asia-Pacific coverage, consider adding paid TURN services
  // like Twilio Network Traversal via PUBLIC_TURN_URLS env var
  // Example: 'turn:sg.turn.twilio.com:3478?transport=tcp'
];

const iceServers: RTCIceServer[] = configuredStunUrls.length > 0
  ? [{ urls: configuredStunUrls }]
  : [];

if (configuredTurnUrls.length > 0) {
  iceServers.push({
    urls: configuredTurnUrls,
    username: import.meta.env.PUBLIC_TURN_USERNAME ?? '',
    credential: import.meta.env.PUBLIC_TURN_CREDENTIAL ?? '',
  });
} else {
  iceServers.push({
    urls: publicTurnServers,
    username: 'openrelayproject',
    credential: 'openrelayproject',
  });
}
const PEER_OPTIONS = {
  debug: 0 as const,
  config: {
    iceServers,
    // Keep direct/STUN candidates enabled by default. Use relay only with
    // configured TURN credentials when explicitly testing or requiring relay.
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
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const connectionAttemptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectCounters = new Map<string, number>();
  const connectionStartTimes = new Map<string, number>();
  const pingResults = new Map<string, number[]>();
  let totalMeshFailures = 0;
  let usingFallbackMode = FALLBACK_MODE_ENABLED;
  let registryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let registryAttemptTimer: ReturnType<typeof setTimeout> | undefined;
  let seenMessages = new Set<string>();
  let disposed = false;

  const visiblePlayers = () => activePlayers(getState());

  const calculateConnectionQuality = (
    peerId: string,
    connectionState: RTCPeerConnectionState,
    iceConnectionState: RTCIceConnectionState,
  ): 'excellent' | 'good' | 'fair' | 'poor' | 'unknown' => {
    if (connectionState !== 'connected' || iceConnectionState !== 'connected') {
      return 'poor';
    }
    
    const pings = pingResults.get(peerId) || [];
    if (pings.length === 0) return 'unknown';
    
    const avgLatency = pings.reduce((a, b) => a + b, 0) / pings.length;
    const reconnectCount = reconnectCounters.get(peerId) || 0;
    
    if (avgLatency < 100 && reconnectCount === 0) return 'excellent';
    if (avgLatency < 200 && reconnectCount <= 1) return 'good';
    if (avgLatency < 500 && reconnectCount <= 3) return 'fair';
    return 'poor';
  };

  const rememberSeen = (id: string) => {
    seenMessages.add(id);
    if (seenMessages.size > 2000)
      seenMessages = new Set([...seenMessages].slice(-1000));
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

  const mergeState = (remoteState: RoomState, sentAt?: number) => {
    const merged = mergeRoomState(getState(), remoteState, sentAt);
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
    const connectionQuality = calculateConnectionQuality(
      peerId,
      rtc.connectionState,
      rtc.iceConnectionState,
    );
    const pings = pingResults.get(peerId) || [];
    const avgLatency = pings.length > 0 
      ? pings.reduce((a, b) => a + b, 0) / pings.length 
      : undefined;
    
    const row: ConnectionDiagnostics = {
      participantId: connectionParticipants.get(peerId),
      peerId,
      connectionState: rtc.connectionState,
      iceConnectionState: rtc.iceConnectionState,
      iceGatheringState: rtc.iceGatheringState,
      signalingState: rtc.signalingState,
      lastChangedAt: Date.now(),
      connectionQuality,
      latency: avgLatency,
      connectionAge: connectionStartTimes.get(peerId) 
        ? Date.now() - connectionStartTimes.get(peerId)! 
        : 0,
      reconnectCount: reconnectCounters.get(peerId) || 0,
    };
    diagnostics.set(peerId, row);
    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
      // eslint-disable-next-line no-console
      console.debug('[Scrum Poker WebRTC]', reason, row);
      
      // Enhanced logging for connection failures
      if (rtc.connectionState === 'failed' || rtc.iceConnectionState === 'failed') {
        // eslint-disable-next-line no-console
        console.error('[Scrum Poker WebRTC] Connection failed details:', {
          peerId,
          participantId: connectionParticipants.get(peerId),
          connectionState: rtc.connectionState,
          iceConnectionState: rtc.iceConnectionState,
          iceGatheringState: rtc.iceGatheringState,
          signalingState: rtc.signalingState,
          connectionQuality,
          latency: avgLatency,
          reconnectCount: reconnectCounters.get(peerId) || 0,
          iceTransportPolicy: PEER_OPTIONS.config.iceTransportPolicy,
          iceServersCount: iceServers.length,
          reason,
          timestamp: new Date().toISOString(),
        });
      }
    }
  };

  const updateOverallConnection = () => {
    const others = visiblePlayers().filter(
      (player) => player.id !== getLocalPlayerId(),
    );
    const openCount = [...connections.values()].filter(
      (connection) => connection.open,
    ).length;
    if (others.length === 0 || openCount)
      setConnection('Peer-to-peer room live', 'connected');
    else setConnection('Reconnecting…', 'connecting');
  };

  const scheduleReconnect = (remotePeerId: string) => {
    if (reconnectTimers.has(remotePeerId) || disposed) return;
    
    // Increment reconnect counter
    const currentCount = reconnectCounters.get(remotePeerId) || 0;
    reconnectCounters.set(remotePeerId, currentCount + 1);
    totalMeshFailures++;
    
    // Check if we should switch to fallback mode
    if (!usingFallbackMode && totalMeshFailures >= MESH_FAILURE_THRESHOLD) {
      usingFallbackMode = true;
      if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
        // eslint-disable-next-line no-console
        console.warn('[Scrum Poker WebRTC] Switching to fallback mode due to mesh failures', {
          totalFailures: totalMeshFailures,
          threshold: MESH_FAILURE_THRESHOLD,
        });
      }
      showToast('Switching to conservative connection mode for better reliability');
    }
    
    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
      // eslint-disable-next-line no-console
      console.log('[Scrum Poker WebRTC] Scheduling reconnect:', {
        peerId: remotePeerId,
        reconnectCount: currentCount + 1,
        totalMeshFailures,
        usingFallbackMode,
      });
    }
    
    // Use longer delay in fallback mode
    const delay = usingFallbackMode ? RECONNECT_DELAY_MS * 2 : RECONNECT_DELAY_MS;
    
    const timer = globalThis.setTimeout(() => {
      reconnectTimers.delete(remotePeerId);
      if (
        activePlayers(getState()).some(
          (player) => player.peerId === remotePeerId,
        )
      )
        ensureMesh([remotePeerId]);
    }, delay);
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
        globalThis.setTimeout(() => {
          if (rtc.connectionState === 'disconnected') {
            scheduleReconnect(connection.peer);
            connection.close();
          }
        }, 8000);
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
    if (message.type === 'pong') {
      // Calculate and store latency
      const latency = Date.now() - message.sentAt;
      const pings = pingResults.get(connection.peer) || [];
      pings.push(latency);
      // Keep only last 10 ping results
      if (pings.length > 10) pings.shift();
      pingResults.set(connection.peer, pings);
      
      if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
        // eslint-disable-next-line no-console
        console.debug('[Scrum Poker WebRTC] Ping response:', {
          peerId: connection.peer,
          latency,
          avgLatency: pings.reduce((a, b) => a + b, 0) / pings.length,
        });
      }
      return;
    }
    if (message.type === 'snapshot') {
      mergeState(message.state, message.sentAt);
      render();
      return;
    }
    connectionParticipants.set(connection.peer, message.participant.id);
    const diagnostic = diagnostics.get(connection.peer);
    if (diagnostic) diagnostic.participantId = message.participant.id;
    mergeState(message.state, message.sentAt);
    const state = getState();
    const player = state.players.find(
      (item) => item.id === message.participant.id,
    );
    if (player) {
      player.peerId = message.participant.peerId;
      player.lastSeenAt = Date.now();
      player.pageHidden = false;
    }
    sendOpen(connection, {
      type: 'snapshot',
      state,
      sentAt: Date.now(),
    } satisfies DirectMessage);
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
    globalThis.clearTimeout(connectionAttemptTimers.get(connection.peer));
    connectionAttemptTimers.set(
      connection.peer,
      globalThis.setTimeout(() => {
        connectionAttemptTimers.delete(connection.peer);
        if (connection.open) return;
        if (connections.get(connection.peer) === connection)
          connections.delete(connection.peer);
        connection.close();
        
        if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
          // eslint-disable-next-line no-console
          console.warn('[Scrum Poker WebRTC] Connection attempt timeout:', {
            peerId: connection.peer,
            participantId: connectionParticipants.get(connection.peer),
            timeout: CONNECTION_TIMEOUT_MS,
          });
        }
        
        scheduleReconnect(connection.peer);
      }, CONNECTION_TIMEOUT_MS),
    );
    connection.on('open', () => {
      globalThis.clearTimeout(connectionAttemptTimers.get(connection.peer));
      connectionAttemptTimers.delete(connection.peer);
      globalThis.clearTimeout(reconnectTimers.get(connection.peer));
      reconnectTimers.delete(connection.peer);
      
      // Track connection start time and reset ping results
      connectionStartTimes.set(connection.peer, Date.now());
      pingResults.set(connection.peer, []);
      
      if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
        // eslint-disable-next-line no-console
        console.log('[Scrum Poker WebRTC] Connection established:', {
          peerId: connection.peer,
          reconnectCount: reconnectCounters.get(connection.peer) || 0,
        });
      }
      
      sendOpen(connection, {
        type: 'hello',
        participant: getIdentity(),
        state: getState(),
        sentAt: Date.now(),
      } satisfies DirectMessage);
      updateOverallConnection();
    });
    connection.on('data', (data) =>
      handleDirectMessage(connection, data as DirectMessage | Envelope),
    );
    connection.on('error', (error) => {
      globalThis.clearTimeout(connectionAttemptTimers.get(connection.peer));
      connectionAttemptTimers.delete(connection.peer);
      if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
        // eslint-disable-next-line no-console
        console.error('[Scrum Poker WebRTC] Data connection error:', {
          peerId: connection.peer,
          participantId: connectionParticipants.get(connection.peer),
          errorType: error.type,
          errorMessage: error.message,
          timestamp: new Date().toISOString(),
        });
      }
      scheduleReconnect(connection.peer);
    });
    connection.on('close', () => {
      globalThis.clearTimeout(connectionAttemptTimers.get(connection.peer));
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
        connectionQuality: 'poor',
        latency: previous?.latency,
        connectionAge: previous?.connectionAge ?? 0,
        reconnectCount: previous?.reconnectCount ?? 0,
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
        connections.has(remotePeerId)
      )
        continue;
      
      // In fallback mode, be more selective about connections
      if (usingFallbackMode) {
        const existingConnections = connections.size;
        const maxConnections = Math.min(5, peerIds.length); // Limit connections in fallback mode
        if (existingConnections >= maxConnections) {
          if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
            // eslint-disable-next-line no-console
            console.log('[Scrum Poker WebRTC] Skipping connection in fallback mode (limit reached)', {
              existingConnections,
              maxConnections,
            });
          }
          continue;
        }
      }
      
      if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
        // eslint-disable-next-line no-console
        console.log('[Scrum Poker WebRTC] Establishing mesh connection:', {
          localPeerId,
          remotePeerId,
          roomCode: getRoomCode(),
          usingFallbackMode,
        });
      }
      
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
        sentAt: Date.now(),
      } satisfies RegistryMessage);
      broadcastDirectory();
    });
    connection.on('close', () => registryConnections.delete(connection.peer));
    connection.on('error', () => registryConnections.delete(connection.peer));
  };

  const scheduleRegistryElection = () => {
    if (registryPeer || registryRetryTimer || disposed) return;
    const localPlayerId = getLocalPlayerId();
    const ids = [
      ...visiblePlayers().map((player) => player.id),
      localPlayerId,
    ].toSorted((left, right) => left.localeCompare(right));
    const index = Math.max(0, ids.indexOf(localPlayerId));
    
    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
      // eslint-disable-next-line no-console
      console.log('[Scrum Poker WebRTC] Scheduling registry election:', {
        localPlayerId,
        index,
        totalPlayers: ids.length,
        delay: 300 + index * 300,
      });
    }
    
    registryRetryTimer = globalThis.setTimeout(
      () => {
        registryRetryTimer = undefined;
        claimRegistry();
      },
      300 + index * 300,
    );
  };

  const releaseRegistryConnection = (
    connection: DataConnection,
    logMessage: string,
  ) => {
    if (registryConnection !== connection) return;
    globalThis.clearTimeout(registryAttemptTimer);
    registryAttemptTimer = undefined;
    registryConnection = undefined;

    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
      // eslint-disable-next-line no-console
      console.warn('[Scrum Poker WebRTC]', logMessage);
    }

    scheduleRegistryElection();
  };

  const connectToRegistry = () => {
    if (!peer || !getLocalPeerId() || registryConnection?.open || disposed)
      return;
    globalThis.clearTimeout(registryAttemptTimer);
    registryAttemptTimer = undefined;
    registryConnection?.close();
    const connection = peer.connect(registryPeerId(getRoomCode()), {
      reliable: true,
      metadata: { discovery: true, room: getRoomCode() },
    });
    registryConnection = connection;

    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
      // eslint-disable-next-line no-console
      console.log('[Scrum Poker WebRTC] Connecting to registry:', {
        registryPeerId: registryPeerId(getRoomCode()),
        localPeerId: getLocalPeerId(),
        roomCode: getRoomCode(),
      });
    }

    registryAttemptTimer = globalThis.setTimeout(() => {
      if (registryConnection !== connection || connection.open) return;
      releaseRegistryConnection(
        connection,
        'Registry connection timeout - scheduling election',
      );
      connection.close();
    }, REGISTRY_CONNECTION_TIMEOUT_MS);
    connection.on('open', () => {
      if (registryConnection !== connection) return;
      globalThis.clearTimeout(registryAttemptTimer);
      registryAttemptTimer = undefined;
      globalThis.clearTimeout(registryRetryTimer);
      registryRetryTimer = undefined;

      if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
        // eslint-disable-next-line no-console
        console.log('[Scrum Poker WebRTC] Registry connection established');
      }

      sendOpen(connection, {
        type: 'discover',
        participant: getIdentity(),
      } satisfies RegistryMessage);
    });
    connection.on('data', (raw) => {
      if (registryConnection !== connection) return;
      const message = raw as RegistryMessage;
      if (message.type === 'welcome') {
        mergeState(message.state, message.sentAt);
        ensureMesh(message.peerIds);
        announceJoin();
        restoreLocalVote();
        render();
      } else if (message.type === 'directory') ensureMesh(message.peerIds);
    });
    const lostRegistry = () => {
      releaseRegistryConnection(
        connection,
        'Registry connection lost - scheduling election',
      );
    };
    connection.on('close', lostRegistry);
    connection.on('error', (error) => {
      if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
        // eslint-disable-next-line no-console
        console.error('[Scrum Poker WebRTC] Registry connection error:', {
          errorType: error.type,
          errorMessage: error.message,
          registryPeerId: registryPeerId(getRoomCode()),
          timestamp: new Date().toISOString(),
        });
      }
      lostRegistry();
    });
  };

  function claimRegistry() {
    const roomCode = getRoomCode();
    if (registryPeer || registryConnection?.open || disposed || !roomCode)
      return;
    
    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
      // eslint-disable-next-line no-console
      console.log('[Scrum Poker WebRTC] Attempting to claim registry:', {
        registryPeerId: registryPeerId(roomCode),
        localPeerId: getLocalPeerId(),
        roomCode,
      });
    }
    
    const candidate = new Peer(registryPeerId(roomCode), PEER_OPTIONS);
    registryPeer = candidate;
    candidate.on('open', () => {
      const connection = registryConnection;
      registryConnection = undefined;
      globalThis.clearTimeout(registryAttemptTimer);
      registryAttemptTimer = undefined;
      connection?.close();
      candidate.on('connection', registerRegistryClient);
      broadcastDirectory();
      announceJoin();
      restoreLocalVote();
      updateOverallConnection();

      if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
        // eslint-disable-next-line no-console
        console.log('[Scrum Poker WebRTC] Registry claimed:', {
          registryPeerId: registryPeerId(roomCode),
          localPeerId: getLocalPeerId(),
          roomCode,
        });
      }
    });
    candidate.on('error', (error) => {
      if (registryPeer === candidate) registryPeer = undefined;
      if (!candidate.destroyed) candidate.destroy();
      
      if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
        // eslint-disable-next-line no-console
        console.error('[Scrum Poker WebRTC] Registry claim error:', {
          errorType: error.type,
          errorMessage: error.message,
          registryPeerId: registryPeerId(roomCode),
        });
      }
      
      if (error.type === 'unavailable-id') {
        // Registry already exists, try to connect to it
        globalThis.setTimeout(connectToRegistry, REGISTRY_RETRY_MS);
        return;
      }
      // For other errors, schedule another election attempt
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
          // eslint-disable-next-line no-console
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

    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
      // eslint-disable-next-line no-console
      console.log('[Scrum Poker WebRTC] Starting peer connection with config:', {
        iceTransportPolicy: PEER_OPTIONS.config.iceTransportPolicy,
        iceServersCount: iceServers.length,
        stunServers: configuredStunUrls,
        hasTurnServers: configuredTurnUrls.length > 0,
        usingPublicTurn: configuredTurnUrls.length === 0,
      });
    }

    const roomPeer = new Peer(PEER_OPTIONS);
    peer = roomPeer;
    roomPeer.on('open', (id) => {
      if (peer !== roomPeer || roomPeer.destroyed) return;
      setLocalPeerId(id);
      roomPeer.on('connection', registerConnection);
      connectToRegistry();
      globalThis.setTimeout(() => {
        if (!registryConnection?.open && !registryPeer)
          scheduleRegistryElection();
      }, REGISTRY_RETRY_MS);
    });
    roomPeer.on('error', (error) => {
      if (peer !== roomPeer || roomPeer.destroyed) return;

      if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
        // eslint-disable-next-line no-console
        console.error('[Scrum Poker WebRTC] Peer error:', {
          type: error.type,
          message: error.message,
          timestamp: new Date().toISOString(),
        });
      }

      if (error.type === 'peer-unavailable') {
        const connection = registryConnection;
        if (
          connection &&
          !connection.open &&
          error.message.includes(registryPeerId(getRoomCode()))
        ) {
          releaseRegistryConnection(
            connection,
            'Registry peer unavailable - scheduling election',
          );
          connection.close();
        } else scheduleRegistryElection();
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

      if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
        // eslint-disable-next-line no-console
        console.warn('[Scrum Poker WebRTC] Peer disconnected, attempting reconnect');
      }

      try {
        roomPeer.reconnect();
      } catch (error) {
        if (DEBUG_BUILD)
          // eslint-disable-next-line no-console
          console.debug('[Scrum Poker WebRTC] reconnect skipped', error);
      }
    });
  };

  function destroy() {
    disposed = true;
    globalThis.clearTimeout(registryRetryTimer);
    registryRetryTimer = undefined;
    globalThis.clearTimeout(registryAttemptTimer);
    registryAttemptTimer = undefined;
    for (const timer of reconnectTimers.values()) globalThis.clearTimeout(timer);
    reconnectTimers.clear();
    for (const timer of connectionAttemptTimers.values())
      globalThis.clearTimeout(timer);
    connectionAttemptTimers.clear();
    registryConnection?.close();
    registryConnection = undefined;
    for (const connection of connections.values()) connection.close();
    for (const connection of registryConnections.values()) connection.close();
    connections.clear();
    registryConnections.clear();
    connectionParticipants.clear();
    reconnectCounters.clear();
    connectionStartTimes.clear();
    pingResults.clear();
    totalMeshFailures = 0;
    usingFallbackMode = FALLBACK_MODE_ENABLED;
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
    getNetworkConfig: () => ({
      iceTransportPolicy: PEER_OPTIONS.config.iceTransportPolicy,
      iceServersCount: iceServers.length,
      iceServers,
      stunServers: configuredStunUrls,
      hasTurnServers: configuredTurnUrls.length > 0,
      usingPublicTurn: configuredTurnUrls.length === 0,
    }),
    getConnectionMode: () => ({
      usingFallbackMode,
      totalMeshFailures,
      fallbackThreshold: MESH_FAILURE_THRESHOLD,
    }),
  };
};

export type ScrumPokerNetwork = ReturnType<typeof createScrumPokerNetwork>;
