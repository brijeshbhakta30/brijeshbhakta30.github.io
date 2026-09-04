import {
  normalizeAngle,
  POINTER_RESTING_ANGLE,
  pointerAngleForOffset,
  TAU,
  winningIndexForRotation,
} from './geometry';
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
const IDLE_ROTATION_RADIANS_PER_SECOND = 0.18;
const WHEEL_STOP_RADIANS_PER_SECOND = 0.012;
const POINTER_SETTLE_OFFSET_PIXELS = 0.06;
const POINTER_SETTLE_VELOCITY_PIXELS_PER_SECOND = 0.2;
const POINTER_MAX_TRAVEL_PIXELS = 26;
const POINTER_RETURN_DAMPING = 19;
const POINTER_RETURN_STIFFNESS = 135;
const SPIN_RANDOM_SCALE = 1_000_000;
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
type SpinPhase = 'accelerating' | 'cruising' | 'coasting' | 'stopped';
type SpinMotion = {
  acceleration: number;
  accelerationDuration: number;
  angularVelocity: number;
  cruiseDuration: number;
  drag: number;
  elapsedInPhase: number;
  friction: number;
  maxAngularVelocity: number;
  phase: SpinPhase;
};

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
    pointer: required<HTMLElement>('.wheel-pointer'),
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

function randomUnit(): number {
  return secureRandomInt(SPIN_RANDOM_SCALE) / SPIN_RANDOM_SCALE;
}

function randomBetween(minimum: number, maximum: number): number {
  return minimum + (maximum - minimum) * randomUnit();
}

function createSpinMotion(reducedMotion: boolean): SpinMotion {
  const initialVelocity = reducedMotion
    ? randomBetween(0.55, 1.1)
    : randomBetween(1.2, 2.4);
  const maxAngularVelocity = reducedMotion
    ? randomBetween(7, 11)
    : randomBetween(36, 50);
  const accelerationDuration = reducedMotion
    ? randomBetween(0.35, 0.55)
    : randomBetween(0.75, 1.15);

  return {
    acceleration:
      (maxAngularVelocity - initialVelocity) / accelerationDuration,
    accelerationDuration,
    angularVelocity: initialVelocity,
    cruiseDuration: reducedMotion
      ? randomBetween(0.05, 0.16)
      : randomBetween(0.28, 0.85),
    drag: reducedMotion ? randomBetween(1.05, 1.45) : randomBetween(0.36, 0.54),
    elapsedInPhase: 0,
    friction: reducedMotion
      ? randomBetween(1.8, 2.6)
      : randomBetween(0.42, 0.7),
    maxAngularVelocity,
    phase: 'accelerating',
  };
}

function advanceSpinMotion(motion: SpinMotion, elapsedSeconds: number): boolean {
  if (motion.phase === 'stopped') return true;

  motion.elapsedInPhase += elapsedSeconds;

  if (motion.phase === 'accelerating') {
    motion.angularVelocity = Math.min(
      motion.maxAngularVelocity,
      motion.angularVelocity + motion.acceleration * elapsedSeconds,
    );

    if (motion.elapsedInPhase >= motion.accelerationDuration) {
      motion.phase = 'cruising';
      motion.elapsedInPhase = 0;
      motion.angularVelocity = motion.maxAngularVelocity;
    }

    return false;
  }

  if (motion.phase === 'cruising') {
    motion.angularVelocity = motion.maxAngularVelocity;

    if (motion.elapsedInPhase >= motion.cruiseDuration) {
      motion.phase = 'coasting';
      motion.elapsedInPhase = 0;
    }

    return false;
  }

  const deceleration =
    motion.friction + motion.drag * Math.max(0, motion.angularVelocity);
  motion.angularVelocity = Math.max(
    0,
    motion.angularVelocity - deceleration * elapsedSeconds,
  );

  if (motion.angularVelocity <= WHEEL_STOP_RADIANS_PER_SECOND) {
    motion.angularVelocity = 0;
    motion.phase = 'stopped';
    return true;
  }

  return false;
}

function wheelRadiusFor(canvas: HTMLCanvasElement): number {
  const rect = canvas.getBoundingClientRect();
  const size = Math.max(1, Math.min(rect.width, rect.height));
  return Math.max(1, size / 2 - 8);
}

function pointerMaxTravelFor(wheelRadiusPixels: number): number {
  return Math.min(
    POINTER_MAX_TRAVEL_PIXELS,
    Math.max(12, wheelRadiusPixels * 0.06),
  );
}

function pointerOffsetFor(
  phase: number,
  angularVelocity: number,
  wheelRadiusPixels: number,
): number {
  if (angularVelocity <= 0) return 0;

  const speedRatio = Math.min(1, angularVelocity / 34);
  const maxTravel = pointerMaxTravelFor(wheelRadiusPixels);

  return Math.sin(phase) * maxTravel * speedRatio;
}

function applyPointerTransform(
  elements: Elements,
  offsetPixels: number,
  velocityPixelsPerSecond: number,
): void {
  const shift = Math.min(5, Math.abs(offsetPixels) * 0.18) * -1;
  const tilt = Math.max(
    -11,
    Math.min(11, offsetPixels * -0.45 + velocityPixelsPerSecond * 0.012),
  );

  elements.pointer.style.setProperty(
    '--wheel-pointer-offset',
    `${offsetPixels.toFixed(2)}px`,
  );
  elements.pointer.style.setProperty(
    '--wheel-pointer-shift',
    `${shift.toFixed(2)}px`,
  );
  elements.pointer.style.setProperty(
    '--wheel-pointer-tilt',
    `${tilt.toFixed(2)}deg`,
  );
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
  let rotation = POINTER_RESTING_ANGLE - Math.PI;
  let winnerIndex: number | null = null;
  let spinFrame = 0;
  let spinMotion: SpinMotion | null = null;
  let spinLastDraw = 0;
  let idleFrame = 0;
  let idleLastDraw = 0;
  let pointerOffsetPixels = 0;
  let pointerPhase = 0;
  let pointerVelocityPixelsPerSecond = 0;
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

  const resetPointer = () => {
    pointerOffsetPixels = 0;
    pointerPhase = 0;
    pointerVelocityPixelsPerSecond = 0;
    applyPointerTransform(
      elements,
      pointerOffsetPixels,
      pointerVelocityPixelsPerSecond,
    );
  };

  const advancePointer = (
    elapsedSeconds: number,
    angularVelocity: number,
  ): boolean => {
    const wheelRadiusPixels = wheelRadiusFor(elements.canvas);
    const maxOffset = pointerMaxTravelFor(wheelRadiusPixels);

    if (angularVelocity > 0) {
      const previousOffset = pointerOffsetPixels;
      pointerPhase = normalizeAngle(
        pointerPhase - angularVelocity * elapsedSeconds,
      );
      pointerOffsetPixels = pointerOffsetFor(
        pointerPhase,
        angularVelocity,
        wheelRadiusPixels,
      );
      pointerVelocityPixelsPerSecond =
        (pointerOffsetPixels - previousOffset) /
        Math.max(0.001, elapsedSeconds);

      applyPointerTransform(
        elements,
        pointerOffsetPixels,
        pointerVelocityPixelsPerSecond,
      );

      return false;
    }

    const pointerAcceleration =
      -pointerOffsetPixels * POINTER_RETURN_STIFFNESS -
      pointerVelocityPixelsPerSecond * POINTER_RETURN_DAMPING;

    pointerVelocityPixelsPerSecond += pointerAcceleration * elapsedSeconds;
    pointerOffsetPixels += pointerVelocityPixelsPerSecond * elapsedSeconds;
    pointerOffsetPixels = Math.max(
      -maxOffset,
      Math.min(maxOffset, pointerOffsetPixels),
    );

    if (
      angularVelocity === 0 &&
      Math.abs(pointerOffsetPixels) < POINTER_SETTLE_OFFSET_PIXELS &&
      Math.abs(pointerVelocityPixelsPerSecond) <
        POINTER_SETTLE_VELOCITY_PIXELS_PER_SECOND
    ) {
      resetPointer();
      return true;
    }

    applyPointerTransform(
      elements,
      pointerOffsetPixels,
      pointerVelocityPixelsPerSecond,
    );

    return false;
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

  const finishSpin = () => {
    const pointerAngle = pointerAngleForOffset(
      pointerOffsetPixels,
      wheelRadiusFor(elements.canvas),
    );
    const selectedIndex = winningIndexForRotation(
      state.entries.length,
      rotation,
      pointerAngle,
    );
    const winner = state.entries[selectedIndex];

    rotation = normalizeAngle(rotation);
    spinning = false;
    spinMotion = null;
    spinLastDraw = 0;
    winnerIndex = selectedIndex;
    elements.winner.textContent = winner;
    elements.removeDialogWinner.hidden = state.removeWinner;
    elements.dialog.showModal();
    render();

    if (state.removeWinner) {
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
    winnerIndex = null;
    spinMotion = createSpinMotion(prefersReducedMotion());
    spinLastDraw = performance.now();
    resetPointer();
    render();

    const animate = (now: number) => {
      if (!spinMotion) return;

      const elapsedSeconds = Math.min(0.05, (now - spinLastDraw) / 1000);
      spinLastDraw = now;
      const wheelStopped = advanceSpinMotion(spinMotion, elapsedSeconds);

      rotation += spinMotion.angularVelocity * elapsedSeconds;
      drawWheel(elements, state.entries, rotation);
      const pointerStopped = advancePointer(
        elapsedSeconds,
        spinMotion.angularVelocity,
      );

      if (wheelStopped && pointerStopped) finishSpin();
      else spinFrame = requestAnimationFrame(animate);
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
