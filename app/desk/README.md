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
| `SessionView` (the drawer: `compact`, `composerRef`, `onEmptyComposerKey`) | `app/SessionView.tsx` |
| `FileLinkContext` (where a file link in a message goes) | `app/Message.tsx` |
| `colorToHex` (a session's colour as a chest, a rug) | `lib/rowColors.ts` |
| `useShowHidden` (the hub sidebar's own hidden switch) | `app/showPaused.ts` |
| `AccountLoginModal` + `hubLogin`'s rule (default profile = no account id) | `app/loginModals.tsx`, `lib/accountProfiles.ts` |
| `RoutinesModal`, `SessionContextMenu`, `NewSessionWizard`, `ConfirmModal`, `PromptModal` | `app/*` |
| `standaloneViewUrl` (`/view`, `code=1[&line=N]` for source) | `app/fileViews.ts` |
| every action (`respondPermission`, `markSessionRead`, `patchAgentSession`, …) | `lib/api.ts` |

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
  desk.css          everything `dk-`; the drawer's session pane restyles Charon's
                    classes under `.desk .dk-sv`; the session modal keeps Charon's theme
  game/             the board — no React
    model.ts        mood, name, level (= context): derived from a summary, never invented
    layout.ts       model → folders, islands, decks, stations (pure)
    art.ts          every sprite, drawn by code (rows of characters + palette)
    scenery.ts      islands painted once per shape; the water; glows
    game.ts         canvas, scene, camera, input, robots, effects, labels, miniatures
    arcade.ts       the mini-game: pilot, weapons, waves of robots, pickups, score
    audio.ts        the mini-game's music and effects (Web Audio, synthesised)
    forms.ts        the machine's three shapes (glyphs), and the keys of each way of playing
    tps/            the mini-game's 3D phase (three.js, loaded on demand)
      index.ts      the phase: on foot → boarding → a vehicle, one camera throughout
      stage.ts      renderer, world, camera (`Rig`, `blendRig`)
      foot.ts       the board's fight seen from behind the pilot (ground.ts: what it reads)
      combat.ts     the fight around the machine: weapons, robots, waves, its turns
      plane.ts      the seaplane (flight.ts: how it flies, pure)     boat.ts  the gunboat
      tank.ts       the tank                         morph.ts the turn from one shape into another
      machine.ts    the machine itself: one set of parts, three poses, a folded state between
      craft.ts      what a shape is                  run.ts   what the phase asks of the run
      input.ts      keys (by position) and mouse → stick, look, trigger, buttons
      foes.ts       the robots a vehicle fights, and how each does
      world.ts      the board's layout raised into islands, sea, sky
      mainland.ts   the immense island north of them: ground with a relief
      models.ts     every model, as boxes; voxels.ts builds them
      fx.ts         bursts, bullets, flashes      hud.ts  the instruments
  ui/               TopBar, IslandBar, QuestLog, LimitsPanel, AccountSwitch, HeatIcon,
                    Portrait, SessionModal, ArcadeHud, Help
    UnitPanel.tsx   the drawer: UnitHead over UnitSession, inside the host's provider
    UnitHead.tsx    the desk's head: portrait, name, state, account, team, commands
    UnitSession.tsx Charon's SessionView, compact (desk.css § the drawer's session pane)
    drawerHost.ts   what the board lends the drawer: ONE stable object
    fileLinks.ts    file links → `/view` in a new tab, else the path copied
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
which never takes a click — the board picks by position. The zoom moves
along fixed steps (`ZOOMS`: quarter steps up to 2×, wider beyond). Where one
world pixel is a whole number of DEVICE pixels the low-resolution canvas is
shown as is, stretched; in between (1.25×, 1.5× on a plain screen) the frame
is enlarged hard-edged to the next whole size, then drawn reduced, smoothly,
into a canvas that is the stage in device pixels, shown 1:1 (`Game.present`)
— even pixels, not the uneven ones of a plain stretch, and nothing for the
browser's compositor to resample.

### One island at a time

The stage shows a **scene** (`Game.setScene`): one island, or the map. Only the
scene is drawn, picked, labelled and animated — a beat on another island moves
its robot's state and plays nothing.

- **Framing** (`Game.frame`): the island is centred in what the HUD leaves free
  (`setSafeArea`: under the two top rows, right of the open quest log), at the
  largest zoom step that holds it, never below a readable one — an island too
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

### What a click picks

On an island, only two things answer a click (`Game.pickAt`, the pointer says
so): **a robot**, which selects it, and **a "+"**, which opens the new-agent
wizard. A deck, the grass, the water are nothing to select: a click there lets
go of the selected robot.

- **A deck's free console** (`plot.slot`): the last place of every deck — a
  dim console nobody sits at, a "+" on its screen. The wizard opens on that
  machine and that folder; the robot appears there.
- **The deck being built** (`island.site`; on an islet, a first plank): a new
  folder on that machine. `N` does the same for the island on stage — or
  beside the selected robot, in its folder.

### Teams

A session and its sub-sessions (`parentSessionId`) stand together, nested the
way the sidebar nests them (`nestSubSessions`: a sub-session on its parent's
deck, whatever its own directory; a grandchild in its root's team). No line
between them — the ground says it:

- **one rug** in the team's colour (`teamTint`: the lead's own colour, else
  one picked by its id) under the whole block;
- **the lead** centred at the head of it, raised on a dais, a mast with a
  pennant at its corner;
- **its crew** in rows of three in front of it.

Pointing at or selecting one of them lights the rug's edge. In the drawer,
`▲` is the robot it works for and `▼` the ones that work for it: each goes
there.

| A robot… | means |
| --- | --- |
| stands beside its console | idle |
| is at its console, holo screen lit | a turn runs; the icon and its colour are the tool family (`toolFamily`) |
| has `!` over its head | a blocking gate: permission, question, plan |
| has `?` | an async question |
| has `✓` | finished, unread |
| has `✖`, smokes | failed turn or crashed session |
| sits, dark | asleep |
| stands beside its console, circled by drones | its turn is over, background tasks still run: one drone each |

**Nothing is written under a working robot**: the holo screen's icon says the
kind of action, the unit panel the command. A deck of command lines is
unreadable.

The **brazier** at the end of a console is the session's prompt cache
(`sessionCacheReading`): once the turn is over, a flame as tall as the cache
has life left (shrinking a pixel at a time, its colour deepening by quarter of
the TTL like the sidebar's); a dark bowl while a turn runs (its cache is warm
by definition) or once it is cold — cold is the absence of fire, nothing else
is drawn. No brazier when the provider
reports no cache. Beside the name, the time a warm cache has left.

The beacon takes the colour of what its island most needs; it blinks red when
the machine's agent is unreachable. The number before a name is the level: the
session's context, one level per 100k tokens (`promptCache.promptTokens`:
0–100k is level 0), `–` while there is no reading. Under a selected robot's
portrait, hovering the level explains it with that robot's numbers.

## The HUD

- **Top bar**: one counter per state across the fleet (a click visits the next
  robot in it, on its island), the warm caches (a click goes to the one that
  goes cold first), zoom, the eye (Charon's hidden switch: on = only hidden
  robots, as in the sidebar) — and the mini-game's `PLAY` button with its best
  score.
- **Limits** (foot of the left column, always there): one row per hub account,
  its rate-limit windows as gauges — how full, the pace mark, when it empties,
  how many robots run on it. Folded, it keeps each account's fullest window.
- **Island selector**: the map, one card per inhabited machine, the empty
  machines behind `+N` (their islet has a "+": its first agent).
- **The tab**: its favicon and title wear the number of sessions that want
  you (finished or failed unread, waiting on an answer) — Charon's own
  `TabNotificationBadge`, by `attentionForRow`, like the hub's tab.
- **Quests**: every pending gate and every unread finish, oldest first within
  blocking → async → failed → done. A permission is answered in place
  (pessimistic: the card leaves when the summary says the gate is gone); a
  question, a plan, an async question: "Answer" selects the robot, its card is
  in the drawer.
- **The robot's drawer** (a robot is selected; `ui/UnitPanel.tsx`): on the
  right, under the two top rows. The desk's **head** (`ui/UnitHead.tsx`), then
  **Charon's session view in compact form** (`ui/UnitSession.tsx`). The board
  keeps the selected robot clear of it (`Game.reveal`), and goes back once
  nothing is selected; on a narrow screen the drawer lies at the foot instead.
  - **The head**: portrait (chest in the session's colour) and level, name,
    state and turn clock, @handle; one line with its account chip, machine and
    folder; its team line (`▲` lead, `▼` crew) if it has one; ONE row of
    commands — Open ⏎, Got it R, Stop X, Sleep/Wake, ⋯ (the session menu).
    The account chip moves the robot to another account of the same provider
    (Charon's switch: a restart, the same conversation).
  - **The session** is `<SessionView compact>`, the hub's own: model and effort
    cells, the context row, the transcript (no tools), the bars (thinking,
    background tasks, schedules, goal), the gate cards, and the composer with
    its mode chip, `/` and `@` menus, aside, attachments. One stream, one
    draft (`useInputDraft`: a robot holding one wears a pencil), Charon's
    rules throughout: asleep ⇒ its Resume in the composer's place; acting in
    the drawer reads a finished robot (§14.47); a file dropped anywhere
    attaches to the selected robot. `compact` = no Tools panel, header
    unfolded, no composer grip; the drawer's CSS hides the title row and the
    usage cell. An empty composer: Enter opens the full view, Tab the next
    robot.
  - **Its hosts** (`ui/drawerHost.ts`): a peer's @handle or a team chip goes
    to that robot (its island; else its full view; a fork just made, once it
    lands); "Sign in" opens Charon's login for that session's account;
    `/clear` the new-agent wizard; `/routine` Charon's Routines; `/diff` and
    `/mcp` the full view; `/shell` is refused (no terminal here).
  - **File links** (`FileLinkContext`, `ui/fileLinks.ts`) open `/view` in a
    new tab — rendered if the file has a view, else read-only source at the
    cited line (`code=1&line=N`); a path outside an absolute root is copied.
- **Feed**, bottom right — and the minimap, only while the scene is larger
  than the stage.

Keys are listed in the help overlay (`?`).

## The mini-game

`PLAY` (or `G`) starts an arena shooter on the island on stage
(`game/arcade.ts`): a helicopter brings a pilot, who slides down its rope. The
island's robots are at their work and go on with it — they harm no one —
until the pilot attacks one (`Arcade.stir`): then they turn on the pilot, the
nearest first, and more land by pod, wave after wave — a boss every fifth. Weapons and
bonuses are picked up; a combo multiplies the score; the best one is kept
(`localStorage desk.arcade.best`) and always shown in the top bar.

- **It is a toy.** It plays with copies of the board's sprites: it never reads
  or writes a session, sends nothing, and the fleet's counters stay on screen
  — a real robot may need you mid-run.
- **The keys are always on screen**, in a panel on the right
  (`ui/ArcadeHud.tsx § Keys`, `forms.ts § keyHints`): keys as keys, the mouse
  as a mouse, one word each, the shapes as their glyphs — for the way the run
  is played right now (board, on foot, each shape), named as THIS keyboard
  names them.
- **The mouse does the shooting, everywhere**: the left button fires, the
  right one brings the view closer for as long as it is held, F is the
  special weapon (the bomb on foot, a missile in the machine). No key fires.
  On the board the cursor is the sight (`ArcadeHost.at`): the pilot aims at
  what is under it, and the closer view is a whole zoom step (pixels stay
  whole) leaning toward it.
- The run owns the keys (`Arcade.key`), the
  board's own text and panels step aside (`.is-arcade`). It also owns the
  camera: `frame`/`zoomBy`/`reveal` are no-ops until `stopArcade`. On the 3D
  stage the mouse is the game's: captured as the stage comes up (a browser
  wants a gesture: every key and click asks again until it is given), it
  turns the view. Esc — or another window — frees it and the fight waits
  (`PAUSED`); a key or a click takes it back. Where it cannot be captured,
  the side it is on turns the view.
- The engine swaps its step and its drawing for the run's (`stepArcade`,
  `drawArcade`); the island stays as scenery. The board is held as it was
  for the whole run: a model that comes in meanwhile is applied at its end
  (`Game.setModel`). A scene change ends the run.
- The overlay (`ui/ArcadeHud.tsx`) only reads `arcadeStore`, published about
  ten times a second; on the 3D stage the instruments are the phase's own
  canvas (`tps/hud.ts`), drawn every frame.
- **After the first wave the fight is seen from behind the pilot**
  (`game/tps`): the SAME fight, still run by `arcade.ts` — the 3D stage only
  shows it (`foot.ts` reads it through `GroundPort`) and turns the keys round
  the pilot's heading. The eye starts right over the board's own view, lens
  long, north up, so the first 3D picture IS the 2D one; it holds while the
  stage fades in, then comes down behind the pilot (`blendRig`: it swings
  round what it looks at, the framing changing at a steady rate). No cut.
- **A wave later the vehicles come** (`Tps.deliver`, `VEHICLES READY`): a
  seaplane moored off the south shore, a gunboat off the east, each with a
  ring to walk into, shown by arrows — one bouncing over the ring in the
  world, one in the instruments (on the rim of the frame when the vehicle is
  out of it, with its badge and how far). In the ring the pilot hops aboard
  and the fight goes on in the air or on the water (`combat.ts`) on the same
  stage, in the same world — the wave under way goes with it: what stood on
  the island follows (`FOLLOW`), what it had not sent yet comes as robots a
  vehicle fights, the whole within what that wave is worth to a vehicle. One
  way: the pilot does not get out — the machine changes shape instead.
  - The seaplane flies like a plane (`flight.ts`): the mouse flies it (the
    nose follows the cursor; the arrows are a stick), W / S move the
    throttle, A / D the rudder (the nose swings, wings level, and the cursor
    stops banking it while they are held). A climb costs speed; under the
    stall the wings let go and it FALLS. Cannon, locked missiles, a barrel
    roll that dodges, an afterburner.
  - The gunboat: engine and rudder on the keys, the mouse turns the view and
    the turret with it; flares throw missiles off.
  - The tank: W / S drive, A / D turn the hull (on the spot too), the mouse
    turns the view and the guns whatever the hull does; heavy guns whose
    shells burst (`craft.ts § CANNON`).
  - Their robots (`foes.ts`): drones, robots on jetpacks and on wings,
    gunships; skimmers, mines, a warship; robots on foot and a walking gun on
    the mainland; a dreadnought on boss waves. None passes through the land,
    the sea or a tower (`settle`).
- **The machine is ONE machine in three shapes** (`forms.ts § Form`) and
  turns from one into the other without a cut (`Combat.shift`, `morph.ts`):
  - by where it goes: a plane that touches the sea becomes the boat, one
    that lands on the mainland the tank (too hard a landing costs hull; an
    island of the archipelago is still a crash); a boat that runs onto the
    mainland's beach becomes the tank; a tank that wades out, the boat;
  - on T, from the boat or the tank: into the air.
  The machine is ONE body (`machine.ts`): the same parts — fuselage, wings,
  floats and their soles, tail, canopy, guns… — put together three ways.
  The boat is the fuselage down on the water between its floats, the wings
  swept back and stood up as its sides, the canopy raised into a wheelhouse,
  the guns on a turret forward; the tank is the floats let down as tracks
  (soles on the ground, wheels showing between), the wings laid over them as
  skirts, the guns run out long. A turn (`morph.ts`, `Machine.blend`) is
  those parts folding into a state common to all three, then unfolding into
  the next shape, each in its own time — nothing appears, vanishes or
  changes colour — while the machine goes on its way. The next shape (a
  `Craft`) exists from the first frame, held where the turning machine is
  (`Craft.hold`), and is what the eye and the robots follow; it is the
  pilot's when the last part seats (`release`).
- **The mainland** (`mainland.ts`): an immense island north of the
  archipelago, straight ahead of the pilot who lands — beaches all round,
  forests, a mountain spine. Ground with a relief (a grid of heights; the
  tank rides the very triangles that are drawn). A badge on the rim of the
  frame points to it while the machine is not on it.
- **The fight follows the shape** (`combat.ts`): a wave is drawn up from the
  pool of the shape the machine has then (`POOLS`); a robot whose element the
  machine has left far behind takes to the air after it (`AIRBORNE`); what
  circles, circles where the fight is, not the home island.
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
