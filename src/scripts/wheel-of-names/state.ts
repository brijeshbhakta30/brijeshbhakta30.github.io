export const DEFAULT_ENTRIES = [
  'Ada',
  'Arthur',
  'Finn',
  'Grace',
  'John',
  'Polly',
];

export const MAX_ENTRIES = 200;
export const MAX_ENTRY_LENGTH = 80;

export type WheelState = {
  entries: string[];
  removeWinner: boolean;
};

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  nbsp: ' ',
  quot: '"',
};

export function parseEntries(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(parseEntryLine)
    .filter((entry): entry is string => entry !== null)
    .slice(0, MAX_ENTRIES);
}

export function serializeEntries(entries: string[]): string {
  return entries.join('\n');
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/gi,
    (match, code, name) => {
      if (typeof code === 'string') {
        const point = code.toLowerCase().startsWith('x')
          ? Number.parseInt(code.slice(1), 16)
          : Number.parseInt(code, 10);

        return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : match;
      }

      return HTML_ENTITIES[String(name).toLowerCase()] ?? match;
    },
  );
}

function stripWrappingToken(value: string, token: string): string {
  return value.length >= 2 && value.startsWith(token) && value.endsWith(token)
    ? value.slice(1, -1).trim()
    : value;
}

function isStruckThrough(value: string): boolean {
  return /^\\?~{1,2}.+?\\?~{1,2}$/.test(value);
}

function parseEntryLine(line: string): string | null {
  let entry = decodeHtmlEntities(line).trim();
  if (!entry) return null;

  entry = entry.replace(/,+$/, '').trim();
  entry = stripWrappingToken(entry, "'");
  entry = stripWrappingToken(entry, '"');
  entry = stripWrappingToken(entry, '`');

  if (!entry || isStruckThrough(entry)) return null;

  return entry.slice(0, MAX_ENTRY_LENGTH);
}

export function shuffleEntries(entries: readonly string[]): string[] {
  const shuffled = [...entries];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapWith = secureRandomInt(index + 1);
    [shuffled[index], shuffled[swapWith]] = [
      shuffled[swapWith],
      shuffled[index],
    ];
  }
  return shuffled;
}

export function sortEntries(entries: readonly string[]): string[] {
  return [...entries].sort((left, right) =>
    left.localeCompare(right, undefined, {
      sensitivity: 'base',
      numeric: true,
    }),
  );
}

export function removeEntryAt(
  entries: readonly string[],
  index: number,
): string[] {
  return entries.filter((_, entryIndex) => entryIndex !== index);
}

/** Returns a uniformly distributed integer from 0 (inclusive) to max (exclusive). */
export function secureRandomInt(max: number): number {
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new RangeError('max must be a positive safe integer');
  }

  const range = 0x1_0000_0000;
  const limit = range - (range % max);
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= limit);

  return values[0] % max;
}
