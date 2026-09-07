import Peer, { type DataConnection } from 'peerjs';

import type { ConnectionStatus } from './render';

import { DEBUG_SESSION_KEY } from './constants';
import {
  activePlayers,
  makeRandomId,
  mergeRoomState,
  type Player,
  type PlayerRole,
  type RoomAction,
  type RoomState,
} from './state';
import {
  canonicalTopology,
  chooseClientCores,
  chooseCoreTopology,
  CLIENT_CORE_CONNECTIONS,
  type CoreLoadInfo,
  type CorePeerInfo,
  EMPTY_TOPOLOGY,
  MAX_CORE_PEERS,
  type RoomTopology,
  shouldAcceptTopology,
  type TopologyParticipant,
} from './topology';

export type ParticipantIdentity = { id: string; peerId: string; name: string };

type DirectMessage =
  | {
      type: 'hello';
      participant: ParticipantIdentity;
      state: RoomState;
      sentAt: number;
    }
  | { type: 'snapshot'; state: RoomState; sentAt: number }
  | { type: 'topology'; topology: RoomTopology; sentAt: number }
  | { type: 'core-load'; load: CoreLoadInfo }
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
  | {
      type: 'welcome';
      participants: ParticipantIdentity[];
      topology: RoomTopology;
      state: RoomState;
      sentAt: number;
    }
  | {
      type: 'directory';
      participants: ParticipantIdentity[];
      topology: RoomTopology;
    };

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
  role: PlayerRole;
  isCoordinator: boolean;
  connectedCoreIds: string[];
  topologyGeneration: number;
};

const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 3000;
const REGISTRY_RETRY_MS = 2000;
const CONNECTION_TIMEOUT_MS = 30_000; // Increased from 15s to 30s for high-latency regions
const REGISTRY_CONNECTION_TIMEOUT_MS = 30_000; // Increased for better reliability
const POOR_RECONNECT_THRESHOLD = 4;

const configuredStunUrls = (
  import.meta.env.PUBLIC_STUN_URLS ??
  'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302'
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
const turnCredentialsUrl = import.meta.env.PUBLIC_TURN_CREDENTIALS_URL ?? '';
const iceTransportPolicy = (import.meta.env.PUBLIC_ICE_TRANSPORT_POLICY === 'relay'
  ? 'relay'
  : 'all') as RTCIceTransportPolicy;

const configuredStaticTurnServer = (): RTCIceServer | undefined =>
  configuredTurnUrls.length > 0
    ? {
        urls: configuredTurnUrls,
        username: import.meta.env.PUBLIC_TURN_USERNAME ?? '',
        credential: import.meta.env.PUBLIC_TURN_CREDENTIAL ?? '',
      }
    : undefined;

const stunIceServers = (): RTCIceServer[] =>
  configuredStunUrls.length > 0
    ? [{ urls: configuredStunUrls }]
    : [];

const baseIceServers = (): RTCIceServer[] => {
  const servers = stunIceServers();
  const staticTurn = configuredStaticTurnServer();
  if (staticTurn) servers.push(staticTurn);
  return servers;
};

const makePeerOptions = (iceServers: RTCIceServer[]) => ({
  debug: 0 as const,
  config: {
    iceServers,
    // Keep direct/STUN candidates enabled by default. Use relay only with
    // configured TURN credentials when explicitly testing or requiring relay.
    iceTransportPolicy,
    sdpSemantics: 'unified-plan',
  },
});

type PeerOptions = ReturnType<typeof makePeerOptions>;

const iceServerHasTurn = (server: RTCIceServer) => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.some(
    (url) =>
      typeof url === 'string' &&
      (url.startsWith('turn:') || url.startsWith('turns:')),
  );
};

export const DEBUG_BUILD =
  import.meta.env.DEV || import.meta.env.PUBLIC_SCRUM_POKER_DEBUG === 'true';

const fetchTurnIceServers = async (): Promise<RTCIceServer[]> => {
  if (!turnCredentialsUrl) return [];
  try {
    const response = await fetch(turnCredentialsUrl, {
      method: 'GET',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`TURN endpoint returned ${response.status}`);
    const body = (await response.json()) as { iceServers?: RTCIceServer[] };
    if (!Array.isArray(body.iceServers)) return [];
    return body.iceServers.filter(
      (server) =>
        Boolean(server) &&
        (typeof server.urls === 'string' || Array.isArray(server.urls)),
    );
  } catch (error) {
    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
      // eslint-disable-next-line no-console
      console.warn('[Scrum Poker WebRTC] TURN credentials unavailable', error);
    }
    return [];
  }
};

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
  const registryParticipants = new Map<string, ParticipantIdentity>();
  const connections = new Map<string, DataConnection>();
  const connectionParticipants = new Map<string, string>();
  const diagnostics = new Map<string, ConnectionDiagnostics>();
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const connectionAttemptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectCounters = new Map<string, number>();
  const connectionStartTimes = new Map<string, number>();
  const pingResults = new Map<string, number[]>();
  const coreLoads = new Map<string, CoreLoadInfo>();
  const intentionalClosures = new Set<string>();
  let topology: RoomTopology = EMPTY_TOPOLOGY;
  let activeIceServers = baseIceServers();
  let peerOptions: PeerOptions = makePeerOptions(activeIceServers);
  let totalConnectionFailures = 0;
  let registryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let registryAttemptTimer: ReturnType<typeof setTimeout> | undefined;
  let seenMessages = new Set<string>();
  let disposed = false;

  const visiblePlayers = () => activePlayers(getState());

  const localRole: () => PlayerRole = () =>
    topology.cores.some((core) => core.participantId === getLocalPlayerId())
      ? 'core'
      : 'participant';

  const isTopologyCoordinator = () =>
    topology.coordinatorParticipantId === getLocalPlayerId();

  const connectedCoreIds = () =>
    topology.cores
      .filter((core) => connections.get(core.peerId)?.open)
      .map((core) => core.participantId);

  const rememberParticipant = (participant: ParticipantIdentity) => {
    if (!participant.id || !participant.peerId) return;
    registryParticipants.set(participant.peerId, participant);
    connectionParticipants.set(participant.peerId, participant.id);
  };

  const participantDirectory = () => {
    const participants = new Map<string, ParticipantIdentity>();
    for (const participant of registryParticipants.values()) {
      if (!participant.id || !participant.peerId) continue;
      participants.set(participant.id, participant);
    }
    for (const player of visiblePlayers()) {
      if (!player.id || !player.peerId) continue;
      participants.set(player.id, {
        id: player.id,
        peerId: player.peerId,
        name: player.name,
      });
    }
    const local = getIdentity();
    if (local.id && local.peerId) participants.set(local.id, local);
    return [...participants.values()].toSorted((left, right) =>
      left.id.localeCompare(right.id),
    );
  };

  const healthRankFor = (peerId: string) => {
    const diagnostic = diagnostics.get(peerId);
    const reconnectCount = reconnectCounters.get(peerId) || 0;
    const currentCorePeer = topology.cores.some((core) => core.peerId === peerId);
    if (
      diagnostic?.connectionState === 'failed' ||
      diagnostic?.iceConnectionState === 'failed' ||
      (currentCorePeer &&
        (diagnostic?.connectionState === 'closed' ||
          diagnostic?.iceConnectionState === 'closed')) ||
      reconnectCount >= POOR_RECONNECT_THRESHOLD
    )
      return 2;
    if (
      diagnostic?.connectionQuality === 'poor' ||
      diagnostic?.connectionState === 'disconnected' ||
      diagnostic?.connectionState === 'closed'
    )
      return 1;
    return 0;
  };

  const topologyParticipants = (): TopologyParticipant[] =>
    participantDirectory().map((participant) => ({
      participantId: participant.id,
      peerId: participant.peerId,
      healthRank: healthRankFor(participant.peerId),
    }));

  const publishCoreLoad = () => {
    if (localRole() !== 'core') return;
    const load: CoreLoadInfo = {
      participantId: getLocalPlayerId(),
      peerId: getLocalPeerId(),
      connectionCount: [...connections.values()].filter(
        (connection) => connection.open,
      ).length,
      connectionQuality: [...diagnostics.values()].some(
        (row) => row.connectionQuality === 'poor',
      )
        ? 'fair'
        : 'good',
      sentAt: Date.now(),
    };
    coreLoads.set(load.participantId, load);
    for (const connection of connections.values())
      sendOpen(connection, { type: 'core-load', load } satisfies DirectMessage);
  };

  const acceptTopology = (candidate: RoomTopology) => {
    const normalized = canonicalTopology(candidate);
    if (
      normalized.generation === topology.generation &&
      normalized.coordinatorParticipantId === topology.coordinatorParticipantId &&
      normalized.cores.length === topology.cores.length &&
      normalized.cores.every(
        (core, index) =>
          core.participantId === topology.cores[index]?.participantId &&
          core.peerId === topology.cores[index]?.peerId,
      )
    )
      return false;
    if (!shouldAcceptTopology(topology, normalized)) return false;
    topology = normalized;
    ensureTopologyConnections();
    for (const connection of connections.values())
      sendOpen(connection, {
        type: 'topology',
        topology,
        sentAt: Date.now(),
      } satisfies DirectMessage);
    publishCoreLoad();
    render();
    return true;
  };

  const publishTopology = () => {
    const message = {
      type: 'topology',
      topology,
      sentAt: Date.now(),
    } satisfies DirectMessage;
    for (const connection of connections.values()) sendOpen(connection, message);
    for (const connection of registryConnections.values())
      sendOpen(connection, directoryMessage());
  };

  const updateTopologyIfCoordinator = () => {
    if (!getLocalPlayerId() || !getLocalPeerId()) return;
    const participants = topologyParticipants();
    if (participants.length === 0) return;
    if (topology.cores.length === 0) {
      const accepted = acceptTopology(
        chooseCoreTopology({
          participants,
          current: topology,
          generation: topology.generation + 1,
        }),
      );
      if (accepted && isTopologyCoordinator()) publishTopology();
    }
    const participantIds = new Set(
      participants.map((participant) => participant.participantId),
    );
    const healthyCoreIds = topology.cores
      .filter(
        (core) =>
          participantIds.has(core.participantId) &&
          healthRankFor(core.peerId) < 2,
      )
      .toSorted((left, right) =>
        left.participantId.localeCompare(right.participantId),
      );
    const electedCoordinatorId = healthyCoreIds[0]?.participantId ?? '';
    if (
      localRole() === 'core' &&
      !isTopologyCoordinator() &&
      topology.coordinatorParticipantId &&
      electedCoordinatorId === getLocalPlayerId()
    ) {
      topology = chooseCoreTopology({
        participants,
        current: topology,
        generation: topology.generation + 1,
      });
      ensureTopologyConnections();
      publishTopology();
      publishCoreLoad();
      render();
      return;
    }
    if (!isTopologyCoordinator()) return;
    const next = chooseCoreTopology({
      participants,
      current: topology,
      generation: topology.generation + 1,
    });
    const currentKey = JSON.stringify(canonicalTopology(topology));
    const nextKey = JSON.stringify(canonicalTopology({ ...next, generation: topology.generation }));
    if (currentKey === nextKey) return;
    topology = next;
    ensureTopologyConnections();
    publishTopology();
    publishCoreLoad();
    render();
  };

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

  const relayTargetConnections = (exceptPeerId = '') => {
    const openConnections = [...connections.entries()].filter(
      ([peerId, connection]) => peerId !== exceptPeerId && connection.open,
    );
    if (topology.cores.length === 0 || localRole() === 'core')
      return openConnections.map(([, connection]) => connection);

    const corePeerIds = new Set(
      chooseClientCores(topology, getLocalPlayerId(), coreLoads).map(
        (core) => core.peerId,
      ),
    );
    const coreConnections = openConnections
      .filter(([peerId]) => corePeerIds.has(peerId))
      .map(([, connection]) => connection);

    return coreConnections.length > 0
      ? coreConnections
      : openConnections.map(([, connection]) => connection);
  };

  const relay = (payload: RelayedMessage) => {
    const envelope: Envelope = {
      type: 'relay',
      id: makeRandomId(),
      originId: getLocalPlayerId(),
      payload,
    };
    rememberSeen(envelope.id);
    for (const connection of relayTargetConnections()) sendOpen(connection, envelope);
  };

  const mergeState = (remoteState: RoomState, sentAt?: number) => {
    const merged = mergeRoomState(getState(), remoteState, sentAt);
    setState(merged);
  };

  const handleRelay = (sourcePeerId: string, envelope: Envelope) => {
    if (seenMessages.has(envelope.id)) return;
    rememberSeen(envelope.id);
    if (topology.cores.length === 0 || localRole() === 'core')
      for (const connection of relayTargetConnections(sourcePeerId))
        sendOpen(connection, envelope);
    if (envelope.payload.type === 'action')
      onAction(envelope.payload.action, false);
    else {
      rememberParticipant(envelope.payload.participant);
      onPresence(envelope.payload);
      updateTopologyIfCoordinator();
    }
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
      role: localRole(),
      isCoordinator: isTopologyCoordinator(),
      connectedCoreIds: connectedCoreIds(),
      topologyGeneration: topology.generation,
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
          iceTransportPolicy: peerOptions.config.iceTransportPolicy,
          iceServersCount: activeIceServers.length,
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
      setConnection('Peer-to-peer topology live', 'connected');
    else setConnection('Reconnecting…', 'connecting');
  };

  const scheduleReconnect = (remotePeerId: string) => {
    if (reconnectTimers.has(remotePeerId) || disposed) return;

    // Increment reconnect counter
    const currentCount = reconnectCounters.get(remotePeerId) || 0;
    reconnectCounters.set(remotePeerId, currentCount + 1);
    totalConnectionFailures++;

    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
      // eslint-disable-next-line no-console
      console.log('[Scrum Poker WebRTC] Scheduling topology reconnect:', {
        peerId: remotePeerId,
        reconnectCount: currentCount + 1,
        totalConnectionFailures,
        topologyGeneration: topology.generation,
        role: localRole(),
      });
    }

    const timer = globalThis.setTimeout(() => {
      reconnectTimers.delete(remotePeerId);
      ensureTopologyConnections();
      updateTopologyIfCoordinator();
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
    if (message.type === 'topology') {
      acceptTopology(message.topology);
      return;
    }
    if (message.type === 'core-load') {
      coreLoads.set(message.load.participantId, message.load);
      return;
    }
    rememberParticipant(message.participant);
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
    sendOpen(connection, {
      type: 'topology',
      topology,
      sentAt: Date.now(),
    } satisfies DirectMessage);
    publishCoreLoad();
    updateTopologyIfCoordinator();
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
      sendOpen(connection, {
        type: 'topology',
        topology,
        sentAt: Date.now(),
      } satisfies DirectMessage);
      publishCoreLoad();
      updateTopologyIfCoordinator();
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
      const intentional = intentionalClosures.delete(connection.peer);
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
        role: localRole(),
        isCoordinator: isTopologyCoordinator(),
        connectedCoreIds: connectedCoreIds(),
        topologyGeneration: topology.generation,
      });
      if (!intentional) scheduleReconnect(connection.peer);
      updateTopologyIfCoordinator();
      updateOverallConnection();
      render();
    });
  };

  const connectToPeer = (remotePeerId: string, reason: string) => {
    const localPeerId = getLocalPeerId();
    if (
      !peer ||
      !localPeerId ||
      !remotePeerId ||
      remotePeerId === localPeerId ||
      connections.has(remotePeerId)
    )
      return;

    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
      // eslint-disable-next-line no-console
      console.log('[Scrum Poker WebRTC] Establishing topology connection:', {
        localPeerId,
        remotePeerId,
        roomCode: getRoomCode(),
        reason,
        role: localRole(),
        topologyGeneration: topology.generation,
      });
    }

    registerConnection(
      peer.connect(remotePeerId, {
        reliable: true,
        metadata: { room: getRoomCode(), participantId: getLocalPlayerId() },
      }),
    );
  };

  function desiredTopologyPeers() {
    if (topology.cores.length === 0) return [] as CorePeerInfo[];
    if (localRole() === 'core')
      return topology.cores.filter(
        (core) => core.participantId !== getLocalPlayerId(),
      );
    return chooseClientCores(topology, getLocalPlayerId(), coreLoads);
  }

  function pruneParticipantConnections(desiredPeerIds: Set<string>) {
    if (localRole() === 'core' || topology.cores.length === 0) return;
    const requiredOpenConnections = Math.min(
      CLIENT_CORE_CONNECTIONS,
      topology.cores.filter((core) => core.participantId !== getLocalPlayerId())
        .length,
    );
    const openDesiredConnections = [...desiredPeerIds].filter(
      (peerId) => connections.get(peerId)?.open,
    ).length;
    if (openDesiredConnections < requiredOpenConnections) return;

    for (const [peerId, connection] of connections) {
      if (desiredPeerIds.has(peerId)) continue;
      intentionalClosures.add(peerId);
      connection.close();
      connections.delete(peerId);
    }
  }

  function ensureTopologyConnections() {
    const localPeerId = getLocalPeerId();
    if (!peer || !localPeerId) return;
    updateTopologyIfCoordinator();
    const desired = desiredTopologyPeers();
    const desiredPeerIds = new Set(desired.map((core) => core.peerId));
    for (const core of desired)
      connectToPeer(
        core.peerId,
        localRole() === 'core' ? 'core-mesh' : 'client-core',
      );
    pruneParticipantConnections(desiredPeerIds);
    updateOverallConnection();
  }

  function directoryMessage() {
    return {
      type: 'directory',
      participants: participantDirectory(),
      topology,
    } satisfies RegistryMessage;
  }

  const broadcastDirectory = () => {
    const message = directoryMessage();
    for (const connection of registryConnections.values())
      sendOpen(connection, message);
    ensureTopologyConnections();
  };

  const registerRegistryClient = (connection: DataConnection) => {
    registryConnections.set(connection.peer, connection);
    connection.on('data', (raw) => {
      const message = raw as RegistryMessage;
      if (message.type !== 'discover') return;
      rememberParticipant(message.participant);
      updateTopologyIfCoordinator();
      sendOpen(connection, {
        type: 'welcome',
        participants: participantDirectory(),
        topology,
        state: getState(),
        sentAt: Date.now(),
      } satisfies RegistryMessage);
      broadcastDirectory();
    });
    connection.on('close', () => {
      registryConnections.delete(connection.peer);
      registryParticipants.delete(connection.peer);
      updateTopologyIfCoordinator();
    });
    connection.on('error', () => {
      registryConnections.delete(connection.peer);
      registryParticipants.delete(connection.peer);
      updateTopologyIfCoordinator();
    });
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
        for (const participant of message.participants)
          rememberParticipant(participant);
        acceptTopology(message.topology);
        ensureTopologyConnections();
        announceJoin();
        restoreLocalVote();
        render();
      } else if (message.type === 'directory') {
        for (const participant of message.participants)
          rememberParticipant(participant);
        acceptTopology(message.topology);
        ensureTopologyConnections();
      }
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

    const candidate = new Peer(registryPeerId(roomCode), peerOptions);
    registryPeer = candidate;
    candidate.on('open', () => {
      const connection = registryConnection;
      registryConnection = undefined;
      globalThis.clearTimeout(registryAttemptTimer);
      registryAttemptTimer = undefined;
      connection?.close();
      candidate.on('connection', registerRegistryClient);
      updateTopologyIfCoordinator();
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
    setConnection('Joining resilient topology', 'connecting');
    void startPeer();
  };

  async function startPeer() {
    const turnIceServers = await fetchTurnIceServers();
    if (disposed) return;
    activeIceServers =
      turnIceServers.length > 0
        ? [...stunIceServers(), ...turnIceServers]
        : baseIceServers();
    peerOptions = makePeerOptions(activeIceServers);

    if (DEBUG_BUILD || sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') {
      // eslint-disable-next-line no-console
      console.log('[Scrum Poker WebRTC] Starting peer connection with config:', {
        iceTransportPolicy: peerOptions.config.iceTransportPolicy,
        iceServersCount: activeIceServers.length,
        stunServers: configuredStunUrls,
        hasTurnServers:
          turnIceServers.some((turnIceServer) => iceServerHasTurn(turnIceServer)) || configuredTurnUrls.length > 0,
        turnCredentialsEndpointConfigured: Boolean(turnCredentialsUrl),
      });
    }

    const roomPeer = new Peer(peerOptions);
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
  }

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
    registryParticipants.clear();
    connectionParticipants.clear();
    diagnostics.clear();
    reconnectCounters.clear();
    connectionStartTimes.clear();
    pingResults.clear();
    coreLoads.clear();
    intentionalClosures.clear();
    topology = EMPTY_TOPOLOGY;
    activeIceServers = baseIceServers();
    peerOptions = makePeerOptions(activeIceServers);
    totalConnectionFailures = 0;
    registryPeer?.destroy();
    peer?.destroy();
    registryPeer = undefined;
    peer = undefined;
  }

  return {
    start,
    destroy,
    relay,
    ensureTopology: ensureTopologyConnections,
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
      if (peerId && connections.get(peerId)?.open === true) return true;
      return connectedCoreIds().length > 0;
    },
    diagnostics: () => diagnostics,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    getNetworkConfig: () => ({
      iceTransportPolicy: peerOptions.config.iceTransportPolicy,
      iceServersCount: activeIceServers.length,
      iceServers: activeIceServers,
      stunServers: configuredStunUrls,
      hasTurnServers: activeIceServers.some((activeIceServer) => iceServerHasTurn(activeIceServer)),
      hasStaticTurnServers: configuredTurnUrls.length > 0,
      turnCredentialsEndpointConfigured: Boolean(turnCredentialsUrl),
    }),
    getConnectionMode: () => ({
      role: localRole(),
      isCoordinator: isTopologyCoordinator(),
      topology,
      connectedCoreIds: connectedCoreIds(),
      coreLoads: [...coreLoads.values()],
      maxCorePeers: MAX_CORE_PEERS,
      clientCoreConnections: CLIENT_CORE_CONNECTIONS,
      totalConnectionFailures,
    }),
  };
};

export type ScrumPokerNetwork = ReturnType<typeof createScrumPokerNetwork>;
