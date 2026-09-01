import {
  DEFAULT_TIMER_SECONDS,
  PRESENCE_TIMEOUT_MS,
  activePlayers,
  applyRoomAction,
  freshRoomState,
  makeRandomId,
  normalizeTimerDuration,
  type RoomAction,
  type RoomState,
} from './state';
import { DEBUG_SESSION_KEY } from './constants';
import {
  createDebugCheatCodeHandler,
  enableDebugApi as installDebugApi,
} from './debug';
import { queryScrumPokerElements } from './dom';
import {
  DEBUG_BUILD,
  createScrumPokerNetwork,
  type ParticipantIdentity,
  type RelayedMessage,
  type ScrumPokerNetwork,
} from './network';
import {
  renderScrumPoker,
  setConnection as renderConnection,
  showError as renderError,
  showToast as renderToast,
  updateTimerDisplay,
} from './render';
import {
  inviteUrl,
  loadLocalVote,
  makeRoomCode,
  normalizeRoomCode,
  persistLocalVote as storeLocalVote,
  roomFromLocation,
  roomIdentity,
  savedLocalProfileName,
  saveProfileName as storeProfileName,
  savedProfileName,
  updateRoomUrl,
} from './storage';

let disposeCurrentRoom: (() => void) | undefined;

const initializeScrumPoker = () => {
  const elements = queryScrumPokerElements();
  if (!elements) return;

  let state = freshRoomState();
  let currentRoom = '';
  let localPlayerId = '';
  let localPeerId = '';
  let localName = '';
  let localVote: string | null = null;
  let logicalClock = 0;
  let toastTimer: number | undefined;
  let timerInterval: number | undefined;
  let presenceInterval: number | undefined;
  let previouslyRevealed = false;
  let focusResultAfterReveal = false;
  let pendingRoomJoin = '';
  let lastJoinAnnouncedAt = 0;
  let network: ScrumPokerNetwork;

  const setState = (nextState: RoomState) => {
    state = nextState;
    logicalClock = Math.max(logicalClock, state.version);
  };

  const showToast = (message: string) => {
    toastTimer = renderToast(elements, message, toastTimer);
  };

  const showError = (message: string) => {
    renderError(elements, message);
  };

  const setConnection = (
    label: string,
    status: 'connecting' | 'connected' | 'disconnected',
  ) => {
    renderConnection(elements, label, status);
  };

  const identity = (): ParticipantIdentity => ({
    id: localPlayerId,
    peerId: localPeerId,
    name: localName,
  });

  const saveProfileName = (name: string) => {
    const nextName = storeProfileName(name);
    if (!nextName) return '';
    elements.createName.value = nextName;
    elements.joinName.value = nextName;
    elements.profileName.value = nextName;
    return nextName;
  };

  const render = () => {
    const result = renderScrumPoker({
      elements,
      state,
      localPlayerId,
      localVote,
      previouslyRevealed,
      focusResultAfterReveal,
      hasOpenConnection: (player) => network.hasOpenConnection(player),
    });
    previouslyRevealed = result.previouslyRevealed;
    focusResultAfterReveal = result.focusResultAfterReveal;
  };

  const makeAction = <T extends RoomAction['type']>(
    type: T,
    payload: Extract<RoomAction, { type: T }>['payload'],
  ) => {
    logicalClock = Math.max(logicalClock, state.version) + 1;
    return {
      id: `${String(logicalClock).padStart(10, '0')}-${localPlayerId}-${makeRandomId()}`,
      actorId: localPlayerId,
      counter: logicalClock,
      type,
      payload,
    } as Extract<RoomAction, { type: T }>;
  };

  const persistLocalVote = () => {
    storeLocalVote(currentRoom, state.roundId, localVote);
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
    logicalClock = Math.max(logicalClock, action.counter);
    const wasRevealed = state.revealed;
    const previousRoundId = state.roundId;
    state = applyRoomAction(state, action);
    if (previousRoundId !== state.roundId) {
      localVote = null;
      persistLocalVote();
    }
    render();
    if (shouldRelay) network.relay({ type: 'action', action });
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
    const savedVote = loadLocalVote(currentRoom, state.roundId);
    if (!savedVote) return;
    localVote = savedVote;
    dispatchAction(
      makeAction('vote', {
        playerId: localPlayerId,
        roundId: state.roundId,
        hasVoted: true,
        vote: state.revealed ? localVote : null,
      }),
    );
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
      network.ensureMesh([message.participant.peerId]);
    }
    render();
  };

  network = createScrumPokerNetwork({
    getState: () => state,
    setState,
    getRoomCode: () => currentRoom,
    getLocalPeerId: () => localPeerId,
    setLocalPeerId: (peerId) => {
      localPeerId = peerId;
    },
    getLocalPlayerId: () => localPlayerId,
    getIdentity: identity,
    onAction: processAction,
    onPresence: processPresence,
    announceJoin,
    restoreLocalVote,
    render,
    setConnection,
    showToast,
    showError,
  });

  const enterRoom = () => {
    elements.setup.classList.add('hidden');
    elements.roomView.classList.remove('hidden');
    elements.errorBox.classList.add('hidden');
    elements.roomLabel.textContent = currentRoom;
    updateRoomUrl(currentRoom);
    saveProfileName(localName);
    render();
  };

  const openProfile = (roomCode = '') => {
    pendingRoomJoin = roomCode;
    elements.profileName.value = localName || savedLocalProfileName();
    elements.profileDialog.showModal();
    requestAnimationFrame(() => elements.profileName.focus());
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl(currentRoom));
      showToast('Invite link copied');
    } catch {
      showToast(`Room code: ${currentRoom}`);
    }
  };

  const returnHome = () => {
    if (localPlayerId)
      dispatchAction(makeAction('leave', { playerId: localPlayerId }));
    network.destroy();
    state = freshRoomState();
    currentRoom = '';
    localPlayerId = '';
    localPeerId = '';
    localVote = null;
    previouslyRevealed = false;
    focusResultAfterReveal = false;
    elements.setup.classList.remove('hidden');
    elements.roomView.classList.add('hidden');
    updateRoomUrl();
  };

  const startRoom = (name: string, roomCode: string) => {
    network.destroy();
    localName = saveProfileName(name);
    currentRoom = normalizeRoomCode(roomCode) || makeRoomCode();
    localPlayerId = roomIdentity(currentRoom);
    state = freshRoomState();
    logicalClock = 0;
    lastJoinAnnouncedAt = 0;
    localVote = null;
    enterRoom();
    network.start();
  };

  const timerSettings = () => ({
    duration: normalizeTimerDuration(
      Number(elements.timerInput.value) || DEFAULT_TIMER_SECONDS,
    ),
    autoReveal: elements.autoRevealInput.checked,
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
    installDebugApi({
      getState: () => state,
      getCurrentRoom: () => currentRoom,
      getLocalPlayerId: () => localPlayerId,
      getLocalVote: () => localVote,
      getDiagnostics: network.diagnostics,
      hasOpenConnection: network.hasOpenConnection,
      debugBuild: DEBUG_BUILD,
    });
  };

  elements.createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    elements.createRoomInput.value = normalizeRoomCode(
      elements.createRoomInput.value,
    );
    if (elements.createForm.reportValidity())
      startRoom(
        elements.createName.value,
        elements.createRoomInput.value || makeRoomCode(),
      );
  });
  elements.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    elements.roomInput.value = normalizeRoomCode(elements.roomInput.value);
    if (elements.joinForm.reportValidity())
      startRoom(elements.joinName.value, elements.roomInput.value);
  });
  elements.roomInput.addEventListener('input', () => {
    elements.roomInput.value = normalizeRoomCode(elements.roomInput.value);
  });
  elements.createRoomInput.addEventListener('input', () => {
    elements.createRoomInput.value = normalizeRoomCode(
      elements.createRoomInput.value,
    );
  });
  for (const button of elements.cardButtons) {
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
  elements.revealButton.addEventListener('click', () => {
    focusResultAfterReveal = true;
    dispatchAction(makeAction('reveal', { roundId: state.roundId }));
  });
  elements.resetButton.addEventListener('click', () => {
    dispatchAction(makeAction('new-round', { baseRoundId: state.roundId }));
  });
  elements.timerInput.addEventListener('change', () => configureTimer(false));
  elements.autoRevealInput.addEventListener('change', () =>
    configureTimer(false),
  );
  elements.startTimerButton.addEventListener('click', () =>
    configureTimer(true),
  );
  elements.stopTimerButton.addEventListener('click', () => {
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
  elements.allowVoteChangesInput.addEventListener('change', () => {
    dispatchAction(
      makeAction('voting-config', {
        allowVoteChangesAfterReveal: elements.allowVoteChangesInput.checked,
      }),
    );
  });

  elements.profileButton.addEventListener('click', () => openProfile());
  elements.profileClose.addEventListener('click', () => {
    pendingRoomJoin = '';
    elements.profileDialog.close();
  });
  elements.profileDialog.addEventListener('cancel', () => {
    pendingRoomJoin = '';
  });
  elements.profileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!elements.profileForm.reportValidity()) return;
    const nextName = saveProfileName(elements.profileName.value);
    if (!nextName) return;
    localName = nextName;
    elements.profileDialog.close();
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
      updateTimerDisplay(elements, state);
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
    for (const player of activePlayers(state)) {
      if (
        player.id !== localPlayerId &&
        now - player.lastSeenAt >= PRESENCE_TIMEOUT_MS
      )
        dispatchAction(makeAction('leave', { playerId: player.id }));
    }
    network.pingPeers(now);
    network.broadcastDirectory();
    render();
  }, network.heartbeatIntervalMs);

  function announcePresence() {
    if (!localPlayerId) return;
    const player = state.players.find((item) => item.id === localPlayerId);
    if (player) {
      player.lastSeenAt = Date.now();
      player.pageHidden = document.visibilityState !== 'visible';
    }
    network.relay({
      type: 'presence',
      participant: identity(),
      pageHidden: document.visibilityState !== 'visible',
      sentAt: Date.now(),
    });
    network.sendRegistryDiscover();
  }

  const handleResume = () => {
    if (document.visibilityState !== 'visible' || !localPlayerId) return;
    announceJoin();
    announcePresence();
    network.connectToRegistry();
    network.ensureMesh(activePlayers(state).map((player) => player.peerId));
  };
  const handleVisibilityChange = () => {
    if (!localPlayerId) return;
    announcePresence();
    handleResume();
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pageshow', handleResume);
  window.addEventListener('online', handleResume);

  const handleCheatCode = createDebugCheatCodeHandler({
    enable: enableDebugApi,
    showToast,
  });
  document.addEventListener('keydown', handleCheatCode);
  elements.copyRoomButton.addEventListener('click', copyInvite);
  elements.leaveRoomButton.addEventListener('click', returnHome);

  const savedName = savedProfileName();
  if (savedName) saveProfileName(savedName);
  elements.createName.value = savedName;
  elements.joinName.value = savedName;
  if (sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') enableDebugApi();
  const roomFromUrl = roomFromLocation();
  if (roomFromUrl) {
    elements.roomInput.value = roomFromUrl;
    if (savedName) startRoom(savedName, roomFromUrl);
    else openProfile(roomFromUrl);
  }

  disposeCurrentRoom = () => {
    document.removeEventListener('keydown', handleCheatCode);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pageshow', handleResume);
    window.removeEventListener('online', handleResume);
    window.clearInterval(timerInterval);
    window.clearInterval(presenceInterval);
    window.clearTimeout(toastTimer);
    network.destroy();
    delete window.scrumPoker;
  };
};

document.addEventListener('astro:page-load', initializeScrumPoker);
document.addEventListener('astro:before-swap', () => {
  disposeCurrentRoom?.();
  disposeCurrentRoom = undefined;
});
initializeScrumPoker();
