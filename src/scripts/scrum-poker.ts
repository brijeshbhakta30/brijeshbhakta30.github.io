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
  | { type: 'stop-timer' };

const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTWXYZ';
const CARD_ORDER = ['0', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];
const HIDDEN_VOTE = '__hidden__';
const FACILITATOR_CHEAT_CODE = 'makemeadmin';
const FACILITATOR_STORAGE_KEY = 'scrum-poker-facilitator';
const SPECIAL_ROOMS = new Set(['KINGFISHER', 'ATLANTIS']);
const DEFAULT_TIMER_SECONDS = 120;
const MIN_TIMER_SECONDS = 15;
const MAX_TIMER_SECONDS = 60 * 60;
const PEER_OPTIONS = {
  debug: 0 as const,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp',
          'turns:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
        username: 'peerjs',
        credential: 'peerjsp',
      },
    ],
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
});

const makeRoomCode = () => Array.from(
  crypto.getRandomValues(new Uint8Array(7)),
  (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length],
).join('');

const normaliseRoomCode = (value: string) => value
  .trim()
  .toUpperCase()
  .replace(/\s+/g, '-')
  .replace(/[^A-Z0-9-]/g, '')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 32);

const namedRoomSession = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

const hostPeerId = (roomCode: string) => {
  const roomId = roomCode.toLowerCase();
  return SPECIAL_ROOMS.has(roomCode)
    ? `brijesh-scrum-${roomId}-${namedRoomSession()}`
    : `brijesh-scrum-${roomId}`;
};

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
  const startTimerButton = find<HTMLButtonElement>('#start-timer');
  const stopTimerButton = find<HTMLButtonElement>('#stop-timer');
  const statistics = find<HTMLElement>('#statistics');
  const cardButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-card]')];
  const toast = find<HTMLElement>('#poker-toast');

  let peer: Peer | undefined;
  let hostConnection: DataConnection | undefined;
  let connections = new Map<string, DataConnection>();
  let state: RoomState = freshRoomState();
  let currentRoom = '';
  let localPlayerId = '';
  let localName = '';
  let isRoomOwner = false;
  let toastTimer: number | undefined;
  let cheatCodeBuffer = '';
  let timerInterval: number | undefined;
  let connectionTimeout: number | undefined;

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
    const url = new URL('/tools/scrum-poker', window.location.origin);
    url.searchParams.set('room', currentRoom);
    return url.toString();
  };

  const updateUrl = (roomCode?: string) => {
    const url = new URL(window.location.href);
    if (roomCode) url.searchParams.set('room', roomCode);
    else url.searchParams.delete('room');
    history.replaceState({}, '', url);
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

  const renderStatistics = () => {
    statistics.classList.toggle('hidden', !state.revealed);
    if (!state.revealed) return;

    const numbers = numericVotes();
    find<HTMLElement>('#stat-average').textContent = numbers.length
      ? (numbers.reduce((total, value) => total + value, 0) / numbers.length).toFixed(1).replace('.0', '')
      : '—';
    find<HTMLElement>('#stat-low').textContent = numbers.length ? String(Math.min(...numbers)) : '—';
    find<HTMLElement>('#stat-high').textContent = numbers.length ? String(Math.max(...numbers)) : '—';

    const votes = state.players.map((player) => player.vote).filter((vote): vote is string => vote !== null);
    const consensus = votes.length > 1 && new Set(votes).size === 1;
    find<HTMLElement>('#consensus-label').textContent = consensus
      ? `Consensus reached at ${votes[0]}.`
      : votes.length > 1 ? 'There is a spread—talk through the assumptions.' : 'One estimate received.';

    const counts = new Map<string, number>();
    for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
    find<HTMLElement>('#distribution').innerHTML = CARD_ORDER
      .filter((card) => counts.has(card))
      .map((card) => {
        const count = counts.get(card)!;
        const width = votes.length ? (count / votes.length) * 100 : 0;
        return `<div class="grid grid-cols-[24px_1fr_20px] items-center gap-2 text-sm"><span class="font-mono">${card}</span><span class="h-1 bg-rule"><span class="block h-full bg-accent" style="width:${width}%"></span></span><span class="text-right text-muted">${count}</span></div>`;
      })
      .join('');
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
    timerDisplay.classList.toggle('text-accent', state.timerEndsAt !== null);
  };

  const render = () => {
    const voted = state.players.filter((player) => player.vote !== null).length;
    const total = state.players.length;
    const localVote = state.players.find((player) => player.id === localPlayerId)?.vote ?? null;
    const canFacilitate = state.players.some((player) => player.id === localPlayerId && player.isHost);

    roundLabel.textContent = `Round ${state.round}`;
    roundStatus.textContent = state.revealed
      ? 'The cards are on the table'
      : voted === total && total > 0 ? 'Everyone has voted' : `${voted} of ${total} voted`;
    hostControls.classList.toggle('hidden', !canFacilitate);
    timerInput.value = String(state.timerDuration);
    autoRevealInput.checked = state.autoReveal;
    startTimerButton.textContent = state.timerEndsAt === null ? 'Start timer' : 'Restart timer';
    stopTimerButton.classList.toggle('hidden', state.timerEndsAt === null);
    revealButton.disabled = state.revealed || voted === 0;
    revealButton.textContent = state.revealed ? 'Votes revealed' : 'Reveal votes';

    playersGrid.innerHTML = state.players.map((player, index) => {
      const angle = `${(index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2}rad`;
      const votedClass = player.vote !== null ? 'is-voted' : '';
      const revealClass = state.revealed && player.vote !== null ? 'is-revealed' : '';
      const cardValue = state.revealed && player.vote !== null ? player.vote : '•';
      return `<article class="scrum-player" style="--angle:${angle}"><div class="scrum-player-card ${votedClass} ${revealClass}">${cardValue}</div><strong class="scrum-player-name">${escapeHtml(player.name)}${player.id === localPlayerId ? ' (you)' : ''}</strong><span class="scrum-player-role">${player.isHost ? 'Facilitator' : player.vote !== null ? 'Ready' : 'Thinking'}</span></article>`;
    }).join('');

    participantList.innerHTML = state.players.map((player) => `<li class="flex items-center justify-between gap-3"><span class="min-w-0 truncate">${escapeHtml(player.name)}${player.id === localPlayerId ? ' (you)' : ''}</span>${canFacilitate && !player.isHost ? `<button class="shrink-0 cursor-pointer border border-rule px-2 py-1 font-mono text-[0.6rem] tracking-[0.04em] uppercase hover:border-accent hover:text-accent" type="button" data-promote-player="${escapeHtml(player.id)}">Make facilitator</button>` : `<span class="shrink-0 font-mono text-[0.65rem] tracking-[0.04em] text-muted uppercase">${player.isHost ? 'Facilitator' : player.vote !== null ? 'Voted' : 'Choosing'}</span>`}</li>`).join('');

    for (const button of cardButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.card === localVote));
      button.disabled = state.revealed;
    }
    renderStatistics();
    updateTimerDisplay();
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
    sessionStorage.setItem('scrum-poker-name', localName);
    render();
  };

  const applyVote = (playerId: string, vote: string | null) => {
    if (state.revealed) return;
    state = {
      ...state,
      players: state.players.map((player) => player.id === playerId ? { ...player, vote } : player),
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

  const handleHostMessage = (connection: DataConnection, message: PokerMessage) => {
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
      broadcastState();
      render();
    }
    if (message.type === 'vote' && (message.vote === null || CARD_ORDER.includes(message.vote))) {
      applyVote(connection.peer, message.vote);
    }
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
  };

  const registerGuest = (connection: DataConnection) => {
    connections.set(connection.peer, connection);
    connection.on('data', (data) => handleHostMessage(connection, data as PokerMessage));
    connection.on('error', () => {
      connections.delete(connection.peer);
      showToast('A participant could not establish a WebRTC connection');
    });
    connection.on('close', () => {
      connections.delete(connection.peer);
      state = { ...state, players: state.players.filter((player) => player.id !== connection.peer) };
      ensureFacilitator();
      broadcastState();
      render();
    });
  };

  const destroyPeer = () => {
    window.clearTimeout(connectionTimeout);
    connectionTimeout = undefined;
    hostConnection?.close();
    for (const connection of connections.values()) connection.close();
    connections.clear();
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
    setup.classList.remove('hidden');
    roomView.classList.add('hidden');
    updateUrl();
  };

  const startHost = (name: string, roomCode = makeRoomCode()) => {
    destroyPeer();
    localName = name.trim();
    currentRoom = roomCode;
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
      if (error.type === 'unavailable-id' && SPECIAL_ROOMS.has(currentRoom)) {
        joinRoom(localName, currentRoom);
        return;
      }
      destroyPeer();
      showError('The room could not be opened. Check your connection and try again.');
    });
  };

  const joinRoom = (name: string, roomCode: string) => {
    destroyPeer();
    localName = name.trim();
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
        sessionStorage.setItem('scrum-poker-name', localName);
      });
      hostConnection.on('data', (data) => {
        const message = data as PokerMessage;
        if (message.type === 'state') {
          state = message.state;
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
      if (error.type === 'peer-unavailable' && SPECIAL_ROOMS.has(currentRoom)) {
        startHost(localName, currentRoom);
        return;
      }
      const message = error.type === 'peer-unavailable'
        ? `Room ${currentRoom} is not available. Check the code or ask the facilitator to reopen it.`
        : 'The room could not be reached. Check your connection and try again.';
      showError(message);
    });
  };

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (createForm.reportValidity()) startHost(createName.value);
  });

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    roomInput.value = normaliseRoomCode(roomInput.value);
    if (joinForm.reportValidity()) joinRoom(joinName.value, roomInput.value);
  });

  roomInput.addEventListener('input', () => {
    roomInput.value = normaliseRoomCode(roomInput.value);
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

  const savedName = sessionStorage.getItem('scrum-poker-name') ?? '';
  createName.value = savedName;
  joinName.value = savedName;
  const roomFromUrl = normaliseRoomCode(new URLSearchParams(window.location.search).get('room') ?? '');
  if (roomFromUrl.length >= 3) {
    roomInput.value = roomFromUrl;
    (savedName ? roomInput : joinName).focus();
  }

  disposeCurrentRoom = () => {
    document.removeEventListener('keydown', handleCheatCode);
    window.clearInterval(timerInterval);
    destroyPeer();
  };
};

document.addEventListener('astro:page-load', initialiseScrumPoker);
document.addEventListener('astro:before-swap', () => {
  disposeCurrentRoom?.();
  disposeCurrentRoom = undefined;
});
initialiseScrumPoker();
