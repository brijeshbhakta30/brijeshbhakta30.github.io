import { CARD_ORDER, ROOM_ALPHABET } from './constants';
import { makeRandomId } from './state';

const PROFILE_NAME_STORAGE_KEY = 'scrum-poker-name';
const IDENTITY_STORAGE_PREFIX = 'scrum-poker-identity:';
const VOTE_STORAGE_PREFIX = 'scrum-poker-vote:';
const SCRUM_POKER_ROOM_ROUTE_PATTERN =
  /^\/tools\/scrum-poker\/([^/]+)\/?$/i;

export const makeRoomCode = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(7)),
    (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length],
  ).join('');

export const normalizeRoomCode = (value: string) =>
  value
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, '')
    .slice(0, 32);

export const inviteUrl = (roomCode: string) =>
  new URL(
    `/tools/scrum-poker/${encodeURIComponent(roomCode)}`,
    globalThis.location.origin,
  ).toString();

export const updateRoomUrl = (roomCode?: string) => {
  const url = new URL(globalThis.location.href);
  url.pathname = roomCode
    ? `/tools/scrum-poker/${encodeURIComponent(roomCode)}`
    : '/tools/scrum-poker';
  url.searchParams.delete('room');
  url.hash = '';
  history.replaceState({}, '', url);
};

export const roomFromLocation = () => {
  const match = SCRUM_POKER_ROOM_ROUTE_PATTERN.exec(
    globalThis.location.pathname,
  );
  const pathRoom = match ? decodeURIComponent(match[1]) : '';
  const queryRoom =
    new URLSearchParams(globalThis.location.search).get('room') ?? '';
  return normalizeRoomCode(pathRoom || queryRoom);
};

export const saveProfileName = (name: string) => {
  const savedName = name.trim().slice(0, 32);
  if (!savedName) return '';
  localStorage.setItem(PROFILE_NAME_STORAGE_KEY, savedName);
  return savedName;
};

export const savedProfileName = () =>
  localStorage.getItem(PROFILE_NAME_STORAGE_KEY) ??
  sessionStorage.getItem(PROFILE_NAME_STORAGE_KEY) ??
  '';

export const savedLocalProfileName = () =>
  localStorage.getItem(PROFILE_NAME_STORAGE_KEY) ?? '';

export const roomIdentity = (roomCode: string) => {
  const key = `${IDENTITY_STORAGE_PREFIX}${roomCode}`;
  let value = localStorage.getItem(key);
  if (!value) {
    value = makeRandomId();
    localStorage.setItem(key, value);
  }
  return value;
};

export const persistLocalVote = (
  roomCode: string,
  roundId: string,
  vote: string | null,
) => {
  const key = `${VOTE_STORAGE_PREFIX}${roomCode}`;
  if (vote === null) sessionStorage.removeItem(key);
  else sessionStorage.setItem(key, JSON.stringify({ roundId, vote }));
};

export const loadLocalVote = (roomCode: string, roundId: string) => {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(`${VOTE_STORAGE_PREFIX}${roomCode}`) ?? 'null',
    ) as { roundId?: string; vote?: string } | null;
    if (
      saved?.roundId === roundId &&
      saved.vote &&
      CARD_ORDER.includes(saved.vote)
    )
      return saved.vote;
  } catch {
    sessionStorage.removeItem(`${VOTE_STORAGE_PREFIX}${roomCode}`);
  }
  return null;
};
