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
    .map((line) => parseEntryLine(line))
    .filter((entry): entry is string => entry !== null)
    .slice(0, MAX_ENTRIES);
}

export function serializeEntries(entries: string[]): string {
  return entries.join('\n');
}

function decodeHtmlEntities(value: string): string {
  return value.replaceAll(
    /&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/gi,
    (match, code, name) => {
      if (typeof code === 'string') {
        const point = code.toLowerCase().startsWith('x')
          ? Number.parseInt(code.slice(1), 16)
          : Number.parseInt(code, 10);

        return Number.isFinite(point) && point >= 0 && point <= 0x10_FF_FF
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

function stripTrailingCommas(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === ',') end -= 1;
  return value.slice(0, end).trim();
}

function leadingStrikeMarkerLength(value: string): number {
  if (value.startsWith(String.raw`\~~`)) return 3;
  if (value.startsWith(String.raw`\~`)) return 2;
  if (value.startsWith('~~')) return 2;
  return value.startsWith('~') ? 1 : 0;
}

function trailingStrikeMarkerLength(value: string): number {
  if (value.endsWith(String.raw`\~~`)) return 3;
  if (value.endsWith(String.raw`\~`)) return 2;
  if (value.endsWith('~~')) return 2;
  return value.endsWith('~') ? 1 : 0;
}

function isStruckThrough(value: string): boolean {
  const leadingLength = leadingStrikeMarkerLength(value);
  const trailingLength = trailingStrikeMarkerLength(value);
  return (
    leadingLength > 0 &&
    trailingLength > 0 &&
    value.length > leadingLength + trailingLength
  );
}

function parseEntryLine(line: string): string | null {
  let entry = decodeHtmlEntities(line).trim();
  if (!entry) return null;

  entry = stripTrailingCommas(entry);
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
  return entries.toSorted((left, right) =>
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

  const range = 0x1_00_00_00_00;
  const limit = range - (range % max);
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= limit);

  return values[0] % max;
}
