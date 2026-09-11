import type { ScrumPokerElements } from './dom';
import type { ScrumPokerNetwork } from './network';

import { leadingThrottle } from './controls';
import { incrementDebugCounter } from './debug';
import {
  applyRoomAction,
  makeRandomId,
  type RoomAction,
  type RoomState,
} from './state';
import { loadLocalVote, persistLocalVote as storeLocalVote } from './storage';

type RoomActionByType = {
  [Action in RoomAction as Action['type']]: Action;
};

export type MakeRoomAction = <T extends keyof RoomActionByType>(
  type: T,
  payload: RoomActionByType[T]['payload'],
) => RoomActionByType[T];

export type RoomActions = {
  announceJoin: () => void;
  bindVotingControls: () => void;
  dispatchAction: (action: RoomAction) => void;
  makeAction: MakeRoomAction;
  persistLocalVote: () => void;
  processAction: (action: RoomAction, shouldRelay: boolean) => void;
  publishLocalVote: () => boolean;
  restoreLocalVote: () => void;
};

type RoomActionsContext = {
  elements: ScrumPokerElements;
  getCurrentRoom: () => string;
  getLastJoinAnnouncedAt: () => number;
  getLocalName: () => string;
  getLocalPeerId: () => string;
  getLocalPlayerId: () => string;
  getLocalVote: () => string | null;
  getLogicalClock: () => number;
  getNetwork: () => ScrumPokerNetwork;
  getState: () => RoomState;
  render: () => void;
  setLastJoinAnnouncedAt: (value: number) => void;
  setFocusResultAfterReveal: (value: boolean) => void;
  setLocalVote: (value: string | null) => void;
  setLogicalClock: (value: number) => void;
  setRevealAnimationUntil: (value: number) => void;
  setState: (state: RoomState) => void;
};

const REVEAL_ANIMATION_WINDOW_MS = 900;

export const createRoomActions = (
  context: RoomActionsContext,
): RoomActions => {
  const { elements } = context;

  function makeAction<T extends keyof RoomActionByType>(
  type: T,
  payload: RoomActionByType[T]['payload'],
): RoomActionByType[T] {
    const logicalClock =
      Math.max(context.getLogicalClock(), context.getState().version) + 1;
    context.setLogicalClock(logicalClock);

    return {
      id: `${String(logicalClock).padStart(10, '0')}-${context.getLocalPlayerId()}-${makeRandomId()}`,
      actorId: context.getLocalPlayerId(),
      counter: logicalClock,
      sentAt: Date.now(),
      type,
      payload,
    } as RoomActionByType[T];
  }

  function persistLocalVote() {
    storeLocalVote(
      context.getCurrentRoom(),
      context.getState().roundId,
      context.getLocalVote(),
    );
  }

  function dispatchAction(action: RoomAction) {
    processAction(action, true);
  }

  function publishLocalVote() {
    const state = context.getState();
    const player = state.players.find(
      (item) => item.id === context.getLocalPlayerId(),
    );
    if (!player || player.voteRoundId !== state.roundId || !player.hasVoted)
      return false;
    dispatchAction(
      makeAction('vote', {
        playerId: context.getLocalPlayerId(),
        roundId: state.roundId,
        hasVoted: true,
        vote: context.getLocalVote(),
      }),
    );
    return true;
  }

  function processAction(action: RoomAction, shouldRelay: boolean) {
    context.setLogicalClock(Math.max(context.getLogicalClock(), action.counter));
    const state = context.getState();
    const wasRevealed = state.revealed;
    const previousRoundId = state.roundId;
    const nextState = applyRoomAction(state, action);
    context.setState(nextState);
    const revealStarted = !wasRevealed && nextState.revealed;
    if (revealStarted) {
      context.setRevealAnimationUntil(Date.now() + REVEAL_ANIMATION_WINDOW_MS);
    }
    if (previousRoundId !== nextState.roundId) {
      context.setLocalVote(null);
      context.setRevealAnimationUntil(0);
      persistLocalVote();
    }
    if (shouldRelay) {
      if (action.type === 'vote') incrementDebugCounter('voteActionsSent');
      if (action.type === 'reveal')
        incrementDebugCounter('revealActionsGenerated');
      context.getNetwork().relay({ type: 'action', action });
    }
    if (revealStarted && publishLocalVote()) return;
    context.render();
  }

  function announceJoin() {
    if (!context.getLocalPlayerId() || !context.getLocalPeerId()) return;
    const now = Date.now();
    if (now - context.getLastJoinAnnouncedAt() < 1000) return;
    context.setLastJoinAnnouncedAt(now);
    dispatchAction(
      makeAction('join', {
        playerId: context.getLocalPlayerId(),
        peerId: context.getLocalPeerId(),
        name: context.getLocalName(),
        now,
      }),
    );
  }

  function restoreLocalVote() {
    if (context.getLocalVote() !== null) return;
    const state = context.getState();
    const savedVote = loadLocalVote(context.getCurrentRoom(), state.roundId);
    if (!savedVote) return;
    context.setLocalVote(savedVote);
    dispatchAction(
      makeAction('vote', {
        playerId: context.getLocalPlayerId(),
        roundId: state.roundId,
        hasVoted: true,
        vote: state.revealed ? savedVote : null,
      }),
    );
  }

  function bindVotingControls() {
    for (const button of elements.cardButtons) {
      button.addEventListener('click', () => {
        const state = context.getState();
        if (state.revealed && !state.allowVoteChangesAfterReveal) return;
        const localVote =
          // eslint-disable-next-line sonarjs/different-types-comparison
          context.getLocalVote() === button.dataset.card
            ? null
            : (button.dataset.card ?? null);
        context.setLocalVote(localVote);
        persistLocalVote();
        dispatchAction(
          makeAction('vote', {
            playerId: context.getLocalPlayerId(),
            roundId: state.roundId,
            hasVoted: localVote !== null,
            vote: state.revealed ? localVote : null,
          }),
        );
      });
    }
    elements.revealButton.addEventListener(
      'click',
      leadingThrottle(() => {
        if (context.getState().revealed) return;
        context.setFocusResultAfterReveal(true);
        dispatchAction(
          makeAction('reveal', { roundId: context.getState().roundId }),
        );
      }),
    );
    elements.resetButton.addEventListener(
      'click',
      leadingThrottle(() => {
        dispatchAction(
          makeAction('new-round', { baseRoundId: context.getState().roundId }),
        );
      }),
    );
    elements.allowVoteChangesInput.addEventListener('change', () => {
      dispatchAction(
        makeAction('voting-config', {
          allowVoteChangesAfterReveal: elements.allowVoteChangesInput.checked,
        }),
      );
    });
  }

  return {
    announceJoin,
    bindVotingControls,
    dispatchAction,
    makeAction,
    persistLocalVote,
    processAction,
    publishLocalVote,
    restoreLocalVote,
  };
};
