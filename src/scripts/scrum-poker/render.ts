import {
  activePlayers,
  presenceFor,
  votingStatusFor,
  votingStatusLabel,
  type Player,
  type PresenceState,
  type RoomState,
} from './state';
import { CARD_ORDER } from './constants';
import type { ScrumPokerElements } from './dom';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export const showToast = (
  elements: ScrumPokerElements,
  message: string,
  previousTimer: number | undefined,
) => {
  elements.toast.textContent = message;
  elements.toast.classList.remove('translate-y-3', 'opacity-0');
  window.clearTimeout(previousTimer);
  return window.setTimeout(
    () => elements.toast.classList.add('translate-y-3', 'opacity-0'),
    2600,
  );
};

export const showError = (elements: ScrumPokerElements, message: string) => {
  elements.errorBox.textContent = message;
  elements.errorBox.classList.remove('hidden');
  elements.setup.classList.remove('hidden');
  elements.roomView.classList.add('hidden');
};

export const setConnection = (
  elements: ScrumPokerElements,
  label: string,
  status: ConnectionStatus,
) => {
  elements.connectionLabel.lastChild!.textContent = ` ${label}`;
  elements.connectionDot.className = `size-2 rounded-full ${status === 'connected' ? 'bg-accent' : status === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-red-500'}`;
};

export const updateTimerDisplay = (
  elements: ScrumPokerElements,
  state: RoomState,
) => {
  const secondsLeft =
    state.timerEndsAt === null
      ? state.timerDuration
      : Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
  elements.timerDisplay.textContent = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const running = state.timerEndsAt !== null;
  elements.timerDisplay.classList.toggle('is-running', running);
  elements.timerDisplay.classList.toggle(
    'is-urgent',
    running && secondsLeft <= 10,
  );
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

const numericVotes = (players: Player[], state: RoomState) =>
  players
    .map((player) =>
      player.voteRoundId === state.roundId ? player.vote : null,
    )
    .filter(
      (vote): vote is string => vote !== null && Number.isFinite(Number(vote)),
    )
    .map(Number);

const renderStatistics = (
  elements: ScrumPokerElements,
  state: RoomState,
  players: Player[],
  animateReveal: boolean,
) => {
  elements.statistics.classList.toggle('hidden', !state.revealed);
  elements.statistics.classList.toggle('is-entering', animateReveal);
  if (!state.revealed) return;
  const numbers = numericVotes(players, state);
  elements.statLow.textContent = numbers.length
    ? String(Math.min(...numbers))
    : '—';
  elements.statHigh.textContent = numbers.length
    ? String(Math.max(...numbers))
    : '—';
  const votes = players
    .map((player) =>
      player.voteRoundId === state.roundId ? player.vote : null,
    )
    .filter((vote): vote is string => vote !== null);
  const consensus = votes.length > 1 && new Set(votes).size === 1;
  elements.consensusLabel.textContent = consensus
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
  elements.statMostVoted.textContent =
    orderedVotes
      .filter((vote) => counts.get(vote) === highestCount)
      .join(' / ') || '—';
  elements.distribution.innerHTML = orderedVotes
    .map((card) => {
      const count = counts.get(card)!;
      const width = votes.length ? (count / votes.length) * 100 : 0;
      return `<div class="grid grid-cols-[24px_1fr_20px] items-center gap-2 text-sm"><span class="truncate font-mono" title="${escapeHtml(card)}">${escapeHtml(card)}</span><span class="h-1 bg-rule"><span class="block h-full bg-accent" style="width:${width}%"></span></span><span class="text-right text-muted">${count}</span></div>`;
    })
    .join('');
};

export const renderScrumPoker = ({
  elements,
  state,
  localPlayerId,
  localVote,
  previouslyRevealed,
  focusResultAfterReveal,
  hasOpenConnection,
}: {
  elements: ScrumPokerElements;
  state: RoomState;
  localPlayerId: string;
  localVote: string | null;
  previouslyRevealed: boolean;
  focusResultAfterReveal: boolean;
  hasOpenConnection: (player: Player) => boolean;
}) => {
  const players = activePlayers(state);
  const voted = players.filter(
    (player) => player.voteRoundId === state.roundId && player.hasVoted,
  ).length;
  const total = players.length;
  const animateReveal = state.revealed && !previouslyRevealed;
  const playerPresence = (player: Player): PresenceState =>
    presenceFor(player, Date.now(), hasOpenConnection(player));
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
  const displayedPlayers = state.revealed
    ? [...players].sort(compareRevealedPlayers)
    : players;

  elements.roundLabel.textContent = `Round ${state.round}`;
  elements.roundStatus.textContent = state.revealed
    ? 'The cards are on the table'
    : voted === total && total > 0
      ? 'Everyone has voted'
      : `${voted} of ${total} voted`;
  elements.timerInput.value = String(state.timerDuration);
  elements.autoRevealInput.checked = state.autoReveal;
  elements.allowVoteChangesInput.checked = state.allowVoteChangesAfterReveal;
  elements.startTimerButton.textContent =
    state.timerEndsAt === null ? 'Start timer' : 'Restart timer';
  elements.stopTimerButton.classList.toggle(
    'hidden',
    state.timerEndsAt === null,
  );
  elements.revealButton.disabled = state.revealed || voted === 0;
  elements.revealButton.textContent = state.revealed
    ? 'Votes revealed'
    : 'Reveal votes';
  elements.playersGrid.classList.toggle('is-revealed', state.revealed);
  elements.playersGrid.innerHTML = displayedPlayers
    .map((player, index) => {
      const status = votingStatusFor(player, state, playerPresence(player));
      const hasVoted = player.voteRoundId === state.roundId && player.hasVoted;
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
  elements.participantList.innerHTML = players
    .map((player) => {
      const status = votingStatusFor(player, state, playerPresence(player));
      return `<li class="flex items-center justify-between gap-3"><span class="min-w-0 truncate">${escapeHtml(player.name)}${player.id === localPlayerId ? ' (you)' : ''}</span><span class="shrink-0 font-mono text-[0.65rem] tracking-[0.04em] text-muted uppercase">${votingStatusLabel(status)}</span></li>`;
    })
    .join('');
  for (const button of elements.cardButtons) {
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.card === localVote),
    );
    button.disabled = state.revealed && !state.allowVoteChangesAfterReveal;
  }
  elements.cardHint.textContent = state.revealed
    ? state.allowVoteChangesAfterReveal
      ? 'Choose again to update'
      : 'Voting is locked'
    : 'Tap again to clear';
  renderStatistics(elements, state, players, animateReveal);
  updateTimerDisplay(elements, state);

  let nextFocusResultAfterReveal = focusResultAfterReveal;
  if (animateReveal && focusResultAfterReveal) {
    nextFocusResultAfterReveal = false;
    requestAnimationFrame(() => {
      const bounds = elements.statistics.getBoundingClientRect();
      if (bounds.top >= 0 && bounds.bottom <= window.innerHeight) return;
      elements.statistics.scrollIntoView({
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
        block: 'center',
      });
    });
  }

  return {
    previouslyRevealed: state.revealed,
    focusResultAfterReveal: nextFocusResultAfterReveal,
  };
};
