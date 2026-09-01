import Peer, { type DataConnection } from 'peerjs';
import {
  DEFAULT_TIMER_SECONDS,
  PRESENCE_TIMEOUT_MS,
  activePlayers,
  applyRoomAction,
  freshRoomState,
  makeRandomId,
  mergeRoomState,
  normaliseTimerDuration,
  presenceFor,
  votingStatusFor,
  votingStatusLabel,
  type Player,
  type PresenceState,
  type RoomAction,
  type RoomState,
} from './scrum-poker-state';

type ParticipantIdentity = { id: string; peerId: string; name: string };
type DirectMessage =
  | { type: 'hello'; participant: ParticipantIdentity; state: RoomState }
  | { type: 'snapshot'; state: RoomState }
  | { type: 'ping'; sentAt: number }
  | { type: 'pong'; sentAt: number };
type RelayedMessage =
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
type ConnectionDiagnostics = {
  participantId?: string;
  peerId: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  lastChangedAt: number;
};

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

const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTWXYZ';
const CARD_ORDER = ['0', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];
const DEBUG_CHEAT_CODE = 'makemeadmin';
const DEBUG_SESSION_KEY = 'scrum-poker-debug';
const PROFILE_NAME_STORAGE_KEY = 'scrum-poker-name';
const IDENTITY_STORAGE_PREFIX = 'scrum-poker-identity:';
const VOTE_STORAGE_PREFIX = 'scrum-poker-vote:';
const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 3_000;
const REGISTRY_RETRY_MS = 2_000;
const DEBUG_BUILD =
  import.meta.env.DEV || import.meta.env.PUBLIC_SCRUM_POKER_DEBUG === 'true';

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

const makeRoomCode = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(7)),
    (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length],
  ).join('');
const normaliseRoomCode = (value: string) =>
  value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 32);
const registryPeerId = (roomCode: string) =>
  `brijesh-scrum-${roomCode.toLowerCase()}`;

let disposeCurrentRoom: (() => void) | undefined;

const initialiseScrumPoker = () => {
  const root = document.querySelector<HTMLElement>('[data-scrum-tool]');
  if (!root || root.dataset.initialised === 'true') return;
  root.dataset.initialised = 'true';

  const find = <T extends HTMLElement>(selector: string) =>
    root.querySelector<T>(selector)!;
  const setup = find<HTMLElement>('#poker-setup');
  const roomView = find<HTMLElement>('#poker-room');
  const createForm = find<HTMLFormElement>('#create-room-form');
  const joinForm = find<HTMLFormElement>('#join-room-form');
  const createName = find<HTMLInputElement>('#create-name');
  const createRoomInput = find<HTMLInputElement>('#create-room-code');
  const joinName = find<HTMLInputElement>('#join-name');
  const roomInput = find<HTMLInputElement>('#room-code');
  const errorBox = find<HTMLElement>('#connection-error');
  const playersGrid = find<HTMLElement>('#players-grid');
  const participantList = find<HTMLOListElement>('#participant-list');
  const connectionLabel = find<HTMLElement>('#connection-label');
  const connectionDot = find<HTMLElement>('#connection-dot');
  const roundLabel = find<HTMLElement>('#round-label');
  const roundStatus = find<HTMLElement>('#round-status');
  const roomLabel = find<HTMLElement>('#room-label');
  const revealButton = find<HTMLButtonElement>('#reveal-votes');
  const resetButton = find<HTMLButtonElement>('#reset-round');
  const timerDisplay = find<HTMLElement>('#timer-display');
  const timerInput = find<HTMLInputElement>('#timer-duration');
  const autoRevealInput = find<HTMLInputElement>('#timer-auto-reveal');
  const allowVoteChangesInput = find<HTMLInputElement>('#allow-vote-changes');
  const startTimerButton = find<HTMLButtonElement>('#start-timer');
  const stopTimerButton = find<HTMLButtonElement>('#stop-timer');
  const cardHint = find<HTMLElement>('#card-hint');
  const statistics = find<HTMLElement>('#statistics');
  const profileButton = find<HTMLButtonElement>('#profile-button');
  const profileDialog = find<HTMLDialogElement>('#profile-dialog');
  const profileForm = find<HTMLFormElement>('#profile-form');
  const profileName = find<HTMLInputElement>('#profile-name');
  const profileClose = find<HTMLButtonElement>('#profile-close');
  const cardButtons = [
    ...root.querySelectorAll<HTMLButtonElement>('[data-card]'),
  ];
  const toast = find<HTMLElement>('#poker-toast');

  let peer: Peer | undefined;
  let registryPeer: Peer | undefined;
  let registryConnection: DataConnection | undefined;
  const registryConnections = new Map<string, DataConnection>();
  const connections = new Map<string, DataConnection>();
  const connectionParticipants = new Map<string, string>();
  const diagnostics = new Map<string, ConnectionDiagnostics>();
  const reconnectTimers = new Map<string, number>();
  const connectionAttemptTimers = new Map<string, number>();
  let state = freshRoomState();
  let currentRoom = '';
  let localPlayerId = '';
  let localPeerId = '';
  let localName = '';
  let localVote: string | null = null;
  let lamport = 0;
  let seenMessages = new Set<string>();
  let toastTimer: number | undefined;
  let cheatCodeBuffer = '';
  let timerInterval: number | undefined;
  let presenceInterval: number | undefined;
  let registryRetryTimer: number | undefined;
  let previouslyRevealed = false;
  let focusResultAfterReveal = false;
  let pendingRoomJoin = '';
  let lastJoinAnnouncedAt = 0;
  let disposed = false;

  const showToast = (message: string) => {
    toast.textContent = message;
    toast.classList.remove('translate-y-3', 'opacity-0');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(
      () => toast.classList.add('translate-y-3', 'opacity-0'),
      2600,
    );
  };
  const showError = (message: string) => {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
    setup.classList.remove('hidden');
    roomView.classList.add('hidden');
  };
  const setConnection = (
    label: string,
    status: 'connecting' | 'connected' | 'disconnected',
  ) => {
    connectionLabel.lastChild!.textContent = ` ${label}`;
    connectionDot.className = `size-2 rounded-full ${status === 'connected' ? 'bg-accent' : status === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-red-500'}`;
  };
  const identity = (): ParticipantIdentity => ({
    id: localPlayerId,
    peerId: localPeerId,
    name: localName,
  });
  const inviteUrl = () =>
    new URL(
      `/tools/scrum-poker/${encodeURIComponent(currentRoom)}`,
      window.location.origin,
    ).toString();
  const updateUrl = (roomCode?: string) => {
    const url = new URL(window.location.href);
    url.pathname = roomCode
      ? `/tools/scrum-poker/${encodeURIComponent(roomCode)}`
      : '/tools/scrum-poker';
    url.searchParams.delete('room');
    url.hash = '';
    history.replaceState({}, '', url);
  };
  const roomFromLocation = () => {
    const match = window.location.pathname.match(
      /^\/tools\/scrum-poker\/([^/]+)\/?$/i,
    );
    const pathRoom = match ? decodeURIComponent(match[1]) : '';
    const queryRoom =
      new URLSearchParams(window.location.search).get('room') ?? '';
    return normaliseRoomCode(pathRoom || queryRoom);
  };
  const saveProfileName = (name: string) => {
    const savedName = name.trim().slice(0, 32);
    if (!savedName) return '';
    localStorage.setItem(PROFILE_NAME_STORAGE_KEY, savedName);
    createName.value = savedName;
    joinName.value = savedName;
    profileName.value = savedName;
    return savedName;
  };
  const roomIdentity = (roomCode: string) => {
    const key = `${IDENTITY_STORAGE_PREFIX}${roomCode}`;
    let value = localStorage.getItem(key);
    if (!value) {
      value = makeRandomId();
      localStorage.setItem(key, value);
    }
    return value;
  };
  const openProfile = (roomCode = '') => {
    pendingRoomJoin = roomCode;
    profileName.value =
      localName || localStorage.getItem(PROFILE_NAME_STORAGE_KEY) || '';
    profileDialog.showModal();
    requestAnimationFrame(() => profileName.focus());
  };
  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl());
      showToast('Invite link copied');
    } catch {
      showToast(`Room code: ${currentRoom}`);
    }
  };
  const escapeHtml = (value: string) => {
    const element = document.createElement('span');
    element.textContent = value;
    return element.innerHTML;
  };
  const compareVoteValues = (first: string, second: string) => {
    const firstNumber = Number(first);
    const secondNumber = Number(second);
    const firstIsNumeric = Number.isFinite(firstNumber);
    const secondIsNumeric = Number.isFinite(secondNumber);
    if (firstIsNumeric && secondIsNumeric && firstNumber !== secondNumber)
      return firstNumber - secondNumber;
    if (firstIsNumeric !== secondIsNumeric) return firstIsNumeric ? -1 : 1;
    const firstOrder = CARD_ORDER.indexOf(first);
    const secondOrder = CARD_ORDER.indexOf(second);
    if (firstOrder !== secondOrder) return firstOrder - secondOrder;
    return first.localeCompare(second, undefined, { sensitivity: 'base' });
  };
  const compareRevealedPlayers = (first: Player, second: Player) => {
    const firstVote = first.voteRoundId === state.roundId ? first.vote : null;
    const secondVote =
      second.voteRoundId === state.roundId ? second.vote : null;
    if (firstVote === null)
      return secondVote === null ? first.name.localeCompare(second.name) : 1;
    if (secondVote === null) return -1;
    return (
      compareVoteValues(firstVote, secondVote) ||
      first.name.localeCompare(second.name, undefined, {
        sensitivity: 'base',
      }) ||
      first.id.localeCompare(second.id)
    );
  };
  const visiblePlayers = () => activePlayers(state);
  const hasOpenConnection = (player: Player) => {
    if (player.id === localPlayerId) return true;
    const peerId = [...connectionParticipants.entries()].find(
      ([, participantId]) => participantId === player.id,
    )?.[0];
    return peerId ? connections.get(peerId)?.open === true : false;
  };
  const playerPresence = (player: Player): PresenceState =>
    presenceFor(player, Date.now(), hasOpenConnection(player));
  const numericVotes = () =>
    visiblePlayers()
      .map((player) =>
        player.voteRoundId === state.roundId ? player.vote : null,
      )
      .filter(
        (vote): vote is string =>
          vote !== null && Number.isFinite(Number(vote)),
      )
      .map(Number);

  const renderStatistics = (animateReveal: boolean) => {
    statistics.classList.toggle('hidden', !state.revealed);
    statistics.classList.toggle('is-entering', animateReveal);
    if (!state.revealed) return;
    const numbers = numericVotes();
    find<HTMLElement>('#stat-low').textContent = numbers.length
      ? String(Math.min(...numbers))
      : '—';
    find<HTMLElement>('#stat-high').textContent = numbers.length
      ? String(Math.max(...numbers))
      : '—';
    const votes = visiblePlayers()
      .map((player) =>
        player.voteRoundId === state.roundId ? player.vote : null,
      )
      .filter((vote): vote is string => vote !== null);
    const consensus = votes.length > 1 && new Set(votes).size === 1;
    find<HTMLElement>('#consensus-label').textContent = consensus
      ? `Consensus reached at ${votes[0]}.`
      : votes.length > 1
        ? 'There is a spread—talk through the assumptions.'
        : votes.length === 1
          ? 'One estimate received.'
          : 'No estimates received.';
    const counts = new Map<string, number>();
    for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
    const orderedVotes = [...counts.keys()].sort(compareVoteValues);
    const highestCount = counts.size ? Math.max(...counts.values()) : 0;
    find<HTMLElement>('#stat-most-voted').textContent =
      orderedVotes
        .filter((vote) => counts.get(vote) === highestCount)
        .join(' / ') || '—';
    find<HTMLElement>('#distribution').innerHTML = orderedVotes
      .map((card) => {
        const count = counts.get(card)!;
        const width = votes.length ? (count / votes.length) * 100 : 0;
        return `<div class="grid grid-cols-[24px_1fr_20px] items-center gap-2 text-sm"><span class="truncate font-mono" title="${escapeHtml(card)}">${escapeHtml(card)}</span><span class="h-1 bg-rule"><span class="block h-full bg-accent" style="width:${width}%"></span></span><span class="text-right text-muted">${count}</span></div>`;
      })
      .join('');
  };
  const updateTimerDisplay = () => {
    const secondsLeft =
      state.timerEndsAt === null
        ? state.timerDuration
        : Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
    timerDisplay.textContent = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
    const running = state.timerEndsAt !== null;
    timerDisplay.classList.toggle('is-running', running);
    timerDisplay.classList.toggle('is-urgent', running && secondsLeft <= 10);
  };
  const render = () => {
    const players = visiblePlayers();
    const voted = players.filter(
      (player) => player.voteRoundId === state.roundId && player.hasVoted,
    ).length;
    const total = players.length;
    const animateReveal = state.revealed && !previouslyRevealed;
    const displayedPlayers = state.revealed
      ? [...players].sort(compareRevealedPlayers)
      : players;
    roundLabel.textContent = `Round ${state.round}`;
    roundStatus.textContent = state.revealed
      ? 'The cards are on the table'
      : voted === total && total > 0
        ? 'Everyone has voted'
        : `${voted} of ${total} voted`;
    timerInput.value = String(state.timerDuration);
    autoRevealInput.checked = state.autoReveal;
    allowVoteChangesInput.checked = state.allowVoteChangesAfterReveal;
    startTimerButton.textContent =
      state.timerEndsAt === null ? 'Start timer' : 'Restart timer';
    stopTimerButton.classList.toggle('hidden', state.timerEndsAt === null);
    revealButton.disabled = state.revealed || voted === 0;
    revealButton.textContent = state.revealed
      ? 'Votes revealed'
      : 'Reveal votes';
    playersGrid.classList.toggle('is-revealed', state.revealed);
    playersGrid.innerHTML = displayedPlayers
      .map((player, index) => {
        const status = votingStatusFor(player, state, playerPresence(player));
        const hasVoted =
          player.voteRoundId === state.roundId && player.hasVoted;
        const angle = `${(index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2}rad`;
        const throwAngle =
          (index / Math.max(displayedPlayers.length, 1)) * Math.PI * 2 -
          Math.PI / 2;
        const cardValue =
          state.revealed && player.voteRoundId === state.roundId && player.vote
            ? player.vote
            : '•';
        return `<article class="scrum-player" style="--angle:${angle};--throw-x:${Math.cos(throwAngle) * 210}px;--throw-y:${Math.sin(throwAngle) * 150}px"><div class="scrum-player-card ${hasVoted ? 'is-voted' : ''} ${state.revealed && hasVoted ? 'is-revealed' : ''} ${animateReveal && hasVoted ? 'is-reveal-entering' : ''}">${escapeHtml(cardValue)}</div><strong class="scrum-player-name">${escapeHtml(player.name)}${player.id === localPlayerId ? ' (you)' : ''}</strong><span class="scrum-player-role">${votingStatusLabel(status)}</span></article>`;
      })
      .join('');
    participantList.innerHTML = players
      .map((player) => {
        const status = votingStatusFor(player, state, playerPresence(player));
        return `<li class="flex items-center justify-between gap-3"><span class="min-w-0 truncate">${escapeHtml(player.name)}${player.id === localPlayerId ? ' (you)' : ''}</span><span class="shrink-0 font-mono text-[0.65rem] tracking-[0.04em] text-muted uppercase">${votingStatusLabel(status)}</span></li>`;
      })
      .join('');
    for (const button of cardButtons) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.card === localVote),
      );
      button.disabled = state.revealed && !state.allowVoteChangesAfterReveal;
    }
    cardHint.textContent = state.revealed
      ? state.allowVoteChangesAfterReveal
        ? 'Choose again to update'
        : 'Voting is locked'
      : 'Tap again to clear';
    renderStatistics(animateReveal);
    updateTimerDisplay();
    previouslyRevealed = state.revealed;
    if (animateReveal && focusResultAfterReveal) {
      focusResultAfterReveal = false;
      requestAnimationFrame(() => {
        const bounds = statistics.getBoundingClientRect();
        if (bounds.top >= 0 && bounds.bottom <= window.innerHeight) return;
        statistics.scrollIntoView({
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
          block: 'center',
        });
      });
    }
  };
  const enterRoom = () => {
    setup.classList.add('hidden');
    roomView.classList.remove('hidden');
    errorBox.classList.add('hidden');
    roomLabel.textContent = currentRoom;
    updateUrl(currentRoom);
    saveProfileName(localName);
    render();
  };

  const rememberSeen = (id: string) => {
    seenMessages.add(id);
    if (seenMessages.size > 2_000)
      seenMessages = new Set([...seenMessages].slice(-1_000));
  };
  const sendOpen = (
    connection: DataConnection | undefined,
    message: unknown,
  ) => {
    if (connection?.open) connection.send(message);
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
      originId: localPlayerId,
      payload,
    };
    rememberSeen(envelope.id);
    broadcastRaw(envelope);
  };
  const makeAction = <T extends RoomAction['type']>(
    type: T,
    payload: Extract<RoomAction, { type: T }>['payload'],
  ) => {
    lamport = Math.max(lamport, state.version) + 1;
    return {
      id: `${String(lamport).padStart(10, '0')}-${localPlayerId}-${makeRandomId()}`,
      actorId: localPlayerId,
      counter: lamport,
      type,
      payload,
    } as Extract<RoomAction, { type: T }>;
  };
  const persistLocalVote = () => {
    const key = `${VOTE_STORAGE_PREFIX}${currentRoom}`;
    if (localVote === null) sessionStorage.removeItem(key);
    else
      sessionStorage.setItem(
        key,
        JSON.stringify({ roundId: state.roundId, vote: localVote }),
      );
  };
  const publishLocalVote = () => {
    const player = state.players.find((item) => item.id === localPlayerId);
    if (!player || player.voteRoundId !== state.roundId || !player.hasVoted)
      return;
    dispatchAction(
      makeAction('vote', {
        playerId: localPlayerId,
        roundId: state.roundId,
        hasVoted: true,
        vote: localVote,
      }),
    );
  };
  const processAction = (action: RoomAction, shouldRelay: boolean) => {
    lamport = Math.max(lamport, action.counter);
    const wasRevealed = state.revealed;
    const previousRoundId = state.roundId;
    state = applyRoomAction(state, action);
    if (previousRoundId !== state.roundId) {
      localVote = null;
      persistLocalVote();
    }
    render();
    if (shouldRelay) relay({ type: 'action', action });
    if (!wasRevealed && state.revealed) publishLocalVote();
  };
  const dispatchAction = (action: RoomAction) => processAction(action, true);
  const announceJoin = () => {
    if (!localPlayerId || !localPeerId) return;
    const now = Date.now();
    if (now - lastJoinAnnouncedAt < 1_000) return;
    lastJoinAnnouncedAt = now;
    dispatchAction(
      makeAction('join', {
        playerId: localPlayerId,
        peerId: localPeerId,
        name: localName,
        now,
      }),
    );
  };
  const restoreLocalVote = () => {
    if (localVote !== null) return;
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(`${VOTE_STORAGE_PREFIX}${currentRoom}`) ??
          'null',
      ) as { roundId?: string; vote?: string } | null;
      if (
        saved?.roundId === state.roundId &&
        saved.vote &&
        CARD_ORDER.includes(saved.vote)
      ) {
        localVote = saved.vote;
        dispatchAction(
          makeAction('vote', {
            playerId: localPlayerId,
            roundId: state.roundId,
            hasVoted: true,
            vote: state.revealed ? localVote : null,
          }),
        );
      }
    } catch {
      sessionStorage.removeItem(`${VOTE_STORAGE_PREFIX}${currentRoom}`);
    }
  };
  const processPresence = (
    message: Extract<RelayedMessage, { type: 'presence' }>,
  ) => {
    const player = state.players.find(
      (item) => item.id === message.participant.id,
    );
    if (!player) return;
    player.lastSeenAt = Date.now();
    player.pageHidden = message.pageHidden;
    if (message.participant.peerId !== player.peerId) {
      player.peerId = message.participant.peerId;
      ensureMesh([message.participant.peerId]);
    }
    render();
  };
  const handleRelay = (sourcePeerId: string, envelope: Envelope) => {
    if (seenMessages.has(envelope.id)) return;
    rememberSeen(envelope.id);
    broadcastRaw(envelope, sourcePeerId);
    if (envelope.payload.type === 'action')
      processAction(envelope.payload.action, false);
    else processPresence(envelope.payload);
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
  const updateOverallConnection = () => {
    const others = visiblePlayers().filter(
      (player) => player.id !== localPlayerId,
    );
    const openCount = [...connections.values()].filter(
      (connection) => connection.open,
    ).length;
    if (!others.length || openCount)
      setConnection('Peer-to-peer room live', 'connected');
    else setConnection('Reconnecting…', 'connecting');
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
      state = mergeRoomState(state, message.state);
      lamport = Math.max(lamport, state.version);
      render();
      return;
    }
    connectionParticipants.set(connection.peer, message.participant.id);
    const diagnostic = diagnostics.get(connection.peer);
    if (diagnostic) diagnostic.participantId = message.participant.id;
    state = mergeRoomState(state, message.state);
    lamport = Math.max(lamport, state.version);
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
  const scheduleReconnect = (remotePeerId: string) => {
    if (reconnectTimers.has(remotePeerId) || disposed) return;
    const timer = window.setTimeout(() => {
      reconnectTimers.delete(remotePeerId);
      if (activePlayers(state).some((player) => player.peerId === remotePeerId))
        ensureMesh([remotePeerId]);
    }, RECONNECT_DELAY_MS);
    reconnectTimers.set(remotePeerId, timer);
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
        participant: identity(),
        state,
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
          metadata: { room: currentRoom, participantId: localPlayerId },
        }),
      );
    }
  }

  const registryDirectory = () =>
    [
      ...new Set([
        localPeerId,
        ...activePlayers(state).map((player) => player.peerId),
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
        state,
      } satisfies RegistryMessage);
      broadcastDirectory();
    });
    connection.on('close', () => registryConnections.delete(connection.peer));
    connection.on('error', () => registryConnections.delete(connection.peer));
  };
  const connectToRegistry = () => {
    if (!peer || !localPeerId || registryConnection?.open || disposed) return;
    registryConnection?.close();
    const connection = peer.connect(registryPeerId(currentRoom), {
      reliable: true,
      metadata: { discovery: true, room: currentRoom },
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
        participant: identity(),
      } satisfies RegistryMessage);
    });
    connection.on('data', (raw) => {
      const message = raw as RegistryMessage;
      if (message.type === 'welcome') {
        state = mergeRoomState(state, message.state);
        lamport = Math.max(lamport, state.version);
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
  const claimRegistry = () => {
    if (registryPeer || registryConnection?.open || disposed || !currentRoom)
      return;
    const candidate = new Peer(registryPeerId(currentRoom), PEER_OPTIONS);
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
  };
  function scheduleRegistryElection() {
    if (registryPeer || registryRetryTimer || disposed) return;
    const ids = visiblePlayers()
      .map((player) => player.id)
      .concat(localPlayerId)
      .sort();
    const index = Math.max(0, ids.indexOf(localPlayerId));
    registryRetryTimer = window.setTimeout(
      () => {
        registryRetryTimer = undefined;
        claimRegistry();
      },
      300 + index * 300,
    );
  }
  const announcePresence = () => {
    if (!localPlayerId) return;
    const player = state.players.find((item) => item.id === localPlayerId);
    if (player) {
      player.lastSeenAt = Date.now();
      player.pageHidden = document.visibilityState !== 'visible';
    }
    relay({
      type: 'presence',
      participant: identity(),
      pageHidden: document.visibilityState !== 'visible',
      sentAt: Date.now(),
    });
    sendOpen(registryConnection, {
      type: 'discover',
      participant: identity(),
    } satisfies RegistryMessage);
  };
  const destroyPeers = () => {
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
  };
  const returnHome = () => {
    if (localPlayerId)
      dispatchAction(makeAction('leave', { playerId: localPlayerId }));
    destroyPeers();
    state = freshRoomState();
    currentRoom = '';
    localPlayerId = '';
    localPeerId = '';
    localVote = null;
    previouslyRevealed = false;
    focusResultAfterReveal = false;
    setup.classList.remove('hidden');
    roomView.classList.add('hidden');
    updateUrl();
  };
  const startRoom = (name: string, roomCode: string) => {
    destroyPeers();
    disposed = false;
    localName = saveProfileName(name);
    currentRoom = normaliseRoomCode(roomCode) || makeRoomCode();
    localPlayerId = roomIdentity(currentRoom);
    state = freshRoomState();
    lamport = 0;
    lastJoinAnnouncedAt = 0;
    localVote = null;
    enterRoom();
    setConnection('Joining peer mesh', 'connecting');
    const roomPeer = new Peer(PEER_OPTIONS);
    peer = roomPeer;
    roomPeer.on('open', (id) => {
      if (peer !== roomPeer || roomPeer.destroyed) return;
      localPeerId = id;
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

  const timerSettings = () => ({
    duration: normaliseTimerDuration(
      Number(timerInput.value) || DEFAULT_TIMER_SECONDS,
    ),
    autoReveal: autoRevealInput.checked,
  });
  const configureTimer = (start: boolean) => {
    const settings = timerSettings();
    dispatchAction(
      makeAction('timer', {
        roundId: state.roundId,
        duration: settings.duration,
        autoReveal: settings.autoReveal,
        endsAt: start
          ? Date.now() + settings.duration * 1000
          : state.timerEndsAt,
      }),
    );
  };

  const enableDebugApi = () => {
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
        if (!state.revealed && !DEBUG_BUILD) {
          console.info('Hidden vote inspection is disabled in production.');
          return;
        }
        console.table(
          visiblePlayers().map((player) => ({
            name: player.name,
            estimate:
              player.voteRoundId !== state.roundId
                ? '—'
                : player.id === localPlayerId && !state.revealed
                  ? (localVote ?? '—')
                  : (player.vote ?? (player.hasVoted ? '?' : '—')),
            status: votingStatusFor(player, state, playerPresence(player)),
          })),
        );
        if (!state.revealed)
          console.info(
            'Other hidden estimates are not transmitted to this peer, including in development.',
          );
      },
      showParticipants: () =>
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
        ),
      showRoomState: () =>
        console.table([
          {
            roomCode: currentRoom,
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
        ]),
      showConnections: () =>
        console.table(
          [...diagnostics.values()].map((row) => {
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
        ),
    };
    console.info(
      'Scrum Poker debug mode enabled. Run scrumPoker.help() for available commands.',
    );
  };

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    createRoomInput.value = normaliseRoomCode(createRoomInput.value);
    if (createForm.reportValidity())
      startRoom(createName.value, createRoomInput.value || makeRoomCode());
  });
  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    roomInput.value = normaliseRoomCode(roomInput.value);
    if (joinForm.reportValidity()) startRoom(joinName.value, roomInput.value);
  });
  roomInput.addEventListener('input', () => {
    roomInput.value = normaliseRoomCode(roomInput.value);
  });
  createRoomInput.addEventListener('input', () => {
    createRoomInput.value = normaliseRoomCode(createRoomInput.value);
  });
  for (const button of cardButtons) {
    button.addEventListener('click', () => {
      if (state.revealed && !state.allowVoteChangesAfterReveal) return;
      localVote =
        localVote === button.dataset.card
          ? null
          : (button.dataset.card ?? null);
      persistLocalVote();
      dispatchAction(
        makeAction('vote', {
          playerId: localPlayerId,
          roundId: state.roundId,
          hasVoted: localVote !== null,
          vote: state.revealed ? localVote : null,
        }),
      );
    });
  }
  revealButton.addEventListener('click', () => {
    focusResultAfterReveal = true;
    dispatchAction(makeAction('reveal', { roundId: state.roundId }));
  });
  resetButton.addEventListener('click', () => {
    dispatchAction(makeAction('new-round', { baseRoundId: state.roundId }));
  });
  timerInput.addEventListener('change', () => configureTimer(false));
  autoRevealInput.addEventListener('change', () => configureTimer(false));
  startTimerButton.addEventListener('click', () => configureTimer(true));
  stopTimerButton.addEventListener('click', () => {
    const settings = timerSettings();
    dispatchAction(
      makeAction('timer', {
        roundId: state.roundId,
        duration: settings.duration,
        autoReveal: settings.autoReveal,
        endsAt: null,
      }),
    );
  });
  allowVoteChangesInput.addEventListener('change', () => {
    dispatchAction(
      makeAction('voting-config', {
        allowVoteChangesAfterReveal: allowVoteChangesInput.checked,
      }),
    );
  });

  profileButton.addEventListener('click', () => openProfile());
  profileClose.addEventListener('click', () => {
    pendingRoomJoin = '';
    profileDialog.close();
  });
  profileDialog.addEventListener('cancel', () => {
    pendingRoomJoin = '';
  });
  profileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!profileForm.reportValidity()) return;
    const nextName = saveProfileName(profileName.value);
    if (!nextName) return;
    localName = nextName;
    profileDialog.close();
    if (localPlayerId)
      dispatchAction(
        makeAction('rename', { playerId: localPlayerId, name: nextName }),
      );
    const roomCode = pendingRoomJoin;
    pendingRoomJoin = '';
    if (roomCode) startRoom(nextName, roomCode);
    else showToast('Profile saved');
  });

  timerInterval = window.setInterval(() => {
    if (state.timerEndsAt === null || state.timerEndsAt > Date.now()) {
      updateTimerDisplay();
      return;
    }
    if (state.autoReveal)
      dispatchAction(makeAction('reveal', { roundId: state.roundId }));
    else {
      const settings = timerSettings();
      dispatchAction(
        makeAction('timer', {
          roundId: state.roundId,
          duration: settings.duration,
          autoReveal: false,
          endsAt: null,
        }),
      );
    }
  }, 250);
  presenceInterval = window.setInterval(() => {
    announcePresence();
    const now = Date.now();
    for (const player of visiblePlayers()) {
      if (
        player.id !== localPlayerId &&
        now - player.lastSeenAt >= PRESENCE_TIMEOUT_MS
      )
        dispatchAction(makeAction('leave', { playerId: player.id }));
    }
    for (const connection of connections.values())
      sendOpen(connection, {
        type: 'ping',
        sentAt: now,
      } satisfies DirectMessage);
    broadcastDirectory();
    render();
  }, HEARTBEAT_INTERVAL_MS);

  const handleResume = () => {
    if (document.visibilityState !== 'visible' || !localPlayerId) return;
    announceJoin();
    announcePresence();
    connectToRegistry();
    ensureMesh(activePlayers(state).map((player) => player.peerId));
  };
  const handleVisibilityChange = () => {
    if (!localPlayerId) return;
    announcePresence();
    handleResume();
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pageshow', handleResume);
  window.addEventListener('online', handleResume);
  const handleCheatCode = (event: KeyboardEvent) => {
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
    enableDebugApi();
    showToast('Developer debug mode enabled for this session');
    cheatCodeBuffer = '';
  };
  document.addEventListener('keydown', handleCheatCode);
  find<HTMLButtonElement>('#copy-room').addEventListener('click', copyInvite);
  find<HTMLButtonElement>('#leave-room').addEventListener('click', returnHome);

  const savedName =
    localStorage.getItem(PROFILE_NAME_STORAGE_KEY) ??
    sessionStorage.getItem(PROFILE_NAME_STORAGE_KEY) ??
    '';
  if (savedName) saveProfileName(savedName);
  createName.value = savedName;
  joinName.value = savedName;
  if (sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') enableDebugApi();
  const roomFromUrl = roomFromLocation();
  if (roomFromUrl) {
    roomInput.value = roomFromUrl;
    if (savedName) startRoom(savedName, roomFromUrl);
    else openProfile(roomFromUrl);
  }

  disposeCurrentRoom = () => {
    disposed = true;
    document.removeEventListener('keydown', handleCheatCode);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pageshow', handleResume);
    window.removeEventListener('online', handleResume);
    window.clearInterval(timerInterval);
    window.clearInterval(presenceInterval);
    window.clearTimeout(toastTimer);
    destroyPeers();
    delete window.scrumPoker;
  };
};

document.addEventListener('astro:page-load', initialiseScrumPoker);
document.addEventListener('astro:before-swap', () => {
  disposeCurrentRoom?.();
  disposeCurrentRoom = undefined;
});
initialiseScrumPoker();
