# The desk — the fleet as a game board

`/desk` draws every Charon session as a robot on an archipelago: who works, on
what, who waits on you, who finished unread — and lets you answer, order, stop,
wake or recruit without leaving the board. It shows **one island (one machine)
at a time**, framed to fill the stage; a selector travels between them.

## The dependency points one way

**The desk depends on Charon; Charon does not depend on the desk.** Nothing
outside `app/desk/` imports it. Delete the folder and only these point nowhere:
the two `/desk` links in `app/HubPanel.tsx`, the page (`web/desk.*`,
`server/http/pages.ts § deskPage`) and the activity digest below.

What exists in Charon is **imported, never copied**:

| The desk uses | Defined in |
| --- | --- |
| `attentionForRow`, `rowStatus`, `isLiveRow` | `lib/sessionAttention.ts` |
| `sessionCacheReading`, `cacheTipLines` (the prompt cache's one rule and its words) | `lib/promptCache.ts` |
| `usageCells`, `sevClass`, `paceFraction` (the usage widget's own gauges) | `app/usageGauges.ts` |
| `useAccounts()` (hub accounts and their readings) | `app/accountsStore.ts` |
| `accountSwitchWaitOf`, `accountSwitchWaitText`, `accountLoad` (when a session may change account, which one first) | `app/UsageAccountSwitch.tsx` |
| `isWorkingStatus` | `app/sessionUnread.ts` |
| `useSessionList()`, `useVpsRuntime()`, `addOverlay` | `app/sync/summaryStore.ts` |
| `sidebarPathKey` (a deck = a sidebar path group) | `app/sidebarPathGroups.ts` |
| `canSleepSession`, `canResumeSession` | `app/sessionBulkActions.ts` |
| `SessionView`, `SessionContextMenu`, `NewSessionWizard`, `ConfirmModal`, `PromptModal` | `app/*` |
| every action (`respondPermission`, `sendSessionInput`, `markSessionRead`, …) | `lib/api.ts` |

Every state a robot shows goes through `game/model.ts § moodOf`, which only
asks those predicates: a robot can never say "needs you" while the sidebar says
"working".

## What each session is doing: `session_activity`

Tool calls, thinking and assistant text are focus-routed (CLAUDE.md §14.16): a
page watching the whole fleet receives none of them. So the hub folds them
(`lib/server/hub/sessionActivity.ts`, fed from `sessionOps § _emitBroadcast`)
into one small state per session and publishes it LOW as
`{type:'session_activity', sessionId, activity}` (`lib/sessionActivity.ts`):

- rate-capped (a tool beat per 200 ms, a text beat per 1.8 s, per session);
- **only while a desk watches**: `GET /api/desk/activity` is the snapshot a
  fresh desk paints from AND the heartbeat (`markWatched`) that keeps the
  frames coming — nobody on the desk, no frame;
- never from a replay, never persisted.

## Files

```
app/desk/
  Desk.tsx          React shell: stores, SSE, scene, keyboard, actions, modals
  activityStore.ts  per-session activity for the panels
  islands.ts        the selector's list (one entry per machine), the opening island
  quests.ts         what waits on the user, in order
  arcadeStore.ts    the mini-game's HUD readings and best score
  sound.ts          the board's four synthesised cues, off by default
  desk.css          everything `dk-`; the session modal keeps Charon's theme
  game/             the board — no React
    model.ts        mood, name, level (= context): derived from a summary, never invented
    layout.ts       model → folders, islands, decks, stations (pure)
    art.ts          every sprite, drawn by code (rows of characters + palette)
    scenery.ts      islands painted once per shape; the water; glows
    game.ts         canvas, scene, camera, input, robots, effects, labels, miniatures
    arcade.ts       the mini-game: pilot, weapons, waves of robots, pickups, score
    audio.ts        the mini-game's music and effects (Web Audio, synthesised)
    tps/            the mini-game's 3D phase (three.js, loaded on demand)
      index.ts      the phase: on foot → boarding → a vehicle, one camera throughout
      stage.ts      renderer, world, camera (`Rig`, `blendRig`)
      foot.ts       the board's fight seen from behind the pilot (ground.ts: what it reads)
      combat.ts     the fight around a vehicle: weapons, robots, waves
      plane.ts      the seaplane (flight.ts: how it flies, pure)     boat.ts  the gunboat
      craft.ts      what a vehicle is                run.ts   what the phase asks of the run
      input.ts      keys (by position) and mouse → stick, look, trigger, buttons
      foes.ts       the robots a vehicle fights, and how each does
      world.ts      the board's layout raised into islands, sea, sky
      models.ts     every model, as boxes; voxels.ts builds them
      fx.ts         bursts, bullets, flashes      hud.ts  the instruments
  ui/               TopBar, IslandBar, QuestLog, LimitsPanel, UnitPanel,
                    AccountSwitch, HeatIcon, Portrait, SessionModal, ArcadeHud, Help
```

## The board

- a **folder** of Charon's sidebar = a stretch of water with its name (map only);
- a **machine** = an island with a beacon; a machine without a session is an
  islet;
- a **working directory** = a wooden deck (`sidebarPathKey`);
- a **session** = a station on that deck, 3×4 tiles: a band for its marker, the
  robot and its console, a band for its name. The robot never leaves its
  station: position is identity.

One low-resolution canvas (CSS size ÷ zoom), shifted by the sub-pixel remainder
for smooth scrolling; names and captions are DOM text on top (`.dk-labels`),
which never takes a click — the board picks by position. A zoom is **crisp**:
one world pixel is a whole number of DEVICE pixels (so 1.5× exists on a dense
screen, not on a plain one).

### One island at a time

The stage shows a **scene** (`Game.setScene`): one island, or the map. Only the
scene is drawn, picked, labelled and animated — a beat on another island moves
its robot's state and plays nothing.

- **Framing** (`Game.frame`): the island is centred in what the HUD leaves free
  (`setSafeArea`: under the two top rows, right of the open quest log), at the
  largest crisp zoom that holds it, never below a readable one — an island too
  big for that opens on its top-left corner, and the minimap appears. Islands
  are packed wide on purpose (`layout.ts § pack`): they are looked at alone, on
  a wide stage. The framing follows resizes and the HUD until the user moves
  the camera; `F` frames again.
- **The desk opens** on the island visited last (`localStorage desk.scene`),
  else on the one that most wants you (`islands.ts § homeIsland`).
- **Travelling**: the selector's cards, `1…9`, `PageUp`/`PageDown`, `M` (map
  and back), and anything that goes to a robot — a quest, a counter, `Tab`, a
  feed line (`Desk.tsx § visit`). The camera slides in from the side the island
  is on in the selector.
- **Elsewhere stays visible**: each card carries its island's live miniature
  (`attachThumb`) and counts, and pulses when a robot there waits on you; the
  quest log and the counters are fleet-wide.
- **The map** is a way to choose: a click on an island goes there.

| A robot… | means |
| --- | --- |
| stands beside its console | idle |
| is at its console, holo screen lit | a turn runs; the icon and its colour are the tool family (`toolFamily`) |
| has `!` over its head | a blocking gate: permission, question, plan |
| has `?` | an async question |
| has `✓` | finished, unread |
| has `✖`, smokes | failed turn or crashed session |
| sits, dark | asleep |
| is circled by drones | one per running background task |

**Nothing is written under a working robot**: the holo screen's icon says the
kind of action, the unit panel the command. A deck of command lines is
unreadable.

The **brazier** at the end of a console is the session's prompt cache
(`sessionCacheReading`): a flame as tall as the cache has life left (full while
a turn keeps it alive, shrinking a pixel at a time, its colour deepening by
quarter of the TTL like the sidebar's), and a dark bowl once it is cold — cold
is the absence of fire, nothing else is drawn. No brazier when the provider
reports no cache. Beside the name, the time a warm cache has left.

The beacon takes the colour of what its island most needs; it blinks red when
the machine's agent is unreachable. The number before a name is the level: the
session's context, one level per 100k tokens (`promptCache.promptTokens`:
0–100k is level 0), `–` while there is no reading. Under a selected robot's
portrait, hovering the level explains it with that robot's numbers.

## The HUD

- **Top bar**: one counter per state across the fleet (a click visits the next
  robot in it, on its island), the warm caches (a click goes to the one that
  goes cold first), zoom — and the mini-game's `PLAY` button with its best
  score.
- **Limits** (foot of the left column, always there): one row per hub account,
  its rate-limit windows as gauges — how full, the pace mark, when it empties,
  how many robots run on it. Folded, it keeps each account's fullest window.
- **Island selector**: the map, one card per inhabited machine, the empty
  machines behind `+N` (their islet offers "recruit").
- **Quests**: every pending gate and every unread finish, oldest first within
  blocking → async → failed → done. A permission is answered in place
  (pessimistic: the card leaves when the summary says the gate is gone).
- **The robot's drawer** (a robot is selected; `ui/UnitPanel.tsx`): on the
  right, under the two top rows. From the top: its head; where it runs and its
  cache; **its conversation**; what it is doing or waits for; its commands; an
  order at the foot. The board keeps the selected robot clear of it
  (`Game.reveal`), and goes back once nothing is selected; on a narrow screen
  the drawer lies at the foot instead.
  - **The conversation** (`ui/UnitTalk.tsx`) is the one part that scrolls:
    the messages and no tool, the last one at the foot (its recap under it, as
    in Charon), the answer being written streaming in, older ones on the way
    up. On its side, Charon's pills: ↑ lands on the top of the last message,
    then walks up the agent's messages (`app/chatScroll.ts`); ↓ comes back to
    the foot. It is Charon's transcript — `useSessionStream` in its `conversation`
    view, `Message` bubbles — so a selected robot is FOCUSED like an open
    session: leaving it reads its finish (§14.47).
  - Its **account** is a chip: the list under it moves the robot to another
    account of the same provider (Charon's switch: a restart, the same
    conversation; it waits for a running turn or background tasks).
  - **The order** (`ui/UnitOrder.tsx`) IS the session's composer draft
    (`useInputDraft`): it waits for its robot across selections, islands and
    the full session view, and a robot holding one wears a pencil. Selecting a
    robot puts the caret in it (not on a touch screen); Esc gives the keys
    back. An image pasted (or a file dropped) in it is attached the way
    Charon's composer does it (`useSessionAttachments`): uploaded beside the
    session's code, its path spliced at the caret; nothing is sent while one
    is on its way.
- **Feed**, bottom right — and the minimap, only while the scene is larger
  than the stage.

Keys are listed in the help overlay (`?`).

## The mini-game

`PLAY` (or `G`) starts an arena shooter on the island on stage
(`game/arcade.ts`): a helicopter drops a pilot, the island's robots turn on
them, then more land by pod, wave after wave — a boss every fifth. Weapons and
bonuses are picked up; a combo multiplies the score; the best one is kept
(`localStorage desk.arcade.best`) and always shown in the top bar.

- **It is a toy.** It plays with copies of the board's sprites: it never reads
  or writes a session, sends nothing, and the fleet's counters stay on screen
  — a real robot may need you mid-run.
- **On the board, keyboard only**: the run owns the keys (`Arcade.key`), the
  board's own text and panels step aside (`.is-arcade`). It also owns the
  camera: `frame`/`zoomBy`/`reveal` are no-ops until `stopArcade`. On the 3D
  stage the mouse joins in: a click captures it (Esc frees it), it then turns
  the view; free, the side it is on does.
- The engine swaps its step and its drawing for the run's (`stepArcade`,
  `drawArcade`); the island stays as scenery. The board is held as it was
  for the whole run: a model that comes in meanwhile is applied at its end
  (`Game.setModel`). A scene change ends the run.
- The overlay (`ui/ArcadeHud.tsx`) only reads `arcadeStore`, published about
  ten times a second; on the 3D stage the instruments are the phase's own
  canvas (`tps/hud.ts`), drawn every frame.
- **After the third wave the fight is seen from behind the pilot**
  (`game/tps`): the SAME fight, still run by `arcade.ts` — the 3D stage only
  shows it (`foot.ts` reads it through `GroundPort`) and turns the keys round
  the pilot's heading. The eye starts right over the board's own view, lens
  long, north up, so the first 3D picture IS the 2D one; it holds while the
  stage fades in, then comes down behind the pilot (`blendRig`: it swings
  round what it looks at, the framing changing at a steady rate). No cut.
- **A wave later the vehicles come** (`Tps.deliver`, `VEHICLES READY`): a
  seaplane moored off the south shore, a gunboat off the east, each with a
  ring to walk into. In the ring the pilot hops aboard and the fight goes on
  in the air or on the water (`combat.ts`) on the same stage, in the same
  world — the wave under way goes with it: what stood on the island follows
  (`FOLLOW`), what it had not sent yet comes as robots a vehicle fights. One
  way for now: no getting out.
  - The seaplane flies like a plane (`flight.ts`): the stick banks and
    pitches, a climb costs speed, too slow stalls; the mouse flies it (the
    nose follows it) or the keys do. Cannon, locked missiles, a barrel roll
    that dodges, an afterburner.
  - The gunboat: engine and rudder on the keys, the mouse turns the view and
    the turret with it; flares throw missiles off.
  - Their robots (`foes.ts`): drones, robots on jetpacks and on wings,
    gunships, skimmers, mines, a warship, a dreadnought on boss waves. None
    passes through the land, the sea or a tower (`settle`).
- The world is the board's own layout raised in 3D (`tps/world.ts`: the same
  islands, decks and beacons, `SCALE` world units per board pixel), drawn at a
  low resolution scaled in whole pixels, every model made of boxes — the
  robots are the board's sprites given a depth (`art.ts § robotPixels`).
  Vehicle keys are read by POSITION so any layout works. The run itself —
  score, combo, waves, record, sound — stays in `arcade.ts` (`TpsRun`). The
  phase is a lazy chunk: where it cannot load, or without WebGL, the waves
  stay on the board. Once the vehicles were reached, a run may start there
  (`C` on the end screen).
- **Its sound** (`game/audio.ts`) is synthesised — no file, nothing fetched,
  and the tune is the module's own. Effects are layered (a crack, a body, a
  tail), vary a little each time and sit left or right of the pilot by where
  they happen: a sound per weapon, metal hits, robots powering down, blasts,
  pods whistling down, the helicopter's rotor, a heartbeat on the last heart.
  The music is a step sequencer whose layers follow the fight (the drop, a
  wave, a crowded one, a boss, the lull, the end) and steps aside under a
  blast. `M` goes music + effects → effects → off (`localStorage
  desk.arcade.audio`, on by default: PLAY is a deliberate act); the board's
  own cues keep their separate switch. It lives for the run: built by the key
  or click that starts one, closed when it ends, suspended in a hidden tab.

## Verifying

No unit test: the board is checked in a real browser, on an ISOLATED hub (own
port, demo database, `CHARON_DISABLE_AUTOCONNECT=1`), through `navig`. The
engine takes a plain model (`DeskModel`), so a standalone page can mount
`Game` with fake sessions to look at sprites and layout without a hub.
