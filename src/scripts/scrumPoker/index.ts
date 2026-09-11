import { createRoomActions } from './actions';
import { DEBUG_SESSION_KEY } from './constants';
import {
  createDebugCheatCodeHandler,
  incrementDebugCounter,
  enableDebugApi as installDebugApi,
} from './debug';
import { queryScrumPokerElements } from './dom';
import {
  createScrumPokerNetwork,
  type ParticipantIdentity,
  type ScrumPokerNetwork,
} from './network';
import { createPresenceController } from './presence';
import {
  setConnection as renderConnection,
  showError as renderError,
  renderScrumPoker,
  showToast as renderToast,
} from './render';
import { createRoomController } from './roomController';
import { freshRoomState, type RoomState } from './state';
import { createRoomTimers } from './timers';

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
  let toastTimer: ReturnType<typeof setInterval> | undefined;
  let previouslyRevealed = false;
  let focusResultAfterReveal = false;
  let pendingRoomJoin = '';
  let lastJoinAnnouncedAt = 0;
  let revealAnimationUntil = 0;
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

  const render = () => {
    incrementDebugCounter('renderCalls');
    const result = renderScrumPoker({
      elements,
      state,
      localPlayerId,
      localVote,
      previouslyRevealed,
      revealAnimationActive: Date.now() < revealAnimationUntil,
      focusResultAfterReveal,
      hasOpenConnection: (player) => network.hasOpenConnection(player),
    });
    previouslyRevealed = result.previouslyRevealed;
    focusResultAfterReveal = result.focusResultAfterReveal;
  };

  const actions = createRoomActions({
    elements,
    getCurrentRoom: () => currentRoom,
    getLastJoinAnnouncedAt: () => lastJoinAnnouncedAt,
    getLocalName: () => localName,
    getLocalPeerId: () => localPeerId,
    getLocalPlayerId: () => localPlayerId,
    getLocalVote: () => localVote,
    getLogicalClock: () => logicalClock,
    getNetwork: () => network,
    getState: () => state,
    render,
    setLastJoinAnnouncedAt: (value) => {
      lastJoinAnnouncedAt = value;
    },
    setFocusResultAfterReveal: (value) => {
      focusResultAfterReveal = value;
    },
    setLocalVote: (value) => {
      localVote = value;
    },
    setLogicalClock: (value) => {
      logicalClock = value;
    },
    setRevealAnimationUntil: (value) => {
      revealAnimationUntil = value;
    },
    setState,
  });

  const presence = createPresenceController({
    actions,
    getIdentity: identity,
    getLocalPlayerId: () => localPlayerId,
    getNetwork: () => network,
    getState: () => state,
    render,
  });

  const timers = createRoomTimers({
    actions,
    elements,
    getLocalPlayerId: () => localPlayerId,
    getState: () => state,
  });

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
    onAction: actions.processAction,
    onPresence: presence.processPresence,
    announceJoin: actions.announceJoin,
    restoreLocalVote: actions.restoreLocalVote,
    render,
    setConnection,
    showToast,
    showError,
  });

  const roomController = createRoomController({
    actions,
    elements,
    getCurrentRoom: () => currentRoom,
    getLocalName: () => localName,
    getLocalPlayerId: () => localPlayerId,
    getNetwork: () => network,
    getPendingRoomJoin: () => pendingRoomJoin,
    presence,
    render,
    setCurrentRoom: (value) => {
      currentRoom = value;
    },
    setFocusResultAfterReveal: (value) => {
      focusResultAfterReveal = value;
    },
    setLastJoinAnnouncedAt: (value) => {
      lastJoinAnnouncedAt = value;
    },
    setLocalName: (value) => {
      localName = value;
    },
    setLocalPeerId: (value) => {
      localPeerId = value;
    },
    setLocalPlayerId: (value) => {
      localPlayerId = value;
    },
    setLocalVote: (value) => {
      localVote = value;
    },
    setLogicalClock: (value) => {
      logicalClock = value;
    },
    setPendingRoomJoin: (value) => {
      pendingRoomJoin = value;
    },
    setPreviouslyRevealed: (value) => {
      previouslyRevealed = value;
    },
    setRevealAnimationUntil: (value) => {
      revealAnimationUntil = value;
    },
    setState,
    showToast,
    timers,
  });

  const enableDebugApi = () => {
    installDebugApi({
      getState: () => state,
      getCurrentRoom: () => currentRoom,
      getLocalPlayerId: () => localPlayerId,
      getLocalVote: () => localVote,
      getDiagnostics: network.diagnostics,
      getNetworkConfig: network.getNetworkConfig,
      getConnectionMode: network.getConnectionMode,
      hasOpenConnection: network.hasOpenConnection,
    });
  };

  actions.bindVotingControls();
  roomController.bindRoomControls();
  timers.bindTimerControls();
  presence.bindPresenceHandlers();

  const handleCheatCode = createDebugCheatCodeHandler({
    enable: enableDebugApi,
    showToast,
  });
  document.addEventListener('keydown', handleCheatCode);

  if (sessionStorage.getItem(DEBUG_SESSION_KEY) === 'true') enableDebugApi();
  roomController.initializeFromLocation();

  disposeCurrentRoom = () => {
    document.removeEventListener('keydown', handleCheatCode);
    presence.disposePresenceHandlers();
    timers.stopRoomTimers();
    globalThis.clearTimeout(toastTimer);
    network.destroy();
    delete globalThis.scrumPoker;
  };
};

document.addEventListener('astro:page-load', initializeScrumPoker);
document.addEventListener('astro:before-swap', () => {
  disposeCurrentRoom?.();
  disposeCurrentRoom = undefined;
});
initializeScrumPoker();
