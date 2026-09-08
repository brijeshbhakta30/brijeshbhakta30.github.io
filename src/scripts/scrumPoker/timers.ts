import type { RoomActions } from './actions';
import type { ScrumPokerElements } from './dom';

import { updateTimerDisplay } from './render';
import {
  DEFAULT_TIMER_SECONDS,
  normalizeTimerDuration,
  type RoomState,
} from './state';

export type RoomTimers = {
  bindTimerControls: () => void;
  configureTimer: (start: boolean) => void;
  startRoomTimers: () => void;
  stopActiveTimer: () => void;
  stopRoomTimers: () => void;
  timerSettings: () => { duration: number; autoReveal: boolean };
};

type RoomTimersContext = {
  actions: RoomActions;
  elements: ScrumPokerElements;
  getLocalPlayerId: () => string;
  getState: () => RoomState;
};

export const createRoomTimers = ({
  actions,
  elements,
  getLocalPlayerId,
  getState,
}: RoomTimersContext): RoomTimers => {
  let timerInterval: ReturnType<typeof setInterval> | undefined;

  const timerSettings = () => ({
    duration: normalizeTimerDuration(
      Number(elements.timerInput.value) || DEFAULT_TIMER_SECONDS,
    ),
    autoReveal: elements.autoRevealInput.checked,
  });

  const stopRoomTimers = () => {
    globalThis.clearInterval(timerInterval);
    timerInterval = undefined;
  };

  const configureTimer = (start: boolean) => {
    const state = getState();
    if (state.revealed) return;
    const settings = timerSettings();
    actions.dispatchAction(
      actions.makeAction('timer', {
        roundId: state.roundId,
        duration: settings.duration,
        autoReveal: settings.autoReveal,
        endsAt: start
          ? Date.now() + settings.duration * 1000
          : state.timerEndsAt,
      }),
    );
  };

  const stopActiveTimer = () => {
    const state = getState();
    if (state.revealed) return;
    const settings = timerSettings();
    actions.dispatchAction(
      actions.makeAction('timer', {
        roundId: state.roundId,
        duration: settings.duration,
        autoReveal: settings.autoReveal,
        endsAt: null,
      }),
    );
  };

  const startRoomTimers = () => {
    stopRoomTimers();
    timerInterval = globalThis.setInterval(() => {
      if (!getLocalPlayerId()) return;
      const state = getState();
      if (state.timerEndsAt === null || state.timerEndsAt > Date.now()) {
        updateTimerDisplay(elements, state);
        return;
      }
      if (state.autoReveal)
        actions.dispatchAction(
          actions.makeAction('reveal', { roundId: state.roundId }),
        );
      else {
        const settings = timerSettings();
        actions.dispatchAction(
          actions.makeAction('timer', {
            roundId: state.roundId,
            duration: settings.duration,
            autoReveal: false,
            endsAt: null,
          }),
        );
      }
    }, 250);
  };

  const bindTimerControls = () => {
    elements.timerInput.addEventListener('change', () => configureTimer(false));
    elements.autoRevealInput.addEventListener('change', () =>
      configureTimer(false),
    );
    elements.startTimerButton.addEventListener('click', () =>
      configureTimer(true),
    );
    elements.stopTimerButton.addEventListener('click', stopActiveTimer);
  };

  return {
    bindTimerControls,
    configureTimer,
    startRoomTimers,
    stopActiveTimer,
    stopRoomTimers,
    timerSettings,
  };
};
