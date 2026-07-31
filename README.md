# Garden Companion

Garden Companion is a public userscript for Magic Garden. It adds information,
alerts, room browsing, pet team shortcuts, and deliberate click or keypress
actions. It does not perform unattended gameplay.

## Features

- Detailed garden overview with growth, value, mutation progress, granter estimates, plant focus, tracked species, keybind, and completion alarms
- Pet team creation, editing, deletion, activation, and global team keybinds using the games native teams, with a full-window pet chooser showing sprites, abilities, and locations, plus letter, icon, and pet emblems saved to the games own team UI
- Active pet dashboard with game sprites, hunger bars, combined ability effects, proc chances, estimated time until maximum strength, and XP potions required to reach it
- Pet ability history with selectable tracking filters which show the last 100 records per ability
- Per-ability pet notification and sound silencing
- Joinable public room browser for rooms with four or five players, showing each players Discord profile picture
- Searchable shop alarms grouped into Seeds, Dawn, Thunder, Snow, Eggs, Tools, and Decor tabs
- Shop alarm item icons, explicit Buy all and Stop buttons, persistent siren audio, and queued alerts when several items trigger together
- Crop values and pet-adjusted crop or egg growth estimates (Turtle-Timer)
- Pet food buttons docked beside the games own pet panel, one per active pet, with per-species preferred foods, held produce counts on each food icon, one-click feeding, and automatic hiding while a pet card is open
- Plant drag movement by holding, dragging, and releasing a plant, consumes planter pot on each successful move
- Instant harvest - Spacebar triggers instant harvest for mature Gold or Rainbow crops (Default OFF)
- Configurable global keybinds for Garden Companion, Garden Overview, weather station, seed, egg, and tool shops
- UTC lunar-event countdown with a settings button and WebSocket health indicator
- Configurable background operation and automatic game-update refresh
- One options panel for feature toggles, interface shortcuts, pet tools, alerts, rooms, and tracking

## Install

For a release build, run:

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

Then install `dist/garden-companion.user.js` in Tampermonkey or another
compatible userscript manager. The compiled distribution file is JavaScript;
all maintained implementation code in `src/` is TypeScript.

The update indicator checks the published userscript version and becomes
clickable when a newer build is available. The published raw URL must exist at
the location declared in the userscript metadata before this can work.

Game client updates are detected from WebSocket close code 4710 or the game's
update dialog. Automatic refresh waits five seconds and can be disabled in the
options. Background mode keeps the game-visible state active and starts a
near-silent audio context after the first user interaction. It can also be
disabled, with changes taking effect after a reload.

Plant drag movement, crop and egg estimates, and instant harvest can be enabled
or disabled without reloading. Background mode changes apply after a reload.
When recording a keybind, press Escape to cancel or clear it. Assigning an
existing key to a new action clears its previous assignment.

The build extracts the current ability catalog from the latest captured game
bundle and bundles the project into one userscript with esbuild. No external
userscript or vendored JavaScript is concatenated into the output.

The shared game-state and command models are declared in `src/types.ts`, and
the complete source tree is checked by TypeScript before release builds.

## Safety model

Commands that change game state are only sent from a visible button, a configured
keybind, the drag gesture, or the instant-harvest keypress.

Garden Companion does not automatically purchase shop items. A shop alarm only
sends purchase requests after the user presses its Buy all button.
