export const MAX_CORE_PEERS = 5;
export const CLIENT_CORE_CONNECTIONS = 2;

export type CorePeerInfo = {
  participantId: string;
  peerId: string;
};

export type CoreLoadInfo = CorePeerInfo & {
  connectionCount: number;
  connectionQuality: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
  sentAt: number;
};

export type RoomTopology = {
  generation: number;
  coordinatorParticipantId: string;
  cores: CorePeerInfo[];
};

export type TopologyParticipant = CorePeerInfo & {
  healthRank?: number;
};

export const EMPTY_TOPOLOGY: RoomTopology = {
  generation: 0,
  coordinatorParticipantId: '',
  cores: [],
};

export const sortByParticipantId = <T extends CorePeerInfo>(items: T[]) =>
  [...items].toSorted((left, right) =>
    left.participantId.localeCompare(right.participantId),
  );

export const electCoordinator = (cores: CorePeerInfo[]) =>
  sortByParticipantId(cores)[0]?.participantId ?? '';

export const canonicalTopology = (topology: RoomTopology): RoomTopology => {
  const cores = new Map<string, CorePeerInfo>();
  for (const core of topology.cores) {
    if (!core.participantId || !core.peerId) continue;
    cores.set(core.participantId, {
      participantId: core.participantId,
      peerId: core.peerId,
    });
  }
  const sortedCores = sortByParticipantId([...cores.values()]).slice(
    0,
    MAX_CORE_PEERS,
  );
  const coordinatorParticipantId = sortedCores.some(
    (core) => core.participantId === topology.coordinatorParticipantId,
  )
    ? topology.coordinatorParticipantId
    : electCoordinator(sortedCores);

  return {
    generation: Math.max(0, Math.floor(topology.generation || 0)),
    coordinatorParticipantId,
    cores: sortedCores,
  };
};

export const topologyKey = (topology: RoomTopology) => {
  const canonical = canonicalTopology(topology);
  return [
    canonical.coordinatorParticipantId,
    ...canonical.cores.map((core) => `${core.participantId}:${core.peerId}`),
  ].join('|');
};

export const shouldAcceptTopology = (
  current: RoomTopology,
  candidate: RoomTopology,
) => {
  const local = canonicalTopology(current);
  const incoming = canonicalTopology(candidate);
  if (incoming.generation !== local.generation)
    return incoming.generation > local.generation;
  return topologyKey(incoming).localeCompare(topologyKey(local)) < 0;
};

export const chooseCoreTopology = ({
  participants,
  current,
  generation,
}: {
  participants: TopologyParticipant[];
  current: RoomTopology;
  generation: number;
}): RoomTopology => {
  const uniqueParticipants = new Map<string, TopologyParticipant>();
  for (const participant of participants) {
    if (!participant.participantId || !participant.peerId) continue;
    uniqueParticipants.set(participant.participantId, participant);
  }
  const participantList = [...uniqueParticipants.values()].filter(
    (participant) => participant.healthRank !== 2,
  );
  const desiredCoreCount = Math.min(MAX_CORE_PEERS, participantList.length);
  const participantIds = new Set(
    participantList.map((participant) => participant.participantId),
  );
  const chosen = new Map<string, CorePeerInfo>();

  for (const core of canonicalTopology(current).cores) {
    const participant = uniqueParticipants.get(core.participantId);
    if (!participant || participant.healthRank === 2) continue;
    chosen.set(core.participantId, {
      participantId: core.participantId,
      peerId: participant.peerId,
    });
    if (chosen.size >= desiredCoreCount) break;
  }

  const candidates = participantList
    .filter((participant) => !chosen.has(participant.participantId))
    .toSorted((left, right) => {
      const health = (left.healthRank ?? 0) - (right.healthRank ?? 0);
      if (health !== 0) return health;
      return left.participantId.localeCompare(right.participantId);
    });

  for (const participant of candidates) {
    if (chosen.size >= desiredCoreCount) break;
    if (!participantIds.has(participant.participantId)) continue;
    chosen.set(participant.participantId, {
      participantId: participant.participantId,
      peerId: participant.peerId,
    });
  }

  const cores = sortByParticipantId([...chosen.values()]);
  return {
    generation,
    coordinatorParticipantId: electCoordinator(cores),
    cores,
  };
};

const FNV_1A_32_OFFSET_BASIS = 2_166_136_261;
const FNV_1A_32_PRIME = 16_777_619;

const hashString = (value: string) => {
  let hash = FNV_1A_32_OFFSET_BASIS;
  for (const symbol of value) {
    hash ^= symbol.codePointAt(0) ?? 0;
    hash = Math.imul(hash, FNV_1A_32_PRIME);
  }
  return hash >>> 0;
};

export const chooseClientCores = (
  topology: RoomTopology,
  participantId: string,
  load: Map<string, CoreLoadInfo>,
) => {
  const cores = canonicalTopology(topology).cores;
  if (cores.length <= CLIENT_CORE_CONNECTIONS) return cores;

  const primary = cores[hashString(participantId) % cores.length];
  const backupCandidates = cores
    .filter((core) => core.participantId !== primary.participantId)
    .toSorted((left, right) => {
      const leftLoad = load.get(left.participantId);
      const rightLoad = load.get(right.participantId);
      const leftPoor = leftLoad?.connectionQuality === 'poor' ? 1 : 0;
      const rightPoor = rightLoad?.connectionQuality === 'poor' ? 1 : 0;
      if (leftPoor !== rightPoor) return leftPoor - rightPoor;
      const loadDelta =
        (leftLoad?.connectionCount ?? 0) - (rightLoad?.connectionCount ?? 0);
      if (loadDelta !== 0) return loadDelta;
      const hashDelta =
        hashString(`${participantId}:${left.participantId}`) -
        hashString(`${participantId}:${right.participantId}`);
      if (hashDelta !== 0) return hashDelta;
      return left.participantId.localeCompare(right.participantId);
    });

  return [primary, ...backupCandidates].slice(0, CLIENT_CORE_CONNECTIONS);
};
