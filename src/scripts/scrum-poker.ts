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
};

type PokerMessage =
  | { type: 'join'; name: string }
  | { type: 'vote'; vote: string | null }
  | { type: 'state'; state: RoomState }
  | { type: 'reveal' }
  | { type: 'reset' };

const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTWXYZ';
const CARD_ORDER = ['0', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];
const HIDDEN_VOTE = '__hidden__';

const makeRoomCode = () => Array.from(
  crypto.getRandomValues(new Uint8Array(7)),
  (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length],
).join('');

const normaliseRoomCode = (value: string) => value
  .toUpperCase()
  .replace(/O/g, '0')
  .replace(/[IL]/g, '1')
  .replace(/[^A-Z0-9]/g, '')
  .slice(0, 7);

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
  const statistics = find<HTMLElement>('#statistics');
  const cardButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-card]')];
  const toast = find<HTMLElement>('#poker-toast');

  let peer: Peer | undefined;
  let hostConnection: DataConnection | undefined;
  let connections = new Map<string, DataConnection>();
  let state: RoomState = { players: [], revealed: false, round: 1 };
  let currentRoom = '';
  let localPlayerId = '';
  let localName = '';
  let isHost = false;
  let toastTimer: number | undefined;

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
    if (!isHost) return;
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

  const render = () => {
    const voted = state.players.filter((player) => player.vote !== null).length;
    const total = state.players.length;
    const localVote = state.players.find((player) => player.id === localPlayerId)?.vote ?? null;

    roundLabel.textContent = `Round ${state.round}`;
    roundStatus.textContent = state.revealed
      ? 'The cards are on the table'
      : voted === total && total > 0 ? 'Everyone has voted' : `${voted} of ${total} voted`;
    hostControls.classList.toggle('hidden', !isHost);
    revealButton.disabled = state.revealed || voted === 0;
    revealButton.textContent = state.revealed ? 'Votes revealed' : 'Reveal votes';

    playersGrid.innerHTML = state.players.map((player, index) => {
      const angle = `${(index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2}rad`;
      const votedClass = player.vote !== null ? 'is-voted' : '';
      const revealClass = state.revealed && player.vote !== null ? 'is-revealed' : '';
      const cardValue = state.revealed && player.vote !== null ? player.vote : '•';
      return `<article class="scrum-player" style="--angle:${angle}"><div class="scrum-player-card ${votedClass} ${revealClass}">${cardValue}</div><strong class="scrum-player-name">${escapeHtml(player.name)}${player.id === localPlayerId ? ' (you)' : ''}</strong><span class="scrum-player-role">${player.isHost ? 'Facilitator' : player.vote !== null ? 'Ready' : 'Thinking'}</span></article>`;
    }).join('');

    participantList.innerHTML = state.players.map((player) => `<li class="flex items-center justify-between gap-3"><span class="min-w-0 truncate">${escapeHtml(player.name)}${player.id === localPlayerId ? ' (you)' : ''}</span><span class="shrink-0 font-mono text-[0.65rem] tracking-[0.04em] text-muted uppercase">${player.isHost ? 'Host' : player.vote !== null ? 'Voted' : 'Choosing'}</span></li>`).join('');

    for (const button of cardButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.card === localVote));
      button.disabled = state.revealed;
    }
    renderStatistics();
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

  const handleHostMessage = (connection: DataConnection, message: PokerMessage) => {
    if (message.type === 'join') {
      const name = message.name.trim().slice(0, 32) || 'Anonymous';
      if (!state.players.some((player) => player.id === connection.peer)) {
        state = { ...state, players: [...state.players, { id: connection.peer, name, vote: null, isHost: false }] };
      }
      broadcastState();
      render();
    }
    if (message.type === 'vote' && (message.vote === null || CARD_ORDER.includes(message.vote))) {
      applyVote(connection.peer, message.vote);
    }
  };

  const registerGuest = (connection: DataConnection) => {
    connections.set(connection.peer, connection);
    connection.on('data', (data) => handleHostMessage(connection, data as PokerMessage));
    connection.on('close', () => {
      connections.delete(connection.peer);
      state = { ...state, players: state.players.filter((player) => player.id !== connection.peer) };
      broadcastState();
      render();
    });
  };

  const destroyPeer = () => {
    hostConnection?.close();
    for (const connection of connections.values()) connection.close();
    connections.clear();
    peer?.destroy();
    peer = undefined;
    hostConnection = undefined;
  };

  const returnHome = () => {
    destroyPeer();
    state = { players: [], revealed: false, round: 1 };
    currentRoom = '';
    localPlayerId = '';
    isHost = false;
    setup.classList.remove('hidden');
    roomView.classList.add('hidden');
    updateUrl();
  };

  const startHost = (name: string) => {
    destroyPeer();
    localName = name.trim();
    currentRoom = makeRoomCode();
    isHost = true;
    setConnection('Opening room', 'connecting');
    peer = new Peer(hostPeerId(currentRoom), { debug: 1 });

    peer.on('open', (id) => {
      localPlayerId = id;
      state = { players: [{ id, name: localName, vote: null, isHost: true }], revealed: false, round: 1 };
      enterRoom();
      setConnection('Peer-to-peer room live', 'connected');
    });
    peer.on('connection', registerGuest);
    peer.on('error', () => {
      destroyPeer();
      showError('The room could not be opened. Check your connection and try again.');
    });
  };

  const joinRoom = (name: string, roomCode: string) => {
    destroyPeer();
    localName = name.trim();
    currentRoom = normaliseRoomCode(roomCode);
    isHost = false;
    setup.classList.add('hidden');
    roomView.classList.remove('hidden');
    roomLabel.textContent = currentRoom;
    updateUrl(currentRoom);
    setConnection('Finding facilitator', 'connecting');
    peer = new Peer({ debug: 1 });

    peer.on('open', (id) => {
      localPlayerId = id;
      hostConnection = peer!.connect(hostPeerId(currentRoom), { reliable: true });
      hostConnection.on('open', () => {
        hostConnection!.send({ type: 'join', name: localName } satisfies PokerMessage);
        setConnection('Connected directly', 'connected');
        sessionStorage.setItem('scrum-poker-name', localName);
      });
      hostConnection.on('data', (data) => {
        const message = data as PokerMessage;
        if (message.type === 'state') {
          state = message.state;
          render();
        }
      });
      hostConnection.on('close', () => setConnection('Facilitator disconnected', 'disconnected'));
    });
    peer.on('error', (error) => {
      destroyPeer();
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
      if (isHost) applyVote(localPlayerId, vote);
      else if (hostConnection?.open) hostConnection.send({ type: 'vote', vote } satisfies PokerMessage);
    });
  }

  revealButton.addEventListener('click', () => {
    if (!isHost) return;
    state = { ...state, revealed: true };
    render();
    broadcastState();
  });

  resetButton.addEventListener('click', () => {
    if (!isHost) return;
    state = {
      players: state.players.map((player) => ({ ...player, vote: null })),
      revealed: false,
      round: state.round + 1,
    };
    render();
    broadcastState();
  });

  find<HTMLButtonElement>('#copy-room').addEventListener('click', copyInvite);
  find<HTMLButtonElement>('#leave-room').addEventListener('click', returnHome);

  const savedName = sessionStorage.getItem('scrum-poker-name') ?? '';
  createName.value = savedName;
  joinName.value = savedName;
  const roomFromUrl = normaliseRoomCode(new URLSearchParams(window.location.search).get('room') ?? '');
  if (roomFromUrl.length === 7) {
    roomInput.value = roomFromUrl;
    (savedName ? roomInput : joinName).focus();
  }

  disposeCurrentRoom = destroyPeer;
};

document.addEventListener('astro:page-load', initialiseScrumPoker);
document.addEventListener('astro:before-swap', () => {
  disposeCurrentRoom?.();
  disposeCurrentRoom = undefined;
});
initialiseScrumPoker();
