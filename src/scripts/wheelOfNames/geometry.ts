export const TAU = Math.PI * 2;
export const POINTER_RESTING_ANGLE = 0;

export function normalizeAngle(angle: number): number {
  const normalized = angle % TAU;
  return normalized < 0 ? normalized + TAU : normalized;
}

export function pointerAngleForOffset(
  offsetPixels: number,
  wheelRadiusPixels: number,
  restingAngle = POINTER_RESTING_ANGLE,
): number {
  if (!Number.isFinite(wheelRadiusPixels) || wheelRadiusPixels <= 0) {
    return normalizeAngle(restingAngle);
  }

  return normalizeAngle(
    restingAngle + Math.atan2(offsetPixels, wheelRadiusPixels),
  );
}

export function winningIndexForRotation(
  entryCount: number,
  rotation: number,
  pointerAngle = POINTER_RESTING_ANGLE,
): number {
  if (!Number.isSafeInteger(entryCount) || entryCount <= 0) {
    throw new RangeError('entryCount must be a positive safe integer');
  }

  const arc = TAU / entryCount;
  const localAngle = normalizeAngle(pointerAngle - rotation);

  return Math.min(entryCount - 1, Math.floor(localAngle / arc));
}
