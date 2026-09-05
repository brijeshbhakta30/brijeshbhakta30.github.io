/* eslint-disable no-console */
import type { ConnectionDiagnostics } from './network';

import { DEBUG_CHEAT_CODE, DEBUG_SESSION_KEY } from './constants';
import {
  activePlayers,
  type Player,
  presenceFor,
  type RoomState,
  votingStatusFor,
} from './state';

/* eslint-disable no-unused-vars */
declare global {
    var scrumPoker: {
      help: () => void;
      showParticipants: () => void;
      showRoomState: () => void;
      showConnections: () => void;
      showNetworkConfig: () => void;
      showConnectionMode: () => void;
      showQualityReport: () => void;
      testConnection: () => void;
    } | undefined
}
/* eslint-enable no-unused-vars */

const getLatencyStatus = (latency: number) => {
  if (latency < 200) return 'Good';
  if (latency < 500) return 'Fair';
  return 'Poor';
};

const getReconnectStatus = (count: number) => {
  if (count === 0) return 'Stable';
  if (count < 5) return 'Some issues';
  return 'Unstable';
};

const getPercentage = (count: number, total: number) => {
  return total > 0 ? `${Math.round(count / total * 100)}%` : '0%';
};

export const enableDebugApi = ({
  getState,
  getCurrentRoom,
  getLocalPlayerId,
  getLocalVote,
  getDiagnostics,
  getNetworkConfig,
  getConnectionMode,
  hasOpenConnection,
  debugBuild,
}: {
  getState: () => RoomState;
  getCurrentRoom: () => string;
  getLocalPlayerId: () => string;
  getLocalVote: () => string | null;
  getDiagnostics: () => Map<string, ConnectionDiagnostics>;
  getNetworkConfig: () => {
    iceTransportPolicy: string;
    iceServersCount: number;
    iceServers: RTCIceServer[];
    stunServers: string[];
    hasTurnServers: boolean;
    usingPublicTurn: boolean;
  };
  getConnectionMode: () => {
    usingFallbackMode: boolean;
    totalMeshFailures: number;
    fallbackThreshold: number;
  };
  hasOpenConnection: (player: Player) => boolean;
  debugBuild: boolean;
}) => {
  const visiblePlayers = () => activePlayers(getState());
  const playerPresence = (player: Player) =>
    presenceFor(player, Date.now(), hasOpenConnection(player));

  sessionStorage.setItem(DEBUG_SESSION_KEY, 'true');
  globalThis.scrumPoker = {
    help: () =>
      console.table([
        {
          command: 'scrumPoker.help()',
          description: 'List debug commands.',
        },
        {
          command: 'scrumPoker.showParticipants()',
          description: 'Show participant, voting, and presence state.',
        },
        {
          command: 'scrumPoker.showRoomState()',
          description: 'Show synchronized round, timer, and configuration.',
        },
        {
          command: 'scrumPoker.showConnections()',
          description: 'Show WebRTC state for every direct connection.',
        },
        {
          command: 'scrumPoker.showNetworkConfig()',
          description: 'Show current WebRTC/ICE network configuration.',
        },
        {
          command: 'scrumPoker.testConnection()',
          description: 'Test basic WebRTC connectivity and show diagnostics.',
        },
        {
          command: 'scrumPoker.showConnectionMode()',
          description: 'Show current connection mode and fallback status.',
        },
        {
          command: 'scrumPoker.showQualityReport()',
          description: 'Show overall connection quality report and recommendations.',
        },
      ]),
    showParticipants: () => {
      const state = getState();
      console.table(
        visiblePlayers().map((player) => ({
          name: player.name,
          participantId: player.id,
          peerId: player.peerId,
          status: votingStatusFor(player, state, playerPresence(player)),
          presenceState: playerPresence(player),
          lastSeenAt: new Date(player.lastSeenAt).toISOString(),
          hasVoted: player.voteRoundId === state.roundId && player.hasVoted,
        })),
      );
    },
    showRoomState: () => {
      const state = getState();
      console.table([
        {
          roomCode: getCurrentRoom(),
          round: state.round,
          roundId: state.roundId,
          version: state.version,
          revealed: state.revealed,
          timerDuration: state.timerDuration,
          timerEndsAt: state.timerEndsAt
            ? new Date(state.timerEndsAt).toISOString()
            : null,
          autoReveal: state.autoReveal,
          allowVoteChangesAfterReveal: state.allowVoteChangesAfterReveal,
          participantCount: visiblePlayers().length,
        },
      ]);
    },
    showConnections: () => {
      const state = getState();
      console.table(
        [...getDiagnostics().values()].map((row) => {
          const player = state.players.find(
            (item) => item.id === row.participantId,
          );
          return {
            participant: player?.name ?? 'Unknown',
            participantId: row.participantId ?? 'Unknown',
            peerId: row.peerId,
            connectionState: row.connectionState,
            iceConnectionState: row.iceConnectionState,
            iceGatheringState: row.iceGatheringState,
            signalingState: row.signalingState,
            connectionQuality: row.connectionQuality,
            latency: row.latency ? `${Math.round(row.latency)}ms` : 'N/A',
            reconnectCount: row.reconnectCount,
            connectionAge: row.connectionAge ? `${Math.round(row.connectionAge / 1000)}s` : 'N/A',
            presenceState: player ? playerPresence(player) : 'reconnecting',
            lastChangedAt: new Date(row.lastChangedAt).toISOString(),
          };
        }),
      );
    },
    showNetworkConfig: () => {
      const config = getNetworkConfig();
      console.table([
        {
          setting: 'ICE Transport Policy',
          value: config.iceTransportPolicy,
          description: 'relay = forces TURN (better for proxies), all = allows direct connections',
        },
        {
          setting: 'ICE Servers Count',
          value: config.iceServersCount,
          description: 'Total number of STUN/TURN servers configured',
        },
        {
          setting: 'STUN Servers',
          value: config.stunServers.join(', '),
          description: 'Servers for discovering public IP addresses',
        },
        {
          setting: 'Custom TURN Servers',
          value: config.hasTurnServers ? 'Yes' : 'No',
          description: 'Whether custom TURN servers are configured via env vars',
        },
        {
          setting: 'Public TURN Fallback',
          value: config.usingPublicTurn ? 'Yes' : 'No',
          description: 'Using public TURN servers for corporate proxy traversal',
        },
      ]);
    },
    showConnectionMode: () => {
      const mode = getConnectionMode();
      console.table([
        {
          setting: 'Connection Mode',
          value: mode.usingFallbackMode ? 'Fallback (Conservative)' : 'Mesh (Aggressive)',
          description: 'Fallback mode limits connections for better reliability',
        },
        {
          setting: 'Total Mesh Failures',
          value: mode.totalMeshFailures,
          description: 'Number of connection failures that occurred',
        },
        {
          setting: 'Fallback Threshold',
          value: mode.fallbackThreshold,
          description: 'Failures required to switch to fallback mode',
        },
      ]);
    },
    showQualityReport: () => {
      const diagnostics = getDiagnostics();
      const mode = getConnectionMode();
      const connections = [...diagnostics.values()];

      if (connections.length === 0) {
        console.log('No active connections to analyze.');
        return;
      }

      const qualityCounts = {
        excellent: 0,
        good: 0,
        fair: 0,
        poor: 0,
        unknown: 0,
      };

      let totalLatency = 0;
      let latencyCount = 0;
      let totalReconnects = 0;

      for (const conn of connections) {
        qualityCounts[conn.connectionQuality]++;
        if (conn.latency) {
          totalLatency += conn.latency;
          latencyCount++;
        }
        totalReconnects += conn.reconnectCount;
      }

      const avgLatency = latencyCount > 0 ? totalLatency / latencyCount : 0;

      console.log('=== Connection Quality Report ===');
      console.table([
        {
          metric: 'Total Connections',
          value: connections.length,
          status: connections.length > 0 ? 'Active' : 'No connections',
        },
        {
          metric: 'Average Latency',
          value: avgLatency ? `${Math.round(avgLatency)}ms` : 'N/A',
          status: getLatencyStatus(avgLatency),
        },
        {
          metric: 'Total Reconnects',
          value: totalReconnects,
          status: getReconnectStatus(totalReconnects),
        },
        {
          metric: 'Connection Mode',
          value: mode.usingFallbackMode ? 'Fallback' : 'Mesh',
          status: mode.usingFallbackMode ? 'Conservative' : 'Aggressive',
        },
        {
          metric: 'Mesh Failures',
          value: mode.totalMeshFailures,
          status: mode.totalMeshFailures < mode.fallbackThreshold ? 'Normal' : 'High',
        },
      ]);

      console.log('\nConnection Quality Distribution:');
      console.table([
        { quality: 'Excellent', count: qualityCounts.excellent, percentage: getPercentage(qualityCounts.excellent, connections.length) },
        { quality: 'Good', count: qualityCounts.good, percentage: getPercentage(qualityCounts.good, connections.length) },
        { quality: 'Fair', count: qualityCounts.fair, percentage: getPercentage(qualityCounts.fair, connections.length) },
        { quality: 'Poor', count: qualityCounts.poor, percentage: getPercentage(qualityCounts.poor, connections.length) },
        { quality: 'Unknown', count: qualityCounts.unknown, percentage: getPercentage(qualityCounts.unknown, connections.length) },
      ]);

      // Provide recommendations
      console.log('\n=== Recommendations ===');
      if (qualityCounts.poor > connections.length / 2) {
        console.warn('⚠️ More than 50% of connections are poor quality.');
        console.warn('   Recommendations:');
        console.warn('   - Check network connectivity');
        console.warn('   - Consider using wired connection instead of WiFi');
        console.warn('   - Check if VPN/proxy is interfering');
      }
      if (avgLatency > 500) {
        console.warn('⚠️ High latency detected (>500ms).');
        console.warn('   Recommendations:');
        console.warn('   - Check network speed');
        console.warn('   - Reduce network congestion');
        console.warn('   - Consider closer TURN servers');
      }
      if (totalReconnects > 5) {
        console.warn('⚠️ High reconnection count detected.');
        console.warn('   Recommendations:');
        console.warn('   - Network may be unstable');
        console.warn('   - Check for intermittent connectivity issues');
        console.warn('   - System may have switched to fallback mode');
      }
      if (mode.usingFallbackMode) {
        console.info('ℹ️ System is running in fallback mode for better reliability.');
        console.info('   This limits connections to prevent overload.');
      }
      if (qualityCounts.excellent + qualityCounts.good > connections.length * 0.7) {
        console.log('✅ Connection quality is good (>70% excellent/good).');
      }
    },
    testConnection: () => {
      console.log('=== WebRTC Connection Test ===');
      console.log('Testing basic WebRTC connectivity...');

      // Test RTCPeerConnection support
      if (!globalThis.RTCPeerConnection) {
        console.error('❌ RTCPeerConnection not supported in this browser');
        return;
      }
      console.log('✅ RTCPeerConnection is supported');

      // Test ICE gathering
      const testConfig = getNetworkConfig();
      console.log('Current network configuration:', {
        iceTransportPolicy: testConfig.iceTransportPolicy,
        iceServersCount: testConfig.iceServersCount,
        stunServers: testConfig.stunServers,
        hasTurnServers: testConfig.hasTurnServers,
        usingPublicTurn: testConfig.usingPublicTurn,
      });

      // Create a test peer connection
      const testPeer = new RTCPeerConnection({
        iceServers: testConfig.iceServers,
        iceTransportPolicy: testConfig.iceTransportPolicy as RTCIceTransportPolicy,
      });

      console.log('✅ Test RTCPeerConnection created');
      console.log('🔄 Starting ICE candidate gathering...');

      let iceCandidates = 0;
      let iceGatheringComplete = false;

      testPeer.onicecandidate = (event) => {
        if (event.candidate) {
          iceCandidates++;
          console.log(`📡 ICE candidate ${iceCandidates}:`, {
            type: event.candidate.type,
            protocol: event.candidate.protocol,
            address: event.candidate.address || 'redacted',
            port: event.candidate.port,
          });
        }
      };

      testPeer.onicegatheringstatechange = () => {
        console.log(`🔄 ICE gathering state: ${testPeer.iceGatheringState}`);
        if (testPeer.iceGatheringState === 'complete') {
          iceGatheringComplete = true;
          console.log('✅ ICE gathering completed');
          console.log(`📊 Total ICE candidates gathered: ${iceCandidates}`);

          // Clean up
          setTimeout(() => {
            testPeer.close();
            console.log('=== Test Complete ===');

            if (iceCandidates === 0) {
              console.warn('⚠️ No ICE candidates gathered - this may indicate network/firewall issues');
              console.warn('Consider checking:');
              console.warn('- Corporate proxy settings');
              console.warn('- Firewall rules blocking WebRTC');
              console.warn('- VPN configuration');
            } else {
              console.log('✅ WebRTC connectivity appears functional');
            }
          }, 1000);
        }
      };

      testPeer.oniceconnectionstatechange = () => {
        console.log(`🔄 ICE connection state: ${testPeer.iceConnectionState}`);
      };

      // Trigger ICE gathering by creating a data channel
      testPeer.createDataChannel('test');
      console.log('✅ Test data channel created');

      // Create offer to trigger ICE gathering
      testPeer.createOffer().then(offer => {
        return testPeer.setLocalDescription(offer);
      }).then(() => {
        console.log('✅ Local description set (ICE gathering should start)');
      }).catch(error => {
        console.error('❌ Error during connection test:', error);
        testPeer.close();
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!iceGatheringComplete) {
          console.warn('⚠️ ICE gathering timeout - may indicate network issues');
          testPeer.close();
          console.log('=== Test Timed Out ===');
        }
      }, 10_000);
    },
  };
  console.info(
    'Scrum Poker debug mode enabled. Run scrumPoker.help() for available commands.',
  );
};

export const createDebugCheatCodeHandler = ({
  enable,
  showToast,
}: {
  enable: () => void;
  showToast: (message: string) => void;
}) => {
  let cheatCodeBuffer = '';

  return (event: KeyboardEvent) => {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.key.length !== 1
    )
      return;
    cheatCodeBuffer = `${cheatCodeBuffer}${event.key.toLowerCase()}`.slice(
      -DEBUG_CHEAT_CODE.length,
    );
    if (cheatCodeBuffer !== DEBUG_CHEAT_CODE) return;
    enable();
    showToast('Developer debug mode enabled for this session');
    cheatCodeBuffer = '';
  };
};
