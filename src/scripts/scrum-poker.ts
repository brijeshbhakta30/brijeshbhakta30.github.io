import Peer, { type DataConnection } from 'peerjs';

type Player = {
  id: string;
  name: string;
  vote: string | null;
  isHost: boolean;
};

type RoomState = {
  players: Player[];
  revealed: boolean;
  round: number;
  timerDuration: number;
  timerEndsAt: number | null;
  autoReveal: boolean;
  allowVoteChangesAfterReveal: boolean;
};

type PokerMessage =
  | { type: 'join'; name: string; wantsFacilitator?: boolean }
  | { type: 'vote'; vote: string | null }
  | { type: 'state'; state: RoomState }
  | { type: 'reveal' }
  | { type: 'reset' }
  | { type: 'request-facilitator' }
  | { type: 'grant-facilitator'; playerId: string }
  | { type: 'configure-timer'; duration: number; autoReveal: boolean }
  | { type: 'start-timer'; duration: number; autoReveal: boolean }
  | { type: 'stop-timer' }
  | { type: 'configure-voting'; allowVoteChangesAfterReveal: boolean }
  | { type: 'rename'; name: string }
  | { type: 'ping' }
  | { type: 'pong' };

const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTWXYZ';
const CARD_ORDER = ['0', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];
const HIDDEN_VOTE = '__hidden__';
const FACILITATOR_CHEAT_CODE = 'makemeadmin';
const FACILITATOR_STORAGE_KEY = 'scrum-poker-facilitator';
const PROFILE_NAME_STORAGE_KEY = 'scrum-poker-name';
const DEFAULT_TIMER_SECONDS = 120;
const MIN_TIMER_SECONDS = 15;
const MAX_TIMER_SECONDS = 60 * 60;
const PRESENCE_TIMEOUT_MS = 5_000;
const configuredTurnUrls = (import.meta.env.PUBLIC_TURN_URLS ?? '')
  .split(',')
  .map((url: string) => url.trim())
  .filter(Boolean)
  .slice(0, 3);
const iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
if (configuredTurnUrls.length > 0) {
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
    sdpSemantics: 'unified-plan',
  },
};

const freshRoomState = (players: Player[] = []): RoomState => ({
  players,
  revealed: false,
  round: 1,
  timerDuration: DEFAULT_TIMER_SECONDS,
  timerEndsAt: null,
  autoReveal: false,
  allowVoteChangesAfterReveal: true,
});

const makeRoomCode = () => Array.from(
  crypto.getRandomValues(new Uint8Array(7)),
  (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length],
).join('');

const normaliseRoomCode = (value: string) => value
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '')
  .slice(0, 32);

const hostPeerId = (roomCode: string) => `brijesh-scrum-${roomCode.toLowerCase()}`;

let disposeCurrentRoom: (() => void) | undefined;

const initialiseScrumPoker = () => {
  const root = document.querySelector<HTMLElement>('[data-scrum-tool]');
  if (!root || root.dataset.initialised === 'true') return;
  root.dataset.initialised = 'true';

  const find = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
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
  const hostControls = find<HTMLElement>('#host-controls');
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
  const cardButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-card]')];
  const toast = find<HTMLElement>('#poker-toast');

  let peer: Peer | undefined;
  let hostConnection: DataConnection | undefined;
  let connections = new Map<string, DataConnection>();
  let lastSeenByPeer = new Map<string, number>();
  let state: RoomState = freshRoomState();
  let currentRoom = '';
  let localPlayerId = '';
  let localName = '';
  let isRoomOwner = false;
  let toastTimer: number | undefined;
  let cheatCodeBuffer = '';
  let timerInterval: number | undefined;
  let presenceInterval: number | undefined;
  let connectionTimeout: number | undefined;
  let previouslyRevealed = false;
  let focusResultAfterReveal = false;
  let pendingRoomJoin = '';

  const showToast = (message: string) => {
    toast.textContent = message;
    toast.classList.remove('translate-y-3', 'opacity-0');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.add('translate-y-3', 'opacity-0'), 2600);
  };

  const showError = (message: string) => {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
    setup.classList.remove('hidden');
    roomView.classList.add('hidden');
  };

  const setConnection = (label: string, status: 'connecting' | 'connected' | 'disconnected') => {
    connectionLabel.lastChild!.textContent = ` ${label}`;
    connectionDot.className = `size-2 rounded-full ${status === 'connected' ? 'bg-accent' : status === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-red-500'}`;
  };

  const inviteUrl = () => {
    const url = new URL(`/tools/scrum-poker/${encodeURIComponent(currentRoom)}`, window.location.origin);
    return url.toString();
  };

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
    const pathMatch = window.location.pathname.match(/^\/tools\/scrum-poker\/([^/]+)\/?$/i);
    const pathRoom = pathMatch ? decodeURIComponent(pathMatch[1]) : '';
    const legacyQueryRoom = new URLSearchParams(window.location.search).get('room') ?? '';
    return normaliseRoomCode(pathRoom || legacyQueryRoom);
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

  const openProfile = (roomCode = '') => {
    pendingRoomJoin = roomCode;
    profileName.value = localName || localStorage.getItem(PROFILE_NAME_STORAGE_KEY) || '';
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

  const broadcastState = () => {
    if (!isRoomOwner) return;
    for (const connection of connections.values()) {
      if (!connection.open) continue;
      const privateState = state.revealed ? state : {
        ...state,
        players: state.players.map((player) => ({
          ...player,
          vote: player.id === connection.peer || player.vote === null ? player.vote : HIDDEN_VOTE,
        })),
      };
      connection.send({ type: 'state', state: privateState } satisfies PokerMessage);
    }
  };

  const numericVotes = () => state.players
    .map((player) => player.vote)
    .filter((vote): vote is string => vote !== null && Number.isFinite(Number(vote)))
    .map(Number);

  const compareVoteValues = (first: string, second: string) => {
    const firstNumber = Number(first);
    const secondNumber = Number(second);
    const firstIsNumeric = Number.isFinite(firstNumber);
    const secondIsNumeric = Number.isFinite(secondNumber);
    if (firstIsNumeric && secondIsNumeric && firstNumber !== secondNumber) return firstNumber - secondNumber;
    if (firstIsNumeric !== secondIsNumeric) return firstIsNumeric ? -1 : 1;

    const firstSpecialIndex = CARD_ORDER.indexOf(first);
    const secondSpecialIndex = CARD_ORDER.indexOf(second);
    const firstOrder = firstSpecialIndex === -1 ? Number.MAX_SAFE_INTEGER : firstSpecialIndex;
    const secondOrder = secondSpecialIndex === -1 ? Number.MAX_SAFE_INTEGER : secondSpecialIndex;
    if (firstOrder !== secondOrder) return firstOrder - secondOrder;
    return first.localeCompare(second, undefined, { sensitivity: 'base' });
  };

  const renderStatistics = (animateReveal: boolean) => {
    statistics.classList.toggle('hidden', !state.revealed);
    statistics.classList.toggle('is-entering', animateReveal);
    if (!state.revealed) return;

    const numbers = numericVotes();
    find<HTMLElement>('#stat-low').textContent = numbers.length ? String(Math.min(...numbers)) : '—';
    find<HTMLElement>('#stat-high').textContent = numbers.length ? String(Math.max(...numbers)) : '—';

    const votes = state.players.map((player) => player.vote).filter((vote): vote is string => vote !== null);
    const consensus = votes.length > 1 && new Set(votes).size === 1;
    find<HTMLElement>('#consensus-label').textContent = consensus
      ? `Consensus reached at ${votes[0]}.`
      : votes.length > 1
        ? 'There is a spread—talk through the assumptions.'
        : votes.length === 1 ? 'One estimate received.' : 'No estimates received.';

    const counts = new Map<string, number>();
    for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
    const orderedVotes = [...counts.keys()].sort(compareVoteValues);
    const highestCount = counts.size ? Math.max(...counts.values()) : 0;
    const mostVoted = orderedVotes.filter((vote) => counts.get(vote) === highestCount);
    find<HTMLElement>('#stat-most-voted').textContent = mostVoted.length ? mostVoted.join(' / ') : '—';
    find<HTMLElement>('#distribution').innerHTML = orderedVotes
      .map((card) => {
        const count = counts.get(card)!;
        const width = votes.length ? (count / votes.length) * 100 : 0;
        return `<div class="grid grid-cols-[24px_1fr_20px] items-center gap-2 text-sm"><span class="truncate font-mono" title="${escapeHtml(card)}">${escapeHtml(card)}</span><span class="h-1 bg-rule"><span class="block h-full bg-accent" style="width:${width}%"></span></span><span class="text-right text-muted">${count}</span></div>`;
      })
      .join('');
  };

  const compareRevealedPlayers = (first: Player, second: Player) => {
    if (first.vote === null) return second.vote === null ? first.name.localeCompare(second.name) : 1;
    if (second.vote === null) return -1;

    const voteOrder = compareVoteValues(first.vote, second.vote);
    if (voteOrder !== 0) return voteOrder;

    const nameOrder = first.name.localeCompare(second.name, undefined, { sensitivity: 'base' });
    return nameOrder || first.id.localeCompare(second.id);
  };

  const normaliseTimerDuration = (value: number) => Math.min(
    MAX_TIMER_SECONDS,
    Math.max(MIN_TIMER_SECONDS, Math.round(value)),
  );

  const updateTimerDisplay = () => {
    const secondsLeft = state.timerEndsAt === null
      ? state.timerDuration
      : Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
    const minutes = Math.floor(secondsLeft / 60);
    const seconds = secondsLeft % 60;
    timerDisplay.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
    const isRunning = state.timerEndsAt !== null;
    timerDisplay.classList.toggle('is-running', isRunning);
    timerDisplay.classList.toggle('is-urgent', isRunning && secondsLeft <= 10);
  };

  const render = () => {
    const voted = state.players.filter((player) => player.vote !== null).length;
    const total = state.players.length;
    const localVote = state.players.find((player) => player.id === localPlayerId)?.vote ?? null;
    const canFacilitate = state.players.some((player) => player.id === localPlayerId && player.isHost);
    const animateReveal = state.revealed && !previouslyRevealed;
    const displayedPlayers = state.revealed
      ? [...state.players].sort(compareRevealedPlayers)
      : state.players;

    roundLabel.textContent = `Round ${state.round}`;
    roundStatus.textContent = state.revealed
      ? 'The cards are on the table'
      : voted === total && total > 0 ? 'Everyone has voted' : `${voted} of ${total} voted`;
    hostControls.classList.toggle('hidden', !canFacilitate);
    timerInput.value = String(state.timerDuration);
    autoRevealInput.checked = state.autoReveal;
    allowVoteChangesInput.checked = state.allowVoteChangesAfterReveal;
    startTimerButton.textContent = state.timerEndsAt === null ? 'Start timer' : 'Restart timer';
    stopTimerButton.classList.toggle('hidden', state.timerEndsAt === null);
    revealButton.disabled = state.revealed || voted === 0;
    revealButton.textContent = state.revealed ? 'Votes revealed' : 'Reveal votes';
    playersGrid.classList.toggle('is-revealed', state.revealed);

    playersGrid.innerHTML = displayedPlayers.map((player, index) => {
      const angle = `${(index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2}rad`;
      const throwAngle = (index / Math.max(displayedPlayers.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const throwX = `${Math.cos(throwAngle) * 210}px`;
      const throwY = `${Math.sin(throwAngle) * 150}px`;
      const votedClass = player.vote !== null ? 'is-voted' : '';
      const revealClass = state.revealed && player.vote !== null ? 'is-revealed' : '';
      const cardValue = state.revealed && player.vote !== null ? player.vote : '•';
      const revealAnimationClass = animateReveal && player.vote !== null ? 'is-reveal-entering' : '';
      return `<article class="scrum-player" style="--angle:${angle};--throw-x:${throwX};--throw-y:${throwY}"><div class="scrum-player-card ${votedClass} ${revealClass} ${revealAnimationClass}">${cardValue}</div><strong class="scrum-player-name">${escapeHtml(player.name)}${player.id === localPlayerId ? ' (you)' : ''}</strong><span class="scrum-player-role">${player.isHost ? 'Facilitator' : player.vote !== null ? 'Ready' : 'Thinking'}</span></article>`;
    }).join('');

    participantList.innerHTML = state.players.map((player) => `<li class="flex items-center justify-between gap-3"><span class="min-w-0 truncate">${escapeHtml(player.name)}${player.id === localPlayerId ? ' (you)' : ''}</span>${canFacilitate && !player.isHost ? `<button class="shrink-0 cursor-pointer border border-rule px-2 py-1 font-mono text-[0.6rem] tracking-[0.04em] uppercase hover:border-accent hover:text-accent" type="button" data-promote-player="${escapeHtml(player.id)}">Make facilitator</button>` : `<span class="shrink-0 font-mono text-[0.65rem] tracking-[0.04em] text-muted uppercase">${player.isHost ? 'Facilitator' : player.vote !== null ? 'Voted' : 'Choosing'}</span>`}</li>`).join('');

    for (const button of cardButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.card === localVote));
      button.disabled = state.revealed && !state.allowVoteChangesAfterReveal;
    }
    cardHint.textContent = state.revealed
      ? state.allowVoteChangesAfterReveal ? 'Choose again to update' : 'Voting is locked'
      : 'Tap again to clear';
    renderStatistics(animateReveal);
    updateTimerDisplay();
    previouslyRevealed = state.revealed;
    if (animateReveal && focusResultAfterReveal) {
      focusResultAfterReveal = false;
      requestAnimationFrame(() => {
        const bounds = statistics.getBoundingClientRect();
        if (bounds.top >= 0 && bounds.bottom <= window.innerHeight) return;
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        statistics.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      });
    }
  };

  const escapeHtml = (value: string) => {
    const element = document.createElement('span');
    element.textContent = value;
    return element.innerHTML;
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

  const applyVote = (playerId: string, vote: string | null) => {
    if (state.revealed && !state.allowVoteChangesAfterReveal) return;
    state = {
      ...state,
      players: state.players.map((player) => player.id === playerId ? { ...player, vote } : player),
    };
    render();
    broadcastState();
  };

  const renamePlayer = (playerId: string, name: string) => {
    const nextName = name.trim().slice(0, 32);
    if (!nextName || !state.players.some((player) => player.id === playerId)) return;
    state = {
      ...state,
      players: state.players.map((player) => player.id === playerId ? { ...player, name: nextName } : player),
    };
    render();
    broadcastState();
  };

  const grantFacilitator = (playerId: string) => {
    if (!isRoomOwner || !state.players.some((player) => player.id === playerId)) return;
    state = {
      ...state,
      players: state.players.map((player) => player.id === playerId ? { ...player, isHost: true } : player),
    };
    render();
    broadcastState();
  };

  const ensureFacilitator = () => {
    if (state.players.some((player) => player.isHost) || state.players.length === 0) return;
    state = {
      ...state,
      players: state.players.map((player, index) => index === 0 ? { ...player, isHost: true } : player),
    };
  };

  const removeGuest = (playerId: string, notify = false) => {
    const player = state.players.find((candidate) => candidate.id === playerId);
    const connection = connections.get(playerId);
    connections.delete(playerId);
    lastSeenByPeer.delete(playerId);
    if (!player) {
      connection?.close();
      return;
    }

    state = { ...state, players: state.players.filter((candidate) => candidate.id !== playerId) };
    ensureFacilitator();
    connection?.close();
    broadcastState();
    render();
    if (notify) showToast(`${player.name} was removed after losing connection`);
  };

  const configureTimer = (duration: number, autoReveal: boolean, start = false) => {
    const timerDuration = normaliseTimerDuration(duration);
    state = {
      ...state,
      timerDuration,
      autoReveal,
      timerEndsAt: start ? Date.now() + timerDuration * 1000 : state.timerEndsAt,
    };
    render();
    broadcastState();
  };

  const stopTimer = () => {
    state = { ...state, timerEndsAt: null };
    render();
    broadcastState();
  };

  const configureVoting = (allowVoteChangesAfterReveal: boolean) => {
    state = { ...state, allowVoteChangesAfterReveal };
    render();
    broadcastState();
  };

  const handleHostMessage = (connection: DataConnection, message: PokerMessage) => {
    if (state.players.some((player) => player.id === connection.peer)) {
      lastSeenByPeer.set(connection.peer, Date.now());
    }
    if (message.type === 'pong') return;
    if (message.type === 'join') {
      const name = message.name.trim().slice(0, 32) || 'Anonymous';
      if (!state.players.some((player) => player.id === connection.peer)) {
        const wantsFacilitator = message.wantsFacilitator === true;
        state = {
          ...state,
          players: [...state.players, {
            id: connection.peer,
            name,
            vote: null,
            isHost: wantsFacilitator || !state.players.some((player) => player.isHost),
          }],
        };
      }
      lastSeenByPeer.set(connection.peer, Date.now());
      broadcastState();
      render();
    }
    if (message.type === 'vote' && (message.vote === null || CARD_ORDER.includes(message.vote))) {
      applyVote(connection.peer, message.vote);
    }
    if (message.type === 'rename') renamePlayer(connection.peer, message.name);
    if (message.type === 'request-facilitator') grantFacilitator(connection.peer);
    if (
      message.type === 'grant-facilitator'
      && state.players.some((player) => player.id === connection.peer && player.isHost)
    ) {
      grantFacilitator(message.playerId);
    }
    if (message.type === 'reveal' && state.players.some((player) => player.id === connection.peer && player.isHost)) {
      state = { ...state, revealed: true, timerEndsAt: null };
      render();
      broadcastState();
    }
    if (message.type === 'reset' && state.players.some((player) => player.id === connection.peer && player.isHost)) {
      state = {
        ...state,
        players: state.players.map((player) => ({ ...player, vote: null })),
        revealed: false,
        round: state.round + 1,
        timerEndsAt: null,
      };
      render();
      broadcastState();
    }
    const canFacilitate = state.players.some((player) => player.id === connection.peer && player.isHost);
    if (message.type === 'configure-timer' && canFacilitate) {
      configureTimer(message.duration, message.autoReveal);
    }
    if (message.type === 'start-timer' && canFacilitate) {
      configureTimer(message.duration, message.autoReveal, true);
    }
    if (message.type === 'stop-timer' && canFacilitate) stopTimer();
    if (message.type === 'configure-voting' && canFacilitate) {
      configureVoting(message.allowVoteChangesAfterReveal);
    }
  };

  const registerGuest = (connection: DataConnection) => {
    connections.set(connection.peer, connection);
    connection.on('data', (data) => handleHostMessage(connection, data as PokerMessage));
    connection.on('error', () => {
      removeGuest(connection.peer);
      showToast('A participant could not establish a WebRTC connection');
    });
    connection.on('close', () => removeGuest(connection.peer));
  };

  const destroyPeer = () => {
    window.clearTimeout(connectionTimeout);
    connectionTimeout = undefined;
    hostConnection?.close();
    for (const connection of connections.values()) connection.close();
    connections.clear();
    lastSeenByPeer.clear();
    peer?.destroy();
    peer = undefined;
    hostConnection = undefined;
  };

  const returnHome = () => {
    destroyPeer();
    state = freshRoomState();
    currentRoom = '';
    localPlayerId = '';
    isRoomOwner = false;
    previouslyRevealed = false;
    focusResultAfterReveal = false;
    setup.classList.remove('hidden');
    roomView.classList.add('hidden');
    updateUrl();
  };

  const startHost = (name: string, roomCode = makeRoomCode()) => {
    destroyPeer();
    localName = saveProfileName(name);
    currentRoom = normaliseRoomCode(roomCode) || makeRoomCode();
    isRoomOwner = true;
    setConnection('Opening room', 'connecting');
    peer = new Peer(hostPeerId(currentRoom), PEER_OPTIONS);

    peer.on('open', (id) => {
      localPlayerId = id;
      state = freshRoomState([{ id, name: localName, vote: null, isHost: true }]);
      enterRoom();
      setConnection('Peer-to-peer room live', 'connected');
    });
    peer.on('connection', registerGuest);
    peer.on('error', (error) => {
      if (error.type === 'webrtc') {
        showToast('A participant could not establish a WebRTC connection');
        return;
      }
      if (error.type === 'unavailable-id') {
        joinRoom(localName, currentRoom);
        return;
      }
      destroyPeer();
      showError('The room could not be opened. Check your connection and try again.');
    });
  };

  const joinRoom = (name: string, roomCode: string) => {
    destroyPeer();
    localName = saveProfileName(name);
    currentRoom = normaliseRoomCode(roomCode);
    isRoomOwner = false;
    setup.classList.add('hidden');
    roomView.classList.remove('hidden');
    roomLabel.textContent = currentRoom;
    updateUrl(currentRoom);
    setConnection('Finding facilitator', 'connecting');
    peer = new Peer(PEER_OPTIONS);

    peer.on('open', (id) => {
      localPlayerId = id;
      hostConnection = peer!.connect(hostPeerId(currentRoom), { reliable: true });
      connectionTimeout = window.setTimeout(() => {
        if (hostConnection?.open) return;
        destroyPeer();
        showError(`Room ${currentRoom} was found, but a secure WebRTC connection could not be established. Try again or change networks.`);
      }, 15_000);
      hostConnection.on('open', () => {
        window.clearTimeout(connectionTimeout);
        connectionTimeout = undefined;
        hostConnection!.send({
          type: 'join',
          name: localName,
          wantsFacilitator: localStorage.getItem(FACILITATOR_STORAGE_KEY) === 'true',
        } satisfies PokerMessage);
        setConnection('Connected securely', 'connected');
        saveProfileName(localName);
      });
      hostConnection.on('data', (data) => {
        const message = data as PokerMessage;
        if (message.type === 'ping') {
          hostConnection?.send({ type: 'pong' } satisfies PokerMessage);
          return;
        }
        if (message.type === 'state') {
          state = {
            ...message.state,
            allowVoteChangesAfterReveal: message.state.allowVoteChangesAfterReveal ?? true,
          };
          render();
        }
      });
      hostConnection.on('close', () => {
        window.clearTimeout(connectionTimeout);
        connectionTimeout = undefined;
        setConnection('Facilitator disconnected', 'disconnected');
      });
      hostConnection.on('error', () => {
        setConnection('WebRTC connection failed', 'disconnected');
      });
    });
    peer.on('error', (error) => {
      destroyPeer();
      if (error.type === 'peer-unavailable') {
        startHost(localName, currentRoom);
        return;
      }
      showError('The room could not be reached. Check your connection and try again.');
    });
  };

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    createRoomInput.value = normaliseRoomCode(createRoomInput.value);
    if (createForm.reportValidity()) startHost(createName.value, createRoomInput.value || makeRoomCode());
  });

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    roomInput.value = normaliseRoomCode(roomInput.value);
    if (joinForm.reportValidity()) joinRoom(joinName.value, roomInput.value);
  });

  roomInput.addEventListener('input', () => {
    roomInput.value = normaliseRoomCode(roomInput.value);
  });
  createRoomInput.addEventListener('input', () => {
    createRoomInput.value = normaliseRoomCode(createRoomInput.value);
  });

  for (const button of cardButtons) {
    button.addEventListener('click', () => {
      const selected = state.players.find((player) => player.id === localPlayerId)?.vote;
      const vote = selected === button.dataset.card ? null : button.dataset.card ?? null;
      if (isRoomOwner) applyVote(localPlayerId, vote);
      else if (hostConnection?.open) hostConnection.send({ type: 'vote', vote } satisfies PokerMessage);
    });
  }

  revealButton.addEventListener('click', () => {
    const canFacilitate = state.players.some((player) => player.id === localPlayerId && player.isHost);
    if (!canFacilitate) return;
    focusResultAfterReveal = true;
    if (isRoomOwner) {
      state = { ...state, revealed: true, timerEndsAt: null };
      render();
      broadcastState();
    } else if (hostConnection?.open) hostConnection.send({ type: 'reveal' } satisfies PokerMessage);
  });

  resetButton.addEventListener('click', () => {
    const canFacilitate = state.players.some((player) => player.id === localPlayerId && player.isHost);
    if (!canFacilitate) return;
    if (isRoomOwner) {
      state = {
        ...state,
        players: state.players.map((player) => ({ ...player, vote: null })),
        revealed: false,
        round: state.round + 1,
        timerEndsAt: null,
      };
      render();
      broadcastState();
    } else if (hostConnection?.open) hostConnection.send({ type: 'reset' } satisfies PokerMessage);
  });

  participantList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-promote-player]');
    const playerId = button?.dataset.promotePlayer;
    const canFacilitate = state.players.some((player) => player.id === localPlayerId && player.isHost);
    if (!playerId || !canFacilitate) return;

    if (isRoomOwner) grantFacilitator(playerId);
    else if (hostConnection?.open) {
      hostConnection.send({ type: 'grant-facilitator', playerId } satisfies PokerMessage);
    }
  });

  const timerSettings = () => ({
    duration: normaliseTimerDuration(Number(timerInput.value) || DEFAULT_TIMER_SECONDS),
    autoReveal: autoRevealInput.checked,
  });

  const sendTimerMessage = (message: PokerMessage) => {
    if (isRoomOwner) {
      if (message.type === 'configure-timer') configureTimer(message.duration, message.autoReveal);
      if (message.type === 'start-timer') configureTimer(message.duration, message.autoReveal, true);
      if (message.type === 'stop-timer') stopTimer();
    } else if (hostConnection?.open) hostConnection.send(message);
  };

  timerInput.addEventListener('change', () => {
    const settings = timerSettings();
    timerInput.value = String(settings.duration);
    sendTimerMessage({ type: 'configure-timer', ...settings });
  });
  autoRevealInput.addEventListener('change', () => {
    sendTimerMessage({ type: 'configure-timer', ...timerSettings() });
  });
  startTimerButton.addEventListener('click', () => {
    sendTimerMessage({ type: 'start-timer', ...timerSettings() });
  });
  stopTimerButton.addEventListener('click', () => {
    sendTimerMessage({ type: 'stop-timer' });
  });
  allowVoteChangesInput.addEventListener('change', () => {
    const message = {
      type: 'configure-voting',
      allowVoteChangesAfterReveal: allowVoteChangesInput.checked,
    } satisfies PokerMessage;
    if (isRoomOwner) configureVoting(message.allowVoteChangesAfterReveal);
    else if (hostConnection?.open) hostConnection.send(message);
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

    if (localPlayerId) {
      if (isRoomOwner) renamePlayer(localPlayerId, nextName);
      else if (hostConnection?.open) hostConnection.send({ type: 'rename', name: nextName } satisfies PokerMessage);
    }

    const roomCode = pendingRoomJoin;
    pendingRoomJoin = '';
    if (roomCode) joinRoom(nextName, roomCode);
    else showToast('Profile saved');
  });

  timerInterval = window.setInterval(() => {
    if (state.timerEndsAt === null) return;
    if (state.timerEndsAt > Date.now()) {
      updateTimerDisplay();
      return;
    }
    if (!isRoomOwner) {
      updateTimerDisplay();
      return;
    }

    const shouldReveal = state.autoReveal;
    state = {
      ...state,
      timerEndsAt: null,
      revealed: shouldReveal ? true : state.revealed,
    };
    render();
    broadcastState();
    if (shouldReveal) showToast('Time is up — votes revealed');
  }, 250);

  presenceInterval = window.setInterval(() => {
    if (!isRoomOwner) return;
    const now = Date.now();
    for (const [playerId, connection] of connections) {
      if (connection.open) connection.send({ type: 'ping' } satisfies PokerMessage);
      const lastSeen = lastSeenByPeer.get(playerId);
      if (lastSeen !== undefined && now - lastSeen >= PRESENCE_TIMEOUT_MS) {
        removeGuest(playerId, true);
      }
    }
  }, 1_000);

  const handleVisibilityChange = () => {
    if (!isRoomOwner || document.visibilityState !== 'visible') return;
    const now = Date.now();
    for (const playerId of lastSeenByPeer.keys()) lastSeenByPeer.set(playerId, now);
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);

  const handleCheatCode = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
    cheatCodeBuffer = `${cheatCodeBuffer}${event.key.toLowerCase()}`.slice(-FACILITATOR_CHEAT_CODE.length);
    if (cheatCodeBuffer !== FACILITATOR_CHEAT_CODE) return;

    localStorage.setItem(FACILITATOR_STORAGE_KEY, 'true');
    if (isRoomOwner) grantFacilitator(localPlayerId);
    else if (hostConnection?.open) hostConnection.send({ type: 'request-facilitator' } satisfies PokerMessage);
    showToast('Facilitator access enabled and remembered');
    cheatCodeBuffer = '';
  };
  document.addEventListener('keydown', handleCheatCode);

  find<HTMLButtonElement>('#copy-room').addEventListener('click', copyInvite);
  find<HTMLButtonElement>('#leave-room').addEventListener('click', returnHome);

  const savedName = localStorage.getItem(PROFILE_NAME_STORAGE_KEY)
    ?? sessionStorage.getItem(PROFILE_NAME_STORAGE_KEY)
    ?? '';
  if (savedName) saveProfileName(savedName);
  createName.value = savedName;
  joinName.value = savedName;
  const roomFromUrl = roomFromLocation();
  if (roomFromUrl.length >= 1) {
    roomInput.value = roomFromUrl;
    if (savedName) joinRoom(savedName, roomFromUrl);
    else openProfile(roomFromUrl);
  }

  disposeCurrentRoom = () => {
    document.removeEventListener('keydown', handleCheatCode);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.clearInterval(timerInterval);
    window.clearInterval(presenceInterval);
    destroyPeer();
  };
};

document.addEventListener('astro:page-load', initialiseScrumPoker);
document.addEventListener('astro:before-swap', () => {
  disposeCurrentRoom?.();
  disposeCurrentRoom = undefined;
});
initialiseScrumPoker();
