# Garden Companion

Garden Companion is a public userscript for Magic Garden. It adds information,
alerts, room browsing, pet team shortcuts, and deliberate click or keypress
actions. It does not perform unattended gameplay.

## Features

- Detailed garden overview with growth, value, mutation progress, granter estimates, plant focus, tracked species, zoom, a global keybind, and completion alarms
- Pet team creation, editing, deletion, activation, pet filtering, and global team keybinds
- Active pet dashboard with correctly mutated game sprites, hunger bars, combined ability effects, proc chances, and estimated time until maximum strength
- Pet ability history with selectable tracking filters and up to 100 records per ability
- Per-ability pet notification and sound silencing, generated from the latest captured game bundle
- Joinable public room browser for rooms with four or five players, with five-player rooms listed first
- Searchable shop alarms grouped into Seeds, Dawn, Thunder, Snow, Eggs, Tools, and Decor tabs
- Shop alarm item icons, explicit Buy all and Stop buttons, persistent siren audio, and queued alerts when several items trigger together
- Crop values and pet-adjusted crop or egg growth estimates displayed inside the game's native garden information card
- Plant drag movement by holding, dragging, and releasing a plant, consuming planter pots
- Spacebar instant harvest for mature Gold or Rainbow crops
- Configurable global keybinds for Garden Companion, Garden Overview, the weather station, and the seed, egg, and tool shops
- Duplicate keybind prevention across Garden Companion and Garden Overview
- UTC lunar-event countdown with a settings button and WebSocket health indicator
- Clickable script update status and installer link
- Configurable background operation and automatic game-update refresh
- Dark, non-dimming windows that preserve scrolling during live updates
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
