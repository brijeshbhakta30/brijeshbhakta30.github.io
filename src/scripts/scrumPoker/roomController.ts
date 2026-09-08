import type { RoomActions } from './actions';
import type { ScrumPokerElements } from './dom';
import type { ScrumPokerNetwork } from './network';
import type { PresenceController } from './presence';
import type { RoomTimers } from './timers';

import {
  freshRoomState,
  type RoomState,
} from './state';
import {
  inviteUrl,
  makeRoomCode,
  normalizeRoomCode,
  roomFromLocation,
  roomIdentity,
  savedLocalProfileName,
  savedProfileName,
  saveProfileName as storeProfileName,
  updateRoomUrl,
} from './storage';

export type RoomController = {
  bindRoomControls: () => void;
  copyInvite: () => Promise<void>;
  enterRoom: () => void;
  initializeFromLocation: () => void;
  openProfile: (roomCode?: string) => void;
  returnHome: () => void;
  saveProfileName: (name: string) => string;
  startRoom: (name: string, roomCode: string) => void;
};

type RoomControllerContext = {
  actions: RoomActions;
  elements: ScrumPokerElements;
  getCurrentRoom: () => string;
  getLocalName: () => string;
  getLocalPlayerId: () => string;
  getNetwork: () => ScrumPokerNetwork;
  getPendingRoomJoin: () => string;
  presence: PresenceController;
  render: () => void;
  setCurrentRoom: (value: string) => void;
  setFocusResultAfterReveal: (value: boolean) => void;
  setLastJoinAnnouncedAt: (value: number) => void;
  setLocalName: (value: string) => void;
  setLocalPeerId: (value: string) => void;
  setLocalPlayerId: (value: string) => void;
  setLocalVote: (value: string | null) => void;
  setLogicalClock: (value: number) => void;
  setPendingRoomJoin: (value: string) => void;
  setPreviouslyRevealed: (value: boolean) => void;
  setRevealAnimationUntil: (value: number) => void;
  setState: (state: RoomState) => void;
  showToast: (message: string) => void;
  timers: RoomTimers;
};

export const createRoomController = (
  context: RoomControllerContext,
): RoomController => {
  const {
    actions,
    elements,
    getCurrentRoom,
    getLocalName,
    getLocalPlayerId,
    getNetwork,
    getPendingRoomJoin,
    presence,
    render,
    setCurrentRoom,
    setFocusResultAfterReveal,
    setLastJoinAnnouncedAt,
    setLocalName,
    setLocalPeerId,
    setLocalPlayerId,
    setLocalVote,
    setLogicalClock,
    setPendingRoomJoin,
    setPreviouslyRevealed,
    setRevealAnimationUntil,
    setState,
    showToast,
    timers,
  } = context;

  const saveProfileName = (name: string) => {
    const nextName = storeProfileName(name);
    if (!nextName) return '';
    elements.createName.value = nextName;
    elements.joinName.value = nextName;
    elements.profileName.value = nextName;
    return nextName;
  };

  const enterRoom = () => {
    elements.setup.classList.add('hidden');
    elements.roomView.classList.remove('hidden');
    elements.errorBox.classList.add('hidden');
    elements.roomLabel.textContent = getCurrentRoom();
    updateRoomUrl(getCurrentRoom());
    saveProfileName(getLocalName());
    render();
  };

  const openProfile = (roomCode = '') => {
    setPendingRoomJoin(roomCode);
    elements.profileName.value = getLocalName() || savedLocalProfileName();
    elements.profileDialog.showModal();
    requestAnimationFrame(() => elements.profileName.focus());
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl(getCurrentRoom()));
      showToast('Invite link copied');
    } catch {
      showToast(`Room code: ${getCurrentRoom()}`);
    }
  };

  const resetRoomState = () => {
    setState(freshRoomState());
    setCurrentRoom('');
    setLocalPlayerId('');
    setLocalPeerId('');
    setLocalVote(null);
    setPreviouslyRevealed(false);
    setFocusResultAfterReveal(false);
    setRevealAnimationUntil(0);
  };

  const returnHome = () => {
    if (getLocalPlayerId())
      actions.dispatchAction(
        actions.makeAction('leave', { playerId: getLocalPlayerId() }),
      );
    timers.stopRoomTimers();
    presence.stopPresenceHeartbeat();
    getNetwork().destroy();
    resetRoomState();
    elements.setup.classList.remove('hidden');
    elements.roomView.classList.add('hidden');
    updateRoomUrl();
  };

  const startRoom = (name: string, roomCode: string) => {
    timers.stopRoomTimers();
    presence.stopPresenceHeartbeat();
    getNetwork().destroy();
    setLocalName(saveProfileName(name));
    setCurrentRoom(normalizeRoomCode(roomCode) || makeRoomCode());
    setLocalPlayerId(roomIdentity(getCurrentRoom()));
    setState(freshRoomState());
    setLogicalClock(0);
    setLastJoinAnnouncedAt(0);
    setRevealAnimationUntil(0);
    setLocalVote(null);
    timers.startRoomTimers();
    presence.startPresenceHeartbeat();
    enterRoom();
    getNetwork().start();
  };

  const bindRoomControls = () => {
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
    elements.profileButton.addEventListener('click', () => openProfile());
    elements.profileClose.addEventListener('click', () => {
      setPendingRoomJoin('');
      elements.profileDialog.close();
    });
    elements.profileDialog.addEventListener('cancel', () => {
      setPendingRoomJoin('');
    });
    elements.profileForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!elements.profileForm.reportValidity()) return;
      const nextName = saveProfileName(elements.profileName.value);
      if (!nextName) return;
      setLocalName(nextName);
      elements.profileDialog.close();
      if (getLocalPlayerId())
        actions.dispatchAction(
          actions.makeAction('rename', {
            playerId: getLocalPlayerId(),
            name: nextName,
          }),
        );
      const roomCode = getPendingRoomJoin();
      setPendingRoomJoin('');
      if (roomCode) startRoom(nextName, roomCode);
      else showToast('Profile saved');
    });
    elements.copyRoomButton.addEventListener('click', copyInvite);
    elements.leaveRoomButton.addEventListener('click', returnHome);
  };

  const initializeFromLocation = () => {
    const savedName = savedProfileName();
    if (savedName) saveProfileName(savedName);
    elements.createName.value = savedName;
    elements.joinName.value = savedName;
    const roomFromUrl = roomFromLocation();
    if (roomFromUrl) {
      elements.roomInput.value = roomFromUrl;
      if (savedName) startRoom(savedName, roomFromUrl);
      else openProfile(roomFromUrl);
    }
  };

  return {
    bindRoomControls,
    copyInvite,
    enterRoom,
    initializeFromLocation,
    openProfile,
    returnHome,
    saveProfileName,
    startRoom,
  };
};
