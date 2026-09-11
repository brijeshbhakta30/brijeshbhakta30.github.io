export const leadingThrottle = <Arguments extends unknown[]>(
  callback: (...arguments_: Arguments) => void,
  windowMs = 500,
) => {
  let nextAllowedAt = 0;

  return (...arguments_: Arguments) => {
    const now = Date.now();
    if (now < nextAllowedAt) return;
    nextAllowedAt = now + windowMs;
    callback(...arguments_);
  };
};
