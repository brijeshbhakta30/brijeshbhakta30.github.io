# Scrum Poker Architecture

These diagrams describe the current Scrum Poker implementation under
`src/scripts/scrumPoker`. They reflect the code structure as implemented, not a
target architecture.

## Module Architecture

```mermaid
flowchart TD
  Page["scrum-poker.astro"] --> Dom["dom.ts"]
  Page --> Index["index.ts"]

  Index --> Actions["actions.ts"]
  Index --> Timers["timers.ts"]
  Index --> Presence["presence.ts"]
  Index --> Room["roomController.ts"]
  Index --> Render["render.ts"]
  Index --> Network["network.ts"]
  Index --> Debug["debug.ts"]

  Room --> Storage["storage.ts"]
  Room --> State["state.ts"]
  Room --> Actions
  Room --> Timers
  Room --> Presence

  Timers --> Actions
  Timers --> State
  Timers --> Render

  Presence --> Actions
  Presence --> State
  Presence --> Network

  Actions --> State
  Actions --> Storage
  Actions --> Network

  Render --> State
  Network --> State
  Network --> Topology["topology.ts"]
```

## Room Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Setup: page load
  Setup --> ProfileDialog: room URL without saved name
  ProfileDialog --> Setup: close or cancel
  ProfileDialog --> StartingRoom: save profile for room URL
  Setup --> StartingRoom: create or join form submit

  StartingRoom --> InRoom: startRoom
  InRoom: room UI visible
  InRoom: room timers active
  InRoom: presence heartbeat active
  InRoom: PeerJS network started

  InRoom --> Setup: Leave room
  Setup: room UI hidden
  Setup: room timers stopped
  Setup: presence heartbeat stopped
  Setup: PeerJS network destroyed

  InRoom --> StartingRoom: join another room
  InRoom --> Disposed: astro:before-swap
  Setup --> Disposed: astro:before-swap
  Disposed --> [*]
```

## Action And Voting Flow

```mermaid
sequenceDiagram
  participant UI as UI controls
  participant Index as index.ts
  participant Actions as actions.ts
  participant State as state.ts
  participant Network as network.ts
  participant Render as render.ts

  UI->>Actions: card, reveal, reset, config event
  Actions->>Actions: makeAction(type, payload)
  Actions->>Actions: increment logical clock
  Actions->>Actions: dispatchAction(action)
  Actions->>State: applyRoomAction(current, action)
  State-->>Actions: next RoomState
  Actions->>Network: relay action when local
  Actions->>Render: render current state

  Network-->>Actions: processAction(remote action, false)
  Actions->>State: merge action by clocks
  Actions->>Render: render current state

  Actions->>Actions: publishLocalVote on first reveal
  Actions->>Network: relay revealed local vote
```

## Networking And Topology Flow

```mermaid
flowchart TD
  Start["network.start"] --> Peer["create PeerJS room peer"]
  Peer --> PeerOpen["peer open: local peer id assigned"]
  PeerOpen --> RegistryConnect["connectToRegistry"]
  PeerOpen --> ElectionTimer["schedule registry election if no registry responds"]

  RegistryConnect --> Discover["send discover identity"]
  Discover --> Welcome["registry welcome or directory"]
  Welcome --> Remember["remember participants"]
  Welcome --> AcceptTopology["acceptTopology"]
  AcceptTopology --> Ensure["ensureTopologyConnections"]

  ElectionTimer --> Claim["claimRegistry"]
  Claim --> RegistryPeer["registry peer open"]
  RegistryPeer --> Directory["broadcastDirectory"]
  Directory --> Coordinator["updateTopologyIfCoordinator"]

  Coordinator --> Choose["chooseCoreTopology"]
  Choose --> Publish["publishTopology"]
  Publish --> Ensure

  Ensure --> Desired["desiredTopologyPeers"]
  Desired --> Connect["connectToPeer"]
  Connect --> Direct["direct hello, snapshot, topology, relay messages"]
  Direct --> Render["render and publish core load"]
```

## Fallback And Recovery Paths

```mermaid
flowchart TD
  NetworkIssue["connection issue"] --> Diagnostics["attachDiagnostics records state"]
  Diagnostics --> Failed{"failed or stuck disconnected?"}
  Failed -->|yes| ScheduleReconnect["scheduleReconnect"]
  Failed -->|no| Continue["keep current connection"]

  ScheduleReconnect --> Close["close connection"]
  Close --> ReconnectTimer["retry after delay"]
  ReconnectTimer --> Ensure["ensureTopologyConnections"]
  ReconnectTimer --> Coordinator["updateTopologyIfCoordinator"]

  RegistryLost["registry close, error, timeout, unavailable"] --> Release["releaseRegistryConnection"]
  Release --> Election["scheduleRegistryElection"]
  Election --> Claim["claimRegistry"]
  Claim -->|unavailable id| RegistryRetry["connectToRegistry after delay"]
  Claim -->|other error| Election

  BrowserResume["visibility, pageshow, online"] --> Presence["announcePresence"]
  BrowserResume --> RegistryRetry
  BrowserResume --> Ensure

  Leave["Leave room or page swap"] --> StopTimers["stop timers and presence heartbeat"]
  StopTimers --> Destroy["network.destroy"]
  Destroy --> IgnoreLateEvents["disposed guards ignore late network callbacks"]
```
