import {
  DEFAULT_ENTRIES,
  parseEntries,
  removeEntryAt,
  secureRandomInt,
  serializeEntries,
  shuffleEntries,
  sortEntries,
  type WheelState,
} from './state';

const STORAGE_KEY = 'wheel-of-names:v1';
const TAU = Math.PI * 2;
const POINTER_ANGLE = 0;
const IDLE_ROTATION_RADIANS_PER_SECOND = 0.18;
const SPIN_DURATION_MS = 10_000;
const ACCELERATION_PHASE = 0.24;
const FAST_PHASE = 0.18;
const SPIN_TURNS = 18;
const REDUCED_MOTION_SPIN_TURNS = 2;
const WHEEL_COLORS = [
  { fill: '#2f80a7', text: '#ffffff' },
  { fill: '#d44d5c', text: '#ffffff' },
  { fill: '#f2b84b', text: '#221f1a' },
  { fill: '#188977', text: '#ffffff' },
  { fill: '#7557a8', text: '#ffffff' },
  { fill: '#e36f38', text: '#ffffff' },
  { fill: '#4f9567', text: '#ffffff' },
  { fill: '#f0dc5e', text: '#221f1a' },
];

type Elements = ReturnType<typeof queryElements>;

let disposeCurrentWheel: (() => void) | undefined;

function queryElements(root: HTMLElement) {
  const required = <T extends Element>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element)
      throw new Error(`Wheel is missing required element: ${selector}`);
    return element;
  };

  return {
    canvas: required<HTMLCanvasElement>('[data-wheel-canvas]'),
    entries: required<HTMLTextAreaElement>('[data-wheel-entries]'),
    count: required<HTMLElement>('[data-entry-count]'),
    emptyMessage: required<HTMLElement>('[data-empty-message]'),
    spinButton: required<HTMLButtonElement>('[data-spin]'),
    shuffleButton: required<HTMLButtonElement>('[data-shuffle]'),
    sortButton: required<HTMLButtonElement>('[data-sort]'),
    clearButton: required<HTMLButtonElement>('[data-clear]'),
    removeWinner: required<HTMLInputElement>('[data-remove-winner]'),
    dialog: required<HTMLDialogElement>('[data-winner-dialog]'),
    winner: required<HTMLElement>('[data-winner-name]'),
    closeDialog: required<HTMLButtonElement>('[data-close-winner]'),
    removeDialogWinner: required<HTMLButtonElement>(
      '[data-remove-dialog-winner]',
    ),
  };
}

function loadState(): WheelState {
  try {
    const stored = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '',
    ) as Partial<WheelState>;
    const entries = Array.isArray(stored.entries)
      ? stored.entries.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : DEFAULT_ENTRIES;
    return {
      entries,
      removeWinner: stored.removeWinner === true,
    };
  } catch {
    return {
      entries: DEFAULT_ENTRIES,
      removeWinner: false,
    };
  }
}

function saveState(state: WheelState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The tool still works when storage is unavailable.
  }
}

function insertParsedPaste(
  textarea: HTMLTextAreaElement,
  pastedText: string,
): { caret: number; entries: string[] } {
  const pastedEntries = parseEntries(pastedText);
  const pastedValue = serializeEntries(pastedEntries);
  const selectionStart = textarea.selectionStart;
  const selectionEnd = textarea.selectionEnd;
  const before = textarea.value.slice(0, selectionStart);
  const after = textarea.value.slice(selectionEnd);
  const leadingBreak =
    before.trim().length > 0 && pastedValue.length > 0 && !before.endsWith('\n')
      ? '\n'
      : '';
  const trailingBreak =
    after.trim().length > 0 && pastedValue.length > 0 && !after.startsWith('\n')
      ? '\n'
      : '';
  const nextValue = `${before}${leadingBreak}${pastedValue}${trailingBreak}${after}`;
  const entries = parseEntries(nextValue);
  const beforeEntries = parseEntries(before);
  const caretValue = serializeEntries([...beforeEntries, ...pastedEntries]);

  return { caret: caretValue.length, entries };
}

function spinProgressFor(elapsed: number, duration: number): number {
  const time = Math.min(duration, elapsed);
  const accelerationDuration = duration * ACCELERATION_PHASE;
  const fastDuration = duration * FAST_PHASE;
  const slowdownDuration = duration - accelerationDuration - fastDuration;
  const maxVelocity =
    1 / (accelerationDuration / 2 + fastDuration + slowdownDuration / 2);

  if (time < accelerationDuration) {
    return (maxVelocity * time * time) / (2 * accelerationDuration);
  }

  const accelerationDistance = (maxVelocity * accelerationDuration) / 2;
  if (time < accelerationDuration + fastDuration) {
    return accelerationDistance + maxVelocity * (time - accelerationDuration);
  }

  const slowdownTime = time - accelerationDuration - fastDuration;
  const fastDistance = maxVelocity * fastDuration;
  const slowdownDistance =
    maxVelocity * slowdownTime -
    (maxVelocity * slowdownTime * slowdownTime) / (2 * slowdownDuration);

  return Math.min(1, accelerationDistance + fastDistance + slowdownDistance);
}

function fitCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  const size = Math.max(1, Math.floor(Math.min(rect.width, rect.height)));
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const pixels = Math.floor(size * scale);
  if (canvas.width !== pixels || canvas.height !== pixels) {
    canvas.width = pixels;
    canvas.height = pixels;
  }
  const context = canvas.getContext('2d');
  context?.setTransform(scale, 0, 0, scale, 0, 0);
  return context;
}

function drawWheel(
  elements: Elements,
  entries: readonly string[],
  rotation: number,
): void {
  const { canvas } = elements;
  const context = fitCanvas(canvas);
  if (!context) return;

  const styles = getComputedStyle(canvas);
  const surface =
    styles.getPropertyValue('--wheel-surface').trim() || '#f1eee7';
  const surfaceStrong =
    styles.getPropertyValue('--wheel-surface-strong').trim() || '#f8f6f1';
  const text = styles.getPropertyValue('--wheel-text').trim() || '#282724';
  const rule = styles.getPropertyValue('--wheel-rule').trim() || '#9d978c';
  const size = canvas.width / Math.min(window.devicePixelRatio || 1, 2);
  const center = size / 2;
  const radius = Math.max(0, center - 8);
  const rimRadius = Math.max(0, radius - 2);
  context.clearRect(0, 0, size, size);

  if (entries.length === 0) {
    context.beginPath();
    context.arc(center, center, radius, 0, TAU);
    context.fillStyle = surface;
    context.fill();
    context.strokeStyle = rule;
    context.lineWidth = 1.5;
    context.stroke();
    return;
  }

  context.save();
  context.translate(center, center);
  context.rotate(rotation);
  context.beginPath();
  context.arc(0, 0, radius, 0, TAU);
  context.fillStyle = text;
  context.fill();
  context.restore();

  const arc = TAU / entries.length;
  for (const [index, entry] of entries.entries()) {
    const start = rotation + index * arc;
    context.beginPath();
    context.moveTo(center, center);
    context.arc(center, center, rimRadius, start, start + arc);
    context.closePath();
    const color = WHEEL_COLORS[index % WHEEL_COLORS.length];
    context.fillStyle = color.fill;
    context.fill();
    context.strokeStyle = 'rgba(255,255,255,.72)';
    context.lineWidth = entries.length > 40 ? 0.5 : 1.5;
    context.stroke();

    if (entries.length > 60) continue;
    context.save();
    context.translate(center, center);
    context.rotate(start + arc / 2);
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    context.fillStyle = color.text;
    context.font = `600 ${Math.max(10, Math.min(16, 240 / entries.length + 9))}px ui-monospace, monospace`;
    const maxWidth = rimRadius * 0.68;
    const label = entry.length > 30 ? `${entry.slice(0, 29)}…` : entry;
    context.fillText(label, rimRadius - 22, 0, maxWidth);
    context.restore();
  }

  context.save();
  context.translate(center, center);
  context.rotate(rotation);
  context.strokeStyle = surfaceStrong;
  context.lineWidth = Math.max(2, radius * 0.013);
  for (let index = 0; index < entries.length; index += 1) {
    const angle = index * arc;
    context.beginPath();
    context.moveTo(
      Math.cos(angle) * (rimRadius - 10),
      Math.sin(angle) * (rimRadius - 10),
    );
    context.lineTo(Math.cos(angle) * rimRadius, Math.sin(angle) * rimRadius);
    context.stroke();
  }
  context.restore();

  context.beginPath();
  context.arc(center, center, radius, 0, TAU);
  context.strokeStyle = text;
  context.lineWidth = Math.max(3, radius * 0.018);
  context.stroke();

  context.beginPath();
  context.arc(center, center, Math.max(17, radius * 0.09), 0, TAU);
  context.fillStyle = surfaceStrong;
  context.fill();
  context.strokeStyle = text;
  context.lineWidth = 2;
  context.stroke();

  context.beginPath();
  context.arc(
    center - radius * 0.025,
    center - radius * 0.025,
    Math.max(4, radius * 0.025),
    0,
    TAU,
  );
  context.fillStyle = 'rgba(255,255,255,.7)';
  context.fill();
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function initializeWheel(): void {
  disposeCurrentWheel?.();
  const root = document.querySelector<HTMLElement>('[data-wheel-tool]');
  if (!root || root.dataset.initialized === 'true') return;
  root.dataset.initialized = 'true';

  const elements = queryElements(root);
  let state = loadState();
  let rotation = POINTER_ANGLE - Math.PI;
  let winnerIndex: number | null = null;
  let spinFrame = 0;
  let idleFrame = 0;
  let idleLastDraw = 0;
  let spinning = false;
  const controller = new AbortController();
  const options = { signal: controller.signal };

  const stopIdleRotation = () => {
    cancelAnimationFrame(idleFrame);
    idleFrame = 0;
    idleLastDraw = 0;
  };

  const startIdleRotation = () => {
    if (
      idleFrame ||
      spinning ||
      state.entries.length < 2 ||
      elements.dialog.open
    )
      return;
    if (prefersReducedMotion()) return;

    const animateIdle = (now: number) => {
      if (!idleLastDraw) idleLastDraw = now;
      const elapsedSeconds = Math.min(0.05, (now - idleLastDraw) / 1000);
      idleLastDraw = now;
      rotation += IDLE_ROTATION_RADIANS_PER_SECOND * elapsedSeconds;
      drawWheel(elements, state.entries, rotation);
      idleFrame = requestAnimationFrame(animateIdle);
    };

    idleFrame = requestAnimationFrame(animateIdle);
  };

  const updateMotionState = () => {
    elements.canvas.setAttribute(
      'aria-disabled',
      spinning || state.entries.length < 2 ? 'true' : 'false',
    );
    elements.spinButton.textContent = spinning ? 'Spinning' : 'Spin';
    elements.canvas.classList.toggle(
      'is-disabled',
      spinning || state.entries.length < 2,
    );
    elements.canvas
      .closest('.wheel-stage')
      ?.classList.toggle('is-spinning', spinning);

    if (spinning || state.entries.length < 2 || elements.dialog.open) {
      stopIdleRotation();
    } else {
      startIdleRotation();
    }
  };

  const render = (syncTextarea = true) => {
    if (syncTextarea) elements.entries.value = serializeEntries(state.entries);
    elements.count.textContent = `${state.entries.length} ${state.entries.length === 1 ? 'entry' : 'entries'}`;
    elements.removeWinner.checked = state.removeWinner;
    elements.spinButton.disabled = spinning || state.entries.length < 2;
    elements.emptyMessage.hidden = state.entries.length > 0;
    drawWheel(elements, state.entries, rotation);
    saveState(state);
    updateMotionState();
  };

  const setEntries = (entries: string[]) => {
    if (spinning) return;
    state = { ...state, entries };
    winnerIndex = null;
    render();
  };

  const removeWinner = () => {
    if (winnerIndex === null) return;
    setEntries(removeEntryAt(state.entries, winnerIndex));
    winnerIndex = null;
    elements.dialog.close();
  };

  const finishSpin = (selectedIndex: number, finalRotation: number) => {
    rotation = finalRotation;
    spinning = false;
    winnerIndex = selectedIndex;
    elements.winner.textContent = state.entries[selectedIndex];
    elements.removeDialogWinner.hidden = state.removeWinner;
    render();
    elements.dialog.showModal();
    updateMotionState();

    if (state.removeWinner) {
      const winner = state.entries[selectedIndex];
      state = {
        ...state,
        entries: removeEntryAt(state.entries, selectedIndex),
      };
      winnerIndex = null;
      elements.winner.textContent = winner;
      render();
    }
  };

  const spin = () => {
    if (spinning || state.entries.length < 2) return;
    stopIdleRotation();
    spinning = true;
    render();

    const selectedIndex = secureRandomInt(state.entries.length);
    const arc = TAU / state.entries.length;
    const selectedCenter = selectedIndex * arc + arc / 2;
    const reducedMotion = prefersReducedMotion();
    const currentNormalized = ((rotation % TAU) + TAU) % TAU;
    const targetNormalized =
      (((POINTER_ANGLE - selectedCenter) % TAU) + TAU) % TAU;
    const turnCount = reducedMotion
      ? REDUCED_MOTION_SPIN_TURNS
      : SPIN_TURNS + secureRandomInt(4);
    const delta =
      ((targetNormalized - currentNormalized + TAU) % TAU) + TAU * turnCount;
    const startRotation = rotation;
    const finalRotation = startRotation + delta;

    const startedAt = performance.now();
    const animate = (now: number) => {
      const elapsed = now - startedAt;
      const progress = spinProgressFor(elapsed, SPIN_DURATION_MS);
      rotation = startRotation + delta * progress;
      drawWheel(elements, state.entries, rotation);
      if (progress < 1) spinFrame = requestAnimationFrame(animate);
      else finishSpin(selectedIndex, finalRotation);
    };
    spinFrame = requestAnimationFrame(animate);
  };

  elements.entries.addEventListener(
    'input',
    () => {
      if (spinning) return;
      state = { ...state, entries: parseEntries(elements.entries.value) };
      winnerIndex = null;
      render(false);
    },
    options,
  );
  elements.entries.addEventListener(
    'paste',
    (event) => {
      if (spinning) return;
      const pastedText = event.clipboardData?.getData('text/plain');
      if (pastedText === undefined) return;

      event.preventDefault();
      const parsed = insertParsedPaste(elements.entries, pastedText);
      state = { ...state, entries: parsed.entries };
      winnerIndex = null;
      render();
      elements.entries.setSelectionRange(parsed.caret, parsed.caret);
    },
    options,
  );
  elements.spinButton.addEventListener('click', spin, options);
  elements.canvas.addEventListener('click', spin, options);
  elements.canvas.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      spin();
    },
    options,
  );
  elements.shuffleButton.addEventListener(
    'click',
    () => setEntries(shuffleEntries(state.entries)),
    options,
  );
  elements.sortButton.addEventListener(
    'click',
    () => setEntries(sortEntries(state.entries)),
    options,
  );
  elements.clearButton.addEventListener('click', () => setEntries([]), options);
  elements.removeWinner.addEventListener(
    'change',
    () => {
      state = { ...state, removeWinner: elements.removeWinner.checked };
      render();
    },
    options,
  );
  elements.closeDialog.addEventListener(
    'click',
    () => elements.dialog.close(),
    options,
  );
  elements.dialog.addEventListener('close', updateMotionState, options);
  elements.removeDialogWinner.addEventListener('click', removeWinner, options);
  window.addEventListener('resize', () => render(), options);

  render();
  disposeCurrentWheel = () => {
    cancelAnimationFrame(spinFrame);
    stopIdleRotation();
    controller.abort();
    elements.dialog.close();
    delete root.dataset.initialized;
    disposeCurrentWheel = undefined;
  };
}

document.addEventListener('astro:page-load', initializeWheel);
document.addEventListener('astro:before-swap', () => disposeCurrentWheel?.());

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeWheel, {
    once: true,
  });
} else {
  initializeWheel();
}
