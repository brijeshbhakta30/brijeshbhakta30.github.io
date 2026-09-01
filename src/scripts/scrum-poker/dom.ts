export type ScrumPokerElements = {
  root: HTMLElement;
  setup: HTMLElement;
  roomView: HTMLElement;
  createForm: HTMLFormElement;
  joinForm: HTMLFormElement;
  createName: HTMLInputElement;
  createRoomInput: HTMLInputElement;
  joinName: HTMLInputElement;
  roomInput: HTMLInputElement;
  errorBox: HTMLElement;
  playersGrid: HTMLElement;
  participantList: HTMLOListElement;
  connectionLabel: HTMLElement;
  connectionDot: HTMLElement;
  roundLabel: HTMLElement;
  roundStatus: HTMLElement;
  roomLabel: HTMLElement;
  revealButton: HTMLButtonElement;
  resetButton: HTMLButtonElement;
  timerDisplay: HTMLElement;
  timerInput: HTMLInputElement;
  autoRevealInput: HTMLInputElement;
  allowVoteChangesInput: HTMLInputElement;
  startTimerButton: HTMLButtonElement;
  stopTimerButton: HTMLButtonElement;
  cardHint: HTMLElement;
  statistics: HTMLElement;
  statMostVoted: HTMLElement;
  statLow: HTMLElement;
  statHigh: HTMLElement;
  consensusLabel: HTMLElement;
  distribution: HTMLElement;
  profileButton: HTMLButtonElement;
  profileDialog: HTMLDialogElement;
  profileForm: HTMLFormElement;
  profileName: HTMLInputElement;
  profileClose: HTMLButtonElement;
  cardButtons: HTMLButtonElement[];
  toast: HTMLElement;
  copyRoomButton: HTMLButtonElement;
  leaveRoomButton: HTMLButtonElement;
};

export const queryScrumPokerElements = () => {
  const root = document.querySelector<HTMLElement>('[data-scrum-tool]');
  if (!root || root.dataset.initialized === 'true') return null;
  root.dataset.initialized = 'true';

  const find = <T extends HTMLElement>(selector: string) =>
    root.querySelector<T>(selector)!;

  return {
    root,
    setup: find<HTMLElement>('#poker-setup'),
    roomView: find<HTMLElement>('#poker-room'),
    createForm: find<HTMLFormElement>('#create-room-form'),
    joinForm: find<HTMLFormElement>('#join-room-form'),
    createName: find<HTMLInputElement>('#create-name'),
    createRoomInput: find<HTMLInputElement>('#create-room-code'),
    joinName: find<HTMLInputElement>('#join-name'),
    roomInput: find<HTMLInputElement>('#room-code'),
    errorBox: find<HTMLElement>('#connection-error'),
    playersGrid: find<HTMLElement>('#players-grid'),
    participantList: find<HTMLOListElement>('#participant-list'),
    connectionLabel: find<HTMLElement>('#connection-label'),
    connectionDot: find<HTMLElement>('#connection-dot'),
    roundLabel: find<HTMLElement>('#round-label'),
    roundStatus: find<HTMLElement>('#round-status'),
    roomLabel: find<HTMLElement>('#room-label'),
    revealButton: find<HTMLButtonElement>('#reveal-votes'),
    resetButton: find<HTMLButtonElement>('#reset-round'),
    timerDisplay: find<HTMLElement>('#timer-display'),
    timerInput: find<HTMLInputElement>('#timer-duration'),
    autoRevealInput: find<HTMLInputElement>('#timer-auto-reveal'),
    allowVoteChangesInput: find<HTMLInputElement>('#allow-vote-changes'),
    startTimerButton: find<HTMLButtonElement>('#start-timer'),
    stopTimerButton: find<HTMLButtonElement>('#stop-timer'),
    cardHint: find<HTMLElement>('#card-hint'),
    statistics: find<HTMLElement>('#statistics'),
    statMostVoted: find<HTMLElement>('#stat-most-voted'),
    statLow: find<HTMLElement>('#stat-low'),
    statHigh: find<HTMLElement>('#stat-high'),
    consensusLabel: find<HTMLElement>('#consensus-label'),
    distribution: find<HTMLElement>('#distribution'),
    profileButton: find<HTMLButtonElement>('#profile-button'),
    profileDialog: find<HTMLDialogElement>('#profile-dialog'),
    profileForm: find<HTMLFormElement>('#profile-form'),
    profileName: find<HTMLInputElement>('#profile-name'),
    profileClose: find<HTMLButtonElement>('#profile-close'),
    cardButtons: [...root.querySelectorAll<HTMLButtonElement>('[data-card]')],
    toast: find<HTMLElement>('#poker-toast'),
    copyRoomButton: find<HTMLButtonElement>('#copy-room'),
    leaveRoomButton: find<HTMLButtonElement>('#leave-room'),
  } satisfies ScrumPokerElements;
};
