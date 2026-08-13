import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateCelestialLayout, type CelestialSpecies } from '../src/celestial-layout.js';

const root = resolve(import.meta.dirname, '..');
/**
 * Git checks these files out with CRLF on Windows, so every assertion written with \n would fail
 * depending on whether a file was last written by an editor or by git. Sources are normalised on
 * the way in and the assertions stay readable.
 */
async function readSource(...parts: string[]): Promise<string> {
  return (await readFile(resolve(root, ...parts), 'utf8')).replace(/\r\n/g, '\n');
}
const built = await readSource('dist', 'garden-companion.user.js');
// The panel is being split out of companion.ts a piece at a time. Assertions about panel behaviour
// run against every module that makes up the panel so that moving code between them is not a test
// failure; companion.ts stays first so the slice(indexOf(...)) assertions below keep their order.
const companionSource = (await Promise.all([
  ['src', 'companion.ts'],
  ['src', 'constants.ts'],
  ['src', 'config.ts'],
  ['src', 'state.ts'],
  ['src', 'utils.ts'],
  ['src', 'page.ts'],
  ['src', 'toast.ts'],
  ['src', 'alarms.ts'],
  ['src', 'ability-chips.ts'],
  ['src', 'game-connection.ts'],
  ['src', 'pets.ts'],
  ['src', 'pixi.ts'],
  ['src', 'mutation-value.ts'],
  ['src', 'quinoa-engine.ts'],
  ['src', 'features', 'crop-estimates.ts'],
  ['src', 'features', 'calculators.ts'],
  ['src', 'features', 'pet-food.ts'],
  ['src', 'features', 'ability-log.ts'],
  ['src', 'features', 'rooms.ts'],
  ['src', 'features', 'journal.ts'],
  ['src', 'game-catalogs.ts'],
  ['src', 'game-atoms.ts'],
  ['src', 'keybinds.ts'],
  ['src', 'panel-actions.ts'],
  ['src', 'list-search.ts'],
  ['src', 'draggable.ts'],
  ['src', 'features', 'pet-teams.ts'],
  ['src', 'features', 'shop-alarms.ts'],
].map(parts => readSource(...parts)))).join('\n');
// Assertions that depend on where a function sits relative to another must name the file they
// live in, otherwise a slice across the combined source silently matches nothing.
const petTeamsSource = await readSource('src', 'features', 'pet-teams.ts');
const shopAlarmsSource = await readSource('src', 'features', 'shop-alarms.ts');
const journalSource = await readSource('src', 'features', 'journal.ts');
const searchSource = await readSource('src', 'list-search.ts');
const catalogSource = await readSource('src', 'game-catalogs.ts');
const gameAtomsSource = await readSource('src', 'game-atoms.ts');
const calculatorsSource = await readSource('src', 'features', 'calculators.ts');
const abilityLogSource = await readSource('src', 'features', 'ability-log.ts');
const styleSource = await readSource('src', 'style.css');
const overviewSource = await readSource('src', 'features', 'garden-overview.ts');
const plantDragSource = await readSource('src', 'features', 'plant-drag-move.ts');
const planterPotSelectionSource = await readSource('src', 'features', 'planter-pot-selection.ts');
const cropCleanserSource = await readSource('src', 'features', 'crop-cleanser-helper.ts');
const celestialLayoutSource = await readSource('src', 'celestial-layout.ts');
const celestialGuideSource = await readSource('src', 'features', 'celestial-layout-guide.ts');
const indexSource = await readSource('src', 'index.ts');
const petSpriteSource = await readSource('src', 'pet-sprites.ts');
const petSpriteInjector = await readSource('src', 'pet-sprites-injector.ts');
const buildSource = await readSource('scripts', 'build.ts');
const plannerSource = await readSource('src', 'features', 'garden-planner.ts');
const fishingSource = await readSource('src', 'features', 'fishing.ts');
const fishingAudioSource = await readSource('src', 'features', 'fishing-audio.ts');
const worldSceneSource = await readSource('src', 'world-scene.ts');
const connectionStateSource = await readSource('src', 'connection-state.ts');
const INITIAL_SETTLE_MS_VALUE = Number(shopAlarmsSource.match(/const INITIAL_SHOP_SETTLE_MS = (\d+)/)?.[1]);
const RECONNECT_SETTLE_MS_VALUE = Number(shopAlarmsSource.match(/const RECONNECT_SETTLE_MS = (\d+)/)?.[1]);
const gardenDefenceSource = await readSource('src', 'features', 'garden-defence.ts');
const petsSource = await readSource('src', 'pets.ts');
const dragSource = await readSource('src', 'draggable.ts');
const protectionSource = await readSource('src', 'features', 'crop-protection.ts');
const configSource = await readSource('src', 'config.ts');
const autoStoreSource = await readSource('src', 'features', 'auto-store.ts');
const estimatesSource = await readSource('src', 'features', 'crop-estimates.ts');
const constantsSource = await readSource('src', 'constants.ts');
const mutationValueSource = await readSource('src', 'mutation-value.ts');
const preserveAllSource = await readSource('src', 'features', 'preserve-all.ts');
const packageJson = JSON.parse(await readSource('package.json')) as { version: string };
const packageLock = JSON.parse(await readSource('package-lock.json')) as { version: string; packages: Record<string, { version: string }> };

const bothPlants: CelestialSpecies[] = [
  'MoonCelestial', 'MoonCelestial', 'DawnCelestial', 'DawnCelestial',
  ...Array.from({ length: 5 }, () => 'Dawnbreaker' as const),
  ...Array.from({ length: 3 }, () => 'Starweaver' as const),
];
const bothLayout = generateCelestialLayout(bothPlants, 10, 5, 'both');
assert.equal(bothLayout.error, '', 'valid celestial plants did not produce a covered layout');
assert.equal(bothLayout.met, bothPlants.length, 'not every celestial plant receives both buffs');
assert.deepEqual(
  bothLayout.cells.flatMap(cell => cell.species ? [cell.species] : []).sort(),
  [...bothPlants].sort(),
  'celestial layout changed the planted species counts',
);
const amberLayout = generateCelestialLayout(['MoonCelestial', 'MoonCelestial', 'Starweaver'], 10, 5, 'amber');
assert.equal(amberLayout.met, 3, 'Amberbound-only layout incorrectly requires Dawnbinders');
const dawnLayout = generateCelestialLayout(['DawnCelestial', 'DawnCelestial', 'Dawnbreaker'], 10, 5, 'dawn');
assert.equal(dawnLayout.met, 3, 'Dawnbound-only layout incorrectly requires Moonbinders');
const reportedAmberSet: CelestialSpecies[] = [
  ...Array.from({ length: 19 }, () => 'MoonCelestial' as const),
  ...Array.from({ length: 33 }, () => 'DawnCelestial' as const),
  ...Array.from({ length: 45 }, () => 'Dawnbreaker' as const),
];
const reportedAmberLayout = generateCelestialLayout(reportedAmberSet, 10, 10, 'amber');
assert.equal(reportedAmberLayout.met, reportedAmberSet.length, '19 Moonbinders do not cover the reported 97-plant Amberbound layout');
assert.deepEqual(reportedAmberLayout.cells.flatMap(cell => cell.species ? [cell.species] : []).sort(), [...reportedAmberSet].sort(), 'single-buff constructor changed the reported plant counts');
assert.match(generateCelestialLayout(['MoonCelestial', 'Starweaver'], 10, 5, 'amber').error, /At least two Moonbinders/, 'single Moonbinder was accepted as its own buff source');
assert.deepEqual(generateCelestialLayout(bothPlants, 10, 5, 'both'), bothLayout, 'celestial layout is not deterministic');
const occupiedIndexes = bothLayout.cells.flatMap((cell, index) => cell.species ? [index] : []);
const occupiedRows = occupiedIndexes.map(index => Math.floor(index / 5));
const occupiedColumns = occupiedIndexes.map(index => index % 5);
const occupiedArea = (Math.max(...occupiedRows) - Math.min(...occupiedRows) + 1)
  * (Math.max(...occupiedColumns) - Math.min(...occupiedColumns) + 1);
assert.ok(occupiedArea <= 20, 'celestial layout is not compact for a typical plant set');
assert.ok(Math.abs((Math.min(...occupiedRows) + Math.max(...occupiedRows)) / 2 - 4.5) <= 1, 'celestial layout is not vertically centred');
assert.ok(Math.abs((Math.min(...occupiedColumns) + Math.max(...occupiedColumns)) / 2 - 2) <= 1, 'celestial layout is not horizontally centred');
const blockedTiles = Array.from({ length: 50 }, (_, index) => index >= 10 && index < 40);
const emptyPreferred = generateCelestialLayout(['DawnCelestial', 'DawnCelestial', 'Starweaver'], 10, 5, 'dawn', blockedTiles);
assert.equal(emptyPreferred.met, 3, 'empty-space preference broke complete buff coverage');
assert.ok(emptyPreferred.cells.every((cell, index) => !cell.species || !blockedTiles[index]), 'celestial layout used occupied tiles when sufficient empty space existed');
const unavailableTiles = Array.from({ length: 50 }, (_, index) => index === 22 || index === 23);
const preservedExcluded = generateCelestialLayout(['MoonCelestial', 'MoonCelestial', 'Starweaver'], 10, 5, 'amber', [], unavailableTiles);
assert.ok(preservedExcluded.cells.every((cell, index) => !cell.species || !unavailableTiles[index]), 'celestial layout placed a plant on a preserved tile');
const impossibleLargeSet: CelestialSpecies[] = ['MoonCelestial', 'MoonCelestial', 'DawnCelestial', 'DawnCelestial', ...Array.from({ length: 196 }, () => 'Starweaver' as const)];
const impossibleStarted = performance.now();
generateCelestialLayout(impossibleLargeSet, 100, 50, 'both');
assert.ok(performance.now() - impossibleStarted < 500, 'a provably impossible large celestial layout blocks for too long');

for (const marker of [
  '@name         Garden Companion',
  '__gardenCompanionFeature',
  'Garden Overview',
  '[PlantDrag]',
  'ApplyPetTeam',
  'SavePetTeam',
  'PurchaseShopItem',
  'gc-ws-health',
  'gc-update-health',
  'weatherStation',
  'interfaceKeybinds',
  'autoRefreshGameUpdates',
  'backgroundMode',
  'version expired',
  'gc-pet-sprite',
  'gc-hunger',
  'data-shop-search',
  'data-silence-search',
  'trackedAbilities',
  'Plant focus',
  '@updateURL    https://raw.githubusercontent.com/Liam0306dis/garden-companion/main/dist/garden-companion.user.js',
  'HarvestCrop',
  'GardenInfoCardSystem',
  'ariesmod-api.ariedam.fr/rooms?limit=200',
  'SeedFinderIV',
]) assert.ok(built.includes(marker), `Missing ${marker}`);

assert.equal((built.match(/\/\/ ==UserScript==/g) ?? []).length, 1, 'nested userscript headers');
assert.ok(built.includes(`@version      ${packageJson.version}`), 'userscript and package versions differ');
assert.equal(packageLock.version, packageJson.version, 'package lock version differs from package version');
assert.equal(packageLock.packages['']?.version, packageJson.version, 'locked root package version differs from package version');
assert.ok(!built.includes('\u2014'), 'em dash found');
assert.ok(!built.includes('@ts-nocheck'), 'unchecked TypeScript boundary found');
assert.match(buildSource, /if \(!petMatches\.length\) continue;/, 'build can replace the pet catalog with an empty extraction');
assert.match(buildSource, /if \(!plantMatches\.length\) continue;/, 'build can replace the plant catalog with an empty extraction');
assert.match(buildSource, /__PLANT_CATALOG__: JSON\.stringify\(catalogs\.plants\)/, 'plant catalog is not embedded into the userscript');
assert.ok(!/setInterval\([^)]*(PurchaseShopItem|HarvestCrop|ApplyPetTeam)/s.test(built), 'unattended command loop found');
assert.ok(!built.includes('vendor/'), 'vendored source reference found');
assert.match(companionSource, /send\(\{ type: 'QuinoaCommand', requestId, command \}\)/, 'Quinoa command envelope missing');
assert.match(companionSource, /sendQuinoaCommand\(\{ type: 'PurchaseShopItem', shop: live\.shop, item: itemPayload\(live\.item, live\.shop\) \}\)/, 'purchase does not use Quinoa envelope');
assert.doesNotMatch(companionSource, /send\(\{ type: 'PurchaseShopItem'/, 'unwrapped purchase command found');
assert.doesNotMatch(companionSource, /send\(\{ type: 'Ping'/, 'redundant game Ping sender found');
assert.doesNotMatch(companionSource, /dispatchEvent\(new MouseEvent/, 'synthetic activity event found');
assert.match(companionSource, /event\.code === 4710/, 'version-expired WebSocket detection missing');
assert.match(companionSource, /game update available/, 'game update dialog detection missing');
assert.match(styleSource, /#gc-update-health\[data-status=available\] \{[^}]*color:#fecaca[^}]*border-color:rgba\(248,113,113,\.72\)/s, 'available update indicator does not use a red outline');
assert.doesNotMatch(styleSource, /#gc-update-health\[data-status=available\] \{[^}]*52,211,153/s, 'available update indicator still uses misleading green styling');
assert.match(companionSource, /'visibilityState'.*'visible'/s, 'background visibility mode missing');
assert.match(companionSource, /if \(enabled\) \{[\s\S]{0,200}showSelectedShopAlarm\(key\)/, 'enabling an alarm does not inspect current stock');
assert.match(companionSource, /if \(enabled\) \{[\s\S]{0,200}armAlarmAudio\(\)/, 'alarm audio is not armed by the settings gesture');
assert.doesNotMatch(companionSource, /alarm\?\.audio\?\.close/, 'alarm stop closes the reusable audio context');
assert.match(companionSource, /count >= perAbility/, 'per-ability history limit missing');
assert.match(companionSource, /const LOG_PER_ABILITY = 100/, 'the ability history cap has moved');
assert.match(companionSource, /if \(saveLocalOrFail\(LOG_KEY, state\.abilityLog\)\) return;/, 'a full storage quota silently stops persisting the log');
assert.match(companionSource, /data-log-search/, 'the ability log cannot be searched');
assert.match(companionSource, /data: snapshotPayload\(entry\.parameters \|\| \{\}\)/, 'ability result payload is not snapshotted');
assert.match(companionSource, /ability\.includes\('SeedFinder'\) && data\.speciesId[\s\S]*payloadItemName\(data\.speciesId\)/, 'seed finder result is not placed on the main line');
assert.match(companionSource, /growSlot\?\.species[\s\S]*payloadItemName\(growSlot\.species\)/, 'mutation granter target is not placed on the main line');
assert.match(companionSource, /ABILITY_GROUP_BY_ID\.get\(ability\) === 'Crop Size Boost'[\s\S]*scaleIncreasePercentage[\s\S]*toFixed\(1\).*% boosted/, 'Crop Size Boost payload omits its scale increase');
assert.match(companionSource, /family === 'XP Boost'[\s\S]*XP gained:[\s\S]*family === 'Hunger Restore'[\s\S]*Hunger gained:/, 'XP and hunger proc amounts are missing from payload tooltips');
assert.match(companionSource, /gc-ability-log-payload[\s\S]*tooltip \? ` title=[\s\S]*data-detail/, 'ability payload hover details are not rendered');
assert.match(companionSource, /gc-ability-log-row[\s\S]*gc-ability-log-pet[\s\S]*gc-ability-log-name[\s\S]*gc-ability-log-payload/, 'Pet Ability rows do not show the pet, ability, and payload');
assert.match(abilityLogSource, /date: LOG_DATE_FORMAT\.format\(value\),\s*time: LOG_TIME_FORMAT\.format\(value\),/, 'Pet Ability rows do not show both date and time');
assert.match(companionSource, /when\.time[\s\S]*when\.date/, 'Pet Ability rows do not emphasize time before date');
assert.match(companionSource, /triggeringPet[\s\S]*petSprite\(pet\)/, 'Pet Ability rows do not show the triggering pet sprite');
assert.doesNotMatch(companionSource, /gc-ability-log-pet[^`]*<small>/, 'Pet Ability rows still repeat the pet name beside its sprite');
assert.match(companionSource, /MoonCelestial.*Moonbinder[\s\S]*DawnCelestial.*Dawnbinder/, 'Pet Ability payloads do not use displayed celestial plant names');
assert.match(styleSource, /\.gc-ability-filter \{[^}]*width:126px/, 'Pet Ability filter is not compact');
assert.match(styleSource, /\.gc-ability-log-payload \{[^}]*color:#f4f4f5/, 'Pet Ability payload text does not match the primary text colour');
assert.doesNotMatch(companionSource, /procDataSummary/, 'legacy proc summary line remains');
assert.doesNotMatch(companionSource, /gc-proc-payload|procPayloadJson/, 'raw proc payload remains visible in history');
assert.match(styleSource, /#gc-panel[^\n]+background:\s*transparent/, 'main window still dims the game');
assert.match(companionSource, /gc-lunar-head[\s\S]*gc-lunar-countdown[\s\S]*gc-health/, 'lunar timer card structure is incomplete');
assert.doesNotMatch(companionSource, /<small>remaining<\/small>/, 'lunar timer still shows the remaining label');
assert.match(styleSource, /\.gc-lunar-countdown \{[^}]*justify-content:center/, 'lunar countdown is not centred');
assert.match(styleSource, /\.gc-lunar-countdown strong \{[^}]*font:650 31px/, 'lunar countdown is too small');
assert.match(companionSource, /function togglePanel\(\)[\s\S]*!panel\.hidden\) closePanel\(\);[\s\S]*else openPanel\(\);/, 'Garden Companion panel toggle is missing');
assert.match(companionSource, /\[data-options\]'\)!\.onclick = togglePanel/, 'lunar cog does not toggle the panel');
assert.match(companionSource, /data-interface-key="companionPanel"/, 'Garden Companion panel keybind field is missing');
assert.match(companionSource, /data-overview-key/, 'Garden Overview keybind is missing from interface shortcuts');
assert.match(companionSource, /beginKeybindCapture\(input, 'overview', 'Press keys\.\.\.'\)/, 'Garden Overview keybind does not use shared ownership');
assert.match(styleSource, /\.gc-shortcut-row \{[^}]*grid-template-columns:minmax\(145px,1fr\) 210px/, 'interface shortcuts are not aligned in a fixed input column');
assert.match(companionSource, /config\.interfaceKeybinds\.companionPanel === combo[\s\S]*togglePanel\(\)/, 'Garden Companion panel keybind does not toggle the panel');
assert.match(companionSource, /querySelectorAll<HTMLInputElement>\('#gc-panel \[data-interface-key\]'\)[\s\S]*field\.value = config\.interfaceKeybinds/, 'interface keybind changes still redraw the panel');
assert.match(companionSource, /function claimKeybind\(owner: string, combo: string\)/, 'shared keybind ownership is missing');
assert.match(companionSource, /owner !== 'overview'[\s\S]*localStorage\.getItem\(OVERVIEW_SHORTCUT_KEY\) === combo[\s\S]*__gardenCompanionOverviewShortcutChanged\?\.\(overviewShortcutChanged\)/, 'companion keybinds do not update a duplicate overview key');
assert.match(companionSource, /beginKeybindCapture\(input, `team:\$\{input\.dataset\.teamKey\}`/, 'team keybind capture does not use shared ownership');
assert.match(companionSource, /beginKeybindCapture\(input, `interface:\$\{input\.dataset\.interfaceKey\}`/, 'interface keybind capture does not use shared ownership');
assert.match(companionSource, /function beginKeybindCapture[\s\S]*input\.addEventListener\('blur', cancel, \{ once: true \}\)/, 'abandoned keybind capture is not cancelled on blur');
assert.match(companionSource, /function closePanel\(\)[\s\S]*cancelKeybindCapture\?\.\(\)/, 'closing the panel does not cancel keybind capture');
assert.match(overviewSource, /__gardenCompanionOverviewShortcutChanged = nextShortcut => \{ shortcut = nextShortcut; \}/, 'overview shortcut does not react to companion keybind changes');
assert.match(styleSource, /\.gc-lunar-mark::after/, 'lunar timer crescent mark is missing');
// Minimised it becomes an icon beside the Garden Overview button, which is 32px wide at left:10px.
assert.match(styleSource, /#gc-lunar-mini \{[^}]*left:50px;bottom:10px/, 'the minimised lunar icon does not sit beside the overview button');
assert.match(companionSource, /mini\.hidden = !shown \|\| !lunarMinimised;/, 'the minimised lunar icon ignores the lunar timer feature toggle');
assert.match(companionSource, /mini\.title = `Next lunar event in \$\{remaining\}`/, 'the minimised lunar icon stops reporting the countdown');
assert.match(companionSource, /saveLocal\(LUNAR_MINIMISED_KEY, minimised\)/, 'a minimised lunar timer is not remembered');
// Our own scenes claim cinematic too, so the timer must only step aside for the player's own use.
assert.match(companionSource, /cinematicValue && cinematicOwners\.size === 0/, 'the lunar timer cannot tell the player\'s cinematic mode from our own');
assert.match(companionSource, /const shown = feature\('lunarTimer'\) && !page\.__gardenCompanionCinematicFromGame\?\.\(\);/, 'the lunar timer stays on screen in cinematic mode');
assert.match(companionSource, /page\.__gardenCompanionOnCinematicChange\?\.\(updateLunarTimer\);/, 'entering cinematic mode leaves the timer in shot until the next tick');
// More than one launcher hides, so this has to be a subscription rather than a single callback.
assert.match(companionSource, /const cinematicListeners = new Set<\(\) => void>\(\);/, 'a second cinematic listener would replace the first');
// The game toggles with an updater, so replaying it against our own copy could never self-correct.
assert.match(companionSource, /cinematicValue = Boolean\(\(get as \(target: JotaiAtom\) => unknown\)\(atom\)\);/, 'the cinematic value is inferred rather than read back');
// Releasing the last claim must not switch off a cinematic mode the player turned on themselves.
assert.match(companionSource, /gameAtomSet\(cinematicAtom, cinematicOwners\.size > 0 \|\| cinematicBeforeClaim\)/, 'closing one of our scenes cancels the player\'s own cinematic mode');
assert.match(companionSource, /if \(!applyingOwnCinematic && cinematicOwners\.size\) cinematicBeforeClaim = cinematicValue;/, 'a player toggle during one of our scenes is not remembered');
assert.match(overviewSource, /button\.hidden = Boolean\(page\.__gardenCompanionCinematicFromGame\?\.\(\)\)/, 'the overview launcher stays on screen in cinematic mode');
assert.match(styleSource, /#gc-lunar::before[\s\S]*linear-gradient/, 'lunar timer accent line is missing');
assert.doesNotMatch(companionSource, /slice\(0, 500\)/, 'legacy global ability history limit found');
assert.match(overviewSource, /structureSignature/, 'overview structural refresh guard missing');
assert.match(overviewSource, /installPlantFocus/, 'overview plant focus missing');
assert.match(overviewSource, /focusEnabled\.onchange[\s\S]*focusEnabled\.blur\(\)/, 'plant focus enabled checkbox keeps keyboard focus');
assert.match(overviewSource, /focusInvert\.onchange[\s\S]*focusInvert\.blur\(\)/, 'plant focus invert checkbox keeps keyboard focus');
assert.match(overviewSource, /data-focus-max-size/, 'plant focus max-size toggle is missing');
assert.match(overviewSource, /if \(config\.maxSize\) conditions\.push\(\(tile\.slots \|\| \[\]\)\.some/, 'plant focus max-size rule must inspect the whole plant');
assert.match(overviewSource, /config\.mutationRule === 'any' \? conditions\.some\(Boolean\)/, 'plant focus max-size rule must participate in Any matching');
assert.match(overviewSource, /config\.mutationRule === 'none' \? conditions\.every\(match => !match\)/, 'plant focus max-size rule must participate in None matching');
assert.match(overviewSource, /if \(Number\(tile\.maturedAt \?\? 0\) > now\) \{[\s\S]*fade\(plantVisual\?\.container[\s\S]*crops\.forEach\(\(crop: any\) => fade\(cropContainer\(crop\)/, 'growing base plants and their slots must always remain faded');
assert.match(overviewSource, /button\.go-pill i\{width:9px;flex:0 0 9px/, 'overview selection buttons must reserve checkmark space');
assert.match(overviewSource, /focusMaxSize\.onchange[\s\S]*focus\.maxSize = focusMaxSize\.checked[\s\S]*focusMaxSize\.blur\(\)/, 'plant focus max-size toggle is not saved or releases keyboard focus incorrectly');
assert.match(overviewSource, /if \(activeDrag\) \{ updateCountdowns\(panel, stats\); return; \}/, 'garden overview must not replace a panel while it is being dragged');
assert.doesNotMatch(overviewSource, /const saveFocusControls = \(\) => \{[^}]*lastSignature = ''/, 'plant focus controls must not schedule a popup-replacing redraw');
assert.match(overviewSource, /PageObject\.defineProperty\(prototype, 'tileViews'/, 'plant focus direct tile-view capture missing');
assert.match(overviewSource, /property === 'tileViews'.*attributes\?\.value instanceof PageMap/s, 'plant focus defined-property capture missing');
assert.match(overviewSource, /view\.draw = function.*enforce\(view\.childView\?\.plantVisual\?\.container\)/s, 'plant focus redraw enforcement missing');
assert.match(overviewSource, /data-zoom/, 'overview zoom control missing');
assert.doesNotMatch(overviewSource, /data-shortcut/, 'overview still contains its old keybind button');
assert.match(overviewSource, /if \(panel\?\.hidden\) open\(\);[\s\S]*else close\(\);/, 'overview shortcut does not toggle the panel');
assert.match(overviewSource, /stopImmediatePropagation\(\); toggle\(\);/, 'overview shortcut still only opens the panel');
assert.match(overviewSource, /h2\{[^}]*white-space:nowrap/, 'overview title can wrap');
assert.match(overviewSource, /data-owned>Track owned/, 'overview Track owned control missing');
assert.match(overviewSource, /combineRainbow.*Rainbow \+ Gold/s, 'overview combined mutation controls missing');
assert.match(overviewSource, /granterAllGarden.*Whole garden/s, 'overview estimate scope control missing');
assert.match(overviewSource, /installDrag\(panel\.querySelector\('\.go-card'\)!.*\(left, top\)/s, 'overview position is not isolated from config window dragging');
assert.match(overviewSource, /const configPlacement = configPosition \? `style="position:fixed;left:/, 'overview config position is not restored during redraws');
assert.match(overviewSource, /installDrag\(configCard, configHeader, \(left, top\) => \{ configPosition = \{ left, top \}; \}\)/, 'overview config drag position is not retained');
assert.match(overviewSource, /if \(!panel \|\| \(panel\.hidden && !view\.alarm\)\) return;[\s\S]*checkCompletions\(stats\);[\s\S]*if \(panel\.hidden\) return;/, 'overview alarm monitoring stops when its window is hidden');
assert.match(overviewSource, /if \(!alarmTargets\.has\(target\)\) \{[\s\S]*previousMissing\.delete\(row\.mutation\);[\s\S]*continue;/, 'overview granter alarms must ignore disabled alarm targets and clear stale completion state');
assert.match(overviewSource, /data-alarm-config[\s\S]*Configure completion alarms/, 'overview granter alarm configuration button is missing');
assert.match(overviewSource, /ALARM_TARGETS_KEY[\s\S]*loadAlarmTargets[\s\S]*saveAlarmTargets/, 'overview granter alarm targets are not persisted');
assert.match(overviewSource, /const ALARM_TARGETS = \[[^;]*'Max Size'\]/, 'overview completion alarms must include Max Size');
assert.match(overviewSource, /name === 'Max Size' \? 'All selected crops have reached maximum size'/, 'max-size alarm uses mutation completion wording');
assert.match(overviewSource, /const target = row\.mutation === 'Bee Size' \? 'Max Size' : row\.mutation/, 'Bee Size estimates must use the Max Size alarm target');
assert.match(overviewSource, /!notified\.has\(target\)[\s\S]*notified\.add\(target\)[\s\S]*notifyCompletedMutation\(target\)/, 'equivalent max-size completion rows must not create duplicate alarms');
assert.match(overviewSource, /data-alarm-target[\s\S]*previousMissing\.delete\(target\)/, 'disabling a granter alarm target must clear its completion baseline');
assert.match(overviewSource, /if \(!view\.alarm && refreshTimer\)/, 'closing Garden Overview still disables an armed mutation alarm');
assert.match(overviewSource, /if \(view\.alarm\) ensureRefreshTimer\(\);/, 'saved overview alarm is not resumed after mounting');
assert.match(companionSource, /function showAlarmBanner\(options: CompanionAlarmOptions\)/, 'shared alarm presentation is missing');
assert.match(companionSource, /const alarmQueue: CompanionAlarmOptions\[\] = \[\]/, 'shared alarms do not retain a queue');
assert.match(companionSource, /const availableKeys = new Set[\s\S]*!availableKeys\.has\(key\)[\s\S]*stopAlarm\(`shop:\$\{key\}`\)/, 'out-of-stock shop alarms are not stopped on the next inventory cycle');
assert.match(companionSource, /for \(const row of available\) updateAlarmDetail\(`shop:\$\{row\.shop\}:\$\{row\.id\}`, `\$\{row\.remaining\} remaining`\)/, 'shop refreshes do not update alarm stock counts');
assert.match(companionSource, /function updateAlarmDetail[\s\S]*alarmQueue[\s\S]*alarm\.options\.detail = detail[\s\S]*data-alarm-detail/, 'active and queued alarm details are not updated in place');
assert.match(companionSource, /const owner = `shop:\$\{row\.shop\}:\$\{row\.id\}`[\s\S]*showAlarmBanner\(\{[\s\S]*owner,/, 'shop alarms do not have item-specific owners');
assert.match(companionSource, /data-shop-alert[\s\S]{0,200}toggleShopAlert\(/, 'the shop alert toggle is not wired up');
assert.match(shopAlarmsSource, /if \(enabled\) \{[\s\S]*showSelectedShopAlarm\(key\);[\s\S]*\} else stopAlarm\(`shop:\$\{key\}`\)/, 'disabling a shop item does not remove its active and queued alarms');
assert.match(shopAlarmsSource, /function settleInitialShops\(signature: string\)[\s\S]*setTimeout\([\s\S]*INITIAL_SHOP_SETTLE_MS\)/, 'initial shop alarms are not delayed for a stable startup snapshot');
assert.match(shopAlarmsSource, /latestSignature !== pendingInitialSignature[\s\S]*settleInitialShops\(latestSignature\)/, 'a changed startup shop snapshot is not allowed to settle again');
assert.match(shopAlarmsSource, /if \(!state\.initializedShops\) \{[\s\S]*settleInitialShops\(signature\);[\s\S]*return;/, 'partial startup shop state can still trigger alarms immediately');
assert.match(shopAlarmsSource, /signature === state\.lastShopSignature && !restocked\.size\) \{[\s\S]*state\.initializedShops = true;[\s\S]*return;/, 'an empty settled shop snapshot can re-arm its startup timer forever');
assert.match(shopAlarmsSource, /interface AvailableShopItem[\s\S]*shop: string;[\s\S]*item: ShopItem;[\s\S]*remaining: number;/, 'settled shop rows have no shared type');
assert.match(companionSource, /This item is no longer available[\s\S]*stopAlarm\(owner\)[\s\S]*Requested \$\{live\.remaining\}[\s\S]*stopAlarm\(owner\)/, 'shop purchase actions can dismiss a different queued alarm');
assert.match(companionSource, /if \(alarm\) \{[\s\S]*alarmQueue\.push\(options\)[\s\S]*return;[\s\S]*renderAlarmBanner\(options\)/, 'a new alarm can still overwrite the active alarm');
assert.match(companionSource, /const next = alarmQueue\.shift\(\);[\s\S]*renderAlarmBanner\(next\)/, 'dismissing an alarm does not advance the queue');
assert.match(companionSource, /data-alarm-queue/, 'queued alarm count is not shown');
assert.match(overviewSource, /__gardenCompanionShowAlarm\?\.\(\{[\s\S]*GARDEN ALARM \| MUTATION GRANTER/, 'overview completion does not use the shop alarm presentation');
assert.match(overviewSource, /owner: 'overview'/, 'overview alarms do not identify their owner');
assert.match(overviewSource, /__gardenCompanionStopAlarm\?\.\('overview'\)/, 'disabling overview alarms still stops unrelated alarms');
assert.match(companionSource, /function stopAlarm\(owner\?: string\)[\s\S]*alarmQueue\[index\]\.owner === owner/, 'shared alarms cannot be cancelled by owner');
assert.match(overviewSource, /DawnlitGranter: \{ mutation: 'Dawnlit', chance: 4 \}/, 'Dawnlit Granter estimate uses a stale probability');
assert.doesNotMatch(overviewSource, /gc-overview-alarm|playCompletionAlarm|createOscillator/, 'legacy overview alarm implementation remains');
assert.doesNotMatch(overviewSource, /backdrop-filter:blur|background:#fff/, 'overview contains a light or dimming panel layer');
assert.match(companionSource, /__gardenCompanionPetSprites\?\.\[pet\.petSpecies\]/, 'pet cards do not use loaded atlas sprites');
assert.doesNotMatch(companionSource, /\/sprite\/pet\/.*\.png/, 'pet cards use invalid standalone sprite URLs');
assert.match(petSpriteSource, /loadPetFrames/, 'pet atlas loader missing');
assert.match(petSpriteSource, /rive\/pets\.riv/, 'current Rive pet asset is not discovered from the manifest');
assert.match(petSpriteSource, /loadRivePetFrames/, 'Rive pet portraits are not rendered');
assert.match(petSpriteSource, /__gardenCompanionShopSprites/, 'shop atlas sprites are not exposed');
assert.match(companionSource, /gc-shop-sprite/, 'shop alarm items do not render sprites');
for (const excludedTool of ['Shovel', 'FeedingTrough', 'DecorShed', 'PetHutch', 'SeedSilo']) assert.match(companionSource, new RegExp(`EXCLUDED_TOOL_ALERTS[\\s\\S]*'${excludedTool}'`), `${excludedTool} is not excluded from tool alarms`);
assert.match(companionSource, /shop === 'tool' && EXCLUDED_TOOL_ALERTS\.has\(id\)/, 'excluded tools can still trigger live alarms');
assert.match(companionSource, /shopAlarmTab !== 'tool' \|\| !EXCLUDED_TOOL_ALERTS\.has\(id\)/, 'excluded tools remain in the alarm list');
assert.match(companionSource, /\['teams', 'abilities', 'shops', 'petFood', 'calculators'\]\.includes\(activeTab\)/, 'an open sprite-backed tab does not refresh when sprites load');
for (const shopSpriteGroup of ["seed", "egg", "tool"]) assert.match(petSpriteSource, new RegExp(`${shopSpriteGroup}: \\[`), `missing ${shopSpriteGroup} sprite group`);
assert.match(petSpriteInjector, /script\.textContent = __PET_SPRITE_LOADER__/, 'pet atlas loader is not injected into the game page');
// The game ships most days but its atlases rarely change, so the cache is keyed on the artwork.
assert.match(petSpriteSource, /await fetch\(`\$\{assetsBase\}\$\{path\}`, \{ method: 'HEAD' \}\)/, 'sprite cache does not fingerprint the atlases it decoded');
assert.match(petSpriteSource, /if \(stamps\.some\(value => !value\)\) return version;/, 'a missing atlas header silently produces a fingerprint that cannot be trusted');
// The fingerprint picks a cache key; it must never be the reason sprites fail to appear.
assert.match(petSpriteSource, /function withTimeout[\s\S]*Promise\.race\(\[[\s\S]*work\.catch\(\(\) => fallback\)/, 'a hanging fingerprint request can block sprite loading');
assert.match(petSpriteSource, /const key = await withTimeout\([\s\S]*version,\s*2_000,/, 'the atlas fingerprint has no fallback deadline');
assert.match(petSpriteSource, /fingerprint \?\?= \(async \(\) => \{/, 'the atlas fingerprint is rebuilt for every sprite stage');
// A load that could not identify the atlases must not delete a bundle it cannot prove is stale.
assert.match(petSpriteSource, /store\.put\(value, key\);\s*if \(!evict\) return;/, 'a fallback fingerprint still evicts good cache entries');
assert.match(petSpriteSource, /return \{ key, identified: key !== version \};/, 'the cache cannot tell a real fingerprint from the version fallback');
assert.doesNotMatch(petSpriteSource, /const key = `\$\{version\}:\$\{stage\}`/, 'sprite cache is still keyed on the asset version');
// The loader is over half the script and compiles synchronously, then decodes a WASM transcoder and
// every atlas. Doing that at document-start is the script's share of the game's slow first load.
assert.doesNotMatch(petSpriteInjector, /export function installPetSpriteLoader\(\): void \{\s*const script = document\.createElement/, 'the sprite loader is injected synchronously at document-start');
assert.match(petSpriteInjector, /page\.addEventListener\('load', start, \{ once: true \}\)/, 'sprite loading does not wait for the page to finish loading');
assert.match(petSpriteInjector, /requestIdleCallback/, 'sprite loading does not wait for the main thread to go quiet');
// Injecting on the first pointer press defeats the whole deferral: the player clicks during the
// load it was meant to stay out of. Opening a panel is the honest signal that artwork is wanted.
assert.doesNotMatch(petSpriteInjector, /addEventListener\('pointerdown', inject/, 'a click during load drags the sprite loader back into the load');
assert.match(companionSource, /page\.__gardenCompanionLoadSprites\?\.\(\);\s*page\.__gardenCompanionLoadSpriteGroup\?\.\('deferred'\);/, 'opening a panel does not pull in the artwork it needs');
assert.match(petSpriteInjector, /idle\.call\(page, run, \{ timeout: 15_000 \}\)/, 'the idle timeout is short enough to fire during the load it avoids');
assert.match(petSpriteInjector, /let injected = false;[\s\S]*if \(injected \|\| spritesDisabled\(\)\) return;\s*injected = true;/, 'the sprite loader can be injected more than once');
assert.match(petSpriteInjector, /page\.__gardenCompanionLoadSprites = inject;/, 'nothing can pull the sprite loader in on demand');
assert.match(indexSource, /initPlantDragMove\(\);/, 'plant drag is not installed for runtime toggling');
assert.match(indexSource, /initPlanterPotSelection\(\);/, 'Planter Pot selection keeper is not installed');
assert.match(indexSource, /initCelestialLayoutGuide\(\);/, 'celestial layout guide is not installed');
assert.match(indexSource, /initCropCleanserHelper\(\);/, 'Crop Cleanser helper is not installed');
assert.match(companionSource, /data-open-crop-cleanser/, 'Crop Cleanser helper launcher is missing from Features');
assert.match(cropCleanserSource, /Wet.*Chilled.*Frozen.*Thunderstruck.*Thundercharged.*Ambershine.*Dawnlit.*Ambercharged.*Dawncharged/s, 'Crop Cleanser mutation filters are incomplete');
assert.match(cropCleanserSource, /send\(\{ type: 'CropCleanser', tileObjectIdx: live\.tileObjectIdx, growSlotIdx: live\.growSlotIdx \}\)/, 'Crop Cleanser request does not match the game protocol');
assert.match(cropCleanserSource, /slot\.preserved === true/, 'Crop Cleanser helper lists preserved crop slots');
assert.match(cropCleanserSource, /PLANT_CATALOG\[tile\.species \|\| ''\][\s\S]*plant\?\.regrows !== false[\s\S]*maturedAt > Date\.now\(\)/, 'Crop Cleanser helper does not match the native garden-object maturity gate');
assert.match(cropCleanserSource, /liveRowMatches\(row\)[\s\S]*if \(!live\)[\s\S]*send\(\{ type: 'CropCleanser'/, 'Crop Cleanser target is not revalidated before sending');
assert.match(cropCleanserSource, /live\.startTime !== snapshot\.startTime/, 'Crop Cleanser replacement crops are not rejected');
assert.match(cropCleanserSource, /removes all cleanseable weather mutations/, 'Crop Cleanser helper does not explain the native removal scope');
assert.match(cropCleanserSource, /rowSnapshot = matchingRows\(\);[\s\S]*cleansedRows\.clear\(\)/, 'Crop Cleanser rows are not snapshotted per opening or filter');
assert.match(cropCleanserSource, /cleansedRows\.has\(row\.key\)[\s\S]*Cleansed/, 'cleansed Crop Cleanser rows do not remain visible');
assert.match(cropCleanserSource, /cleansedRows\.add\(row\.key\)/, 'successful Crop Cleanser requests are not retained in the snapshot');
assert.match(cropCleanserSource, /button\.textContent = 'Cleansed'/, 'cleansed Crop Cleanser rows are not updated in place');
assert.doesNotMatch(cropCleanserSource, /currentSignature|setInterval\([^)]*render/, 'Crop Cleanser list still refreshes while open');
assert.match(cropCleanserSource, /reconcileCleanserCount[\s\S]*heldToolCount\('CropCleanser'\)[\s\S]*updateCleanserControls/, 'Crop Cleanser inventory does not reconcile while the helper is open');
assert.match(cropCleanserSource, /live === lastLiveCleanserCount && live === displayedCleanserCount/, 'rejected Crop Cleanser requests leave the displayed inventory stale');
assert.match(cropCleanserSource, /optimisticCountUntil = Date\.now\(\) \+ 2_000/, 'Crop Cleanser optimistic inventory has no reconciliation grace period');
assert.match(cropCleanserSource, /plantName\(row\.species\)/, 'Crop Cleanser helper does not use the shared crop names');
// Species ids are regularly not what the game calls the crop, so every list of plants asks the
// catalog rather than prettifying the id.
assert.ok(constantsSource.includes("const name = NAME_OVERRIDES[species] ?? PLANT_CATALOG[species]?.crop?.name;"), 'crop names no longer come from the game catalog');
assert.ok(constantsSource.includes("return species.endsWith('Fruit') ? name : name.replace(/ Fruit$/, '');"), 'a trailing Fruit is no longer trimmed from crop names');
assert.ok(constantsSource.includes('PLANT_CATALOG[species]?.plantLabel || plantName(species)'), 'patch rows no longer use the plant name');
assert.ok(buildSource.includes('crop: { name: match[5]'), 'the plant catalog no longer carries crop names');
assert.match(overviewSource, /const key = PATCH_FAMILY_OF\[row\.species\] \?\? row\.species;/, 'the overview no longer groups patch families onto one row');
assert.match(overviewSource, /if \(PLANT_CATALOG\[value\]\) return plantName\(value\);/, 'the overview names crops itself instead of using the shared name');
assert.match(overviewSource, /const open = openFamilies\.has\(key\);/, 'patch rows no longer expand to show their species');
assert.match(constantsSource, /\['Daisy', 'PurpleDaisy'\][\s\S]*\['ThunderCelestial', 'ThunderCelestialShroomPlant'\]/, 'a patch family is missing');
assert.match(cropCleanserSource, /startCountReconciliation\(\)[\s\S]*stopCountReconciliation\(\)/, 'Crop Cleanser inventory polling is not scoped to the open panel');
assert.doesNotMatch(cropCleanserSource, /initCropCleanserHelper\(\)[\s\S]*setInterval/, 'Crop Cleanser inventory polling runs for the page lifetime');
assert.match(companionSource, /Crop Cleanser Helper.*data-interface-key="\$\{CROP_CLEANSER_KEY\.id\}"/s, 'Crop Cleanser keybind is missing from the Keybinds tab');
assert.match(companionSource, /config\.interfaceKeybinds\[CROP_CLEANSER_KEY\.id\] === combo[\s\S]*__gardenCompanionToggleCropCleanser/, 'Crop Cleanser keybind does not toggle the helper');
assert.match(companionSource, /data-open-celestial-layout/, 'celestial layout launcher is missing from Features');
assert.match(companionSource, /__gardenCompanionToggleCelestialLayout/, 'celestial layout launcher is not wired');
assert.match(celestialGuideSource, /MoonCelestial.*DawnCelestial.*Dawnbreaker.*Starweaver/, 'celestial layout species are incomplete');
assert.match(celestialGuideSource, /side === 'left'.*columns\.slice\(0, split\).*columns\.slice\(split\)/s, 'celestial layout does not split the farm by mapped columns');
assert.match(celestialGuideSource, /generateCelestialLayout\(plants, rows, columns, guide\.goal, blocked, unavailable\)/, 'celestial layout does not account for occupied and preserved farm tiles');
assert.match(celestialGuideSource, /tile\.slots\?\.some\(slot => slot\.preserved === true\)/, 'celestial layout does not detect preserved plants');
assert.match(celestialGuideSource, /!isPreserved\(tile\).*CELESTIAL_SPECIES\.has/, 'celestial layout still counts or highlights preserved celestial plants');
assert.match(celestialGuideSource, /stylePlant\(ref, correct \? 0x66ff8c : 0xff5265/, 'celestial plants are not tinted for placement feedback');
assert.match(celestialGuideSource, /placementType\(planned\) === placementType\(actual\)/, 'Dawnbreaker and Starweaver are not interchangeable in placement feedback');
assert.match(celestialGuideSource, /renderer\.textureGenerator\.generateTexture\(\{ target: display, resolution: 1 \}\)/, 'celestial layout does not use the game renderer to capture the complete plant');
assert.doesNotMatch(celestialGuideSource, /renderer\.extract\.canvas|toDataURL/, 'celestial layout performs a blocking GPU image readback');
assert.match(celestialGuideSource, /system\.worldContainer\.addChild\(ghost\)/, 'celestial layout does not display captured plants in the game world');
assert.match(celestialGuideSource, /node\.renderPipeId === 'sprite'.*!\('textures' in node\)/, 'celestial layout does not select a static PIXI Sprite constructor');
assert.match(celestialGuideSource, /label\.textContent = SPECIES_LABELS\[planned\]/, 'celestial layout has no readable fallback when a plant capture is unavailable');
assert.match(celestialGuideSource, /else positionOverlay\(\);[\s\S]*requestAnimationFrame\(frame\)/, 'celestial layout does not follow camera movement and zoom every frame');
assert.match(celestialGuideSource, /now - lastStateAt >= 250/, 'celestial layout still rebuilds garden state on every visual frame');
assert.doesNotMatch(celestialGuideSource, /function positionOverlay\(\)[\s\S]*dirtTiles\(\)/, 'celestial layout remaps every farm tile on each animation frame');
assert.match(celestialGuideSource, /makeDraggable\(panel, POSITION_KEY\)/, 'celestial layout panel is not draggable');
assert.match(celestialGuideSource, /gardenCompanion\.celestialLayoutPosition\.v1/, 'celestial layout panel position is not persisted');
assert.doesNotMatch(celestialGuideSource, /panel\.addEventListener\('pointerdown',[^\n]+, true\)/, 'celestial layout blocks pointerdown before its drag handler can run');
assert.doesNotMatch(celestialGuideSource, /updateTileData/, 'celestial layout mutates the live tile renderer and would block plant movement');
assert.doesNotMatch(celestialGuideSource, /__gardenCompanionProduceSprites|__gardenCompanionShopSprites|__gardenCompanionPlantSprites/, 'celestial layout still uses flat extracted artwork');
assert.match(celestialLayoutSource, /Moonbinders.*plant cannot grant Amberbound to itself/, 'Amberbound source validation is missing');
assert.match(celestialLayoutSource, /Dawnbinders.*plant cannot grant Dawnbound to itself/, 'Dawnbound source validation is missing');
assert.match(celestialLayoutSource, /const deadline = performance\.now\(\) \+ 120/, 'celestial layout search has no blocking-time budget');
assert.match(celestialLayoutSource, /currentInspection\.met !== currentInspection\.required/, 'celestial layout keeps searching after finding full coverage');
assert.match(styleSource, /#gc-celestial-overlay/, 'celestial layout overlay styles are missing');
assert.match(planterPotSelectionSource, /myOptimisticInventoryItemsAtom/, 'selection keeper does not watch inventory changes');
assert.match(planterPotSelectionSource, /mySelectedItemIdAtom/, 'selection keeper does not watch selected items');
assert.match(planterPotSelectionSource, /selectedItemId === 'PlanterPot'/, 'selection keeper is not limited to Planter Pot use');
assert.match(planterPotSelectionSource, /pending\.addedPlantIds\.has\(nextItemId\)/, 'selection keeper does not target the newly potted plant');
assert.match(planterPotSelectionSource, /__gardenCompanionFeature\?\.\('keepPlanterPotSelected'\) === true/, 'selection keeper is not strictly opt-in');
assert.match(gameAtomsSource, /if \(atom\.write === capture\) atom\.write = original/, 'game atom capture cleanup can remove a later feature hook');
assert.match(planterPotSelectionSource, /MAX_INSTALL_ATTEMPTS = 240/, 'selection keeper atom retry is not bounded');
assert.match(planterPotSelectionSource, /attempts >= MAX_INSTALL_ATTEMPTS/, 'selection keeper atom retry cap is not enforced');
assert.match(planterPotSelectionSource, /selection keeper could not find the game inventory atoms/, 'selection keeper does not report atom installation failure');
assert.match(companionSource, /Keep Planter Pot selected/, 'selection keeper toggle is missing from Features');
assert.match(companionSource, /keepPlanterPotSelected: false/, 'selection keeper must default off');
assert.doesNotMatch(indexSource, /if \(page\.__gardenCompanionFeature\?\.\('dragMove'\)\) initPlantDragMove/, 'plant drag still requires a reload to install');
assert.match(plantDragSource, /function isEnabled\(\)[\s\S]*__gardenCompanionFeature\?\.\('dragMove'\)/, 'plant drag does not read its live feature setting');
assert.match(plantDragSource, /const HOLD_MS = 1000;/, 'plant drag hold time is not one second');
assert.match(plantDragSource, /if \(!isEnabled\(\) \|\| press \|\| event\.button/, 'disabled plant drag still starts presses');
assert.match(companionSource, /Plant drag, Planter Pot selection, estimates, and harvest settings apply immediately\. Background mode applies after a reload\./, 'Features note is outdated');
assert.match(companionSource, /Hold, drag and release a plant - consumes planter pots/, 'Plant drag move description is incorrect');
assert.match(overviewSource, /\.go-card\{width:min\(344px,94vw\)/, 'overview does not match the standalone compact width');
assert.match(overviewSource, /row\.totalSeconds/, 'overview detailed granter estimates missing');
assert.match(overviewSource, /rows\.filter\(\(\[, , count\]\) => count > 0\)/, 'overview still displays empty mutation rows');
assert.match(overviewSource, /stats\.mature === 0/, 'overview first-ready card behavior differs from standalone');
assert.match(companionSource, /alarm = \{ timer: setInterval\(playAlarmTone, 420\), options \}/, 'shared alarm is not persistent');
assert.match(companionSource, /\['abilities', 'Active Pets'\], \['abilityLog', 'Pet Abilities'\], \['teams', 'Pet Teams'\], \['petFood', 'Pet Food'\], \['protection', 'Crop Protection'\], \['calculators', 'Calculators'\], \['shops', 'Shop Alarms'\], \['silence', 'Ignore Alerts'\], \['journal', 'Journal'\], \['rooms', 'Rooms'\], \['keybinds', 'Keybinds'\], \['features', 'Features'\]/, 'tab order is incorrect');
assert.match(companionSource, /\[4, 5\]\.includes\(Number\(room\.players_count\)\)/, 'rooms are not restricted to 4 or 5 players');
assert.match(companionSource, /sort\(\(left, right\) => Number\(right\.players_count\) - Number\(left\.players_count\)\)/, '5-player rooms are not sorted above 4-player rooms');
assert.match(companionSource, /Public rooms with one or two open slots\./, 'room description is incorrect');
assert.match(companionSource, /data-ability-filter/, 'Pet Abilities filter missing');
assert.match(companionSource, /data-ability-option/, 'Pet Abilities multi-selection options missing');
assert.match(companionSource, /data-ability-all[\s\S]*data-ability-none/, 'Pet Abilities All and None selections missing');
assert.match(companionSource, /config\.trackedAbilities = \[\.\.\.currentKeys\]/, 'Pet Abilities selections are not saved together');
assert.match(companionSource, /abilityFilter\.addEventListener\('focusout'[\s\S]*abilityFilter\.open = false/, 'ability filter does not close after focus leaves');
assert.match(styleSource, /\.gc-ability-picker \{ position:absolute;top:39px;right:0/, 'ability filter still shifts the panel layout');
assert.match(styleSource, /\.gc-ability-filter>summary \{ height:34px/, 'ability filter does not align with the search field');
assert.match(styleSource, /\.gc-ability-log-actions \.gc-log-search \{[^}]*height:34px[^}]*margin:0/, 'ability history search field retains its global top margin');
assert.match(companionSource, /\['Plant Growth Boost', \['PlantGrowthBoost', 'PlantGrowthBoostII', 'PlantGrowthBoostIII', 'SnowyPlantGrowthBoost', 'DawnPlantGrowthBoost', 'AmberPlantGrowthBoost', 'ThunderPlantGrowthBoost'\]\]/, 'plant growth abilities are not grouped');
assert.match(companionSource, /\['Mutation Granter', \['RainDance'.*'RainbowGranter'.*'ThunderstruckGranter'\]\]/, 'mutation granters are not grouped');
for (const excludedAbility of ['HungerBoost', 'PetMutationBoost', 'ProduceMutationBoost', 'MoonKisser', 'Copycat', 'DawnCapture', 'Thundercharger', 'DawnbinderBoost']) assert.match(companionSource, new RegExp(`EXCLUDED_TRACKED_ABILITIES[\\s\\S]*'${excludedAbility}'`), `${excludedAbility} is not excluded from proc tracking`);
assert.match(companionSource, /const ABILITY_SET = new Set\(TRACKED_ABILITY_CATALOG\)/, 'excluded abilities can still be collected');
assert.match(companionSource, /config\.silencedAbilities = savedSilencedAbilities\.filter\(ability => !EXCLUDED_TRACKED_ABILITIES\.has\(ability\)\)/, 'saved excluded silence selections are not removed');
const silenceSource = companionSource.slice(companionSource.indexOf('function renderSilence()'), companionSource.indexOf('function bindListSearch'));
assert.match(silenceSource, /TRACKED_ABILITY_CATALOG\.map/, 'silence list does not apply tracked ability exclusions');
assert.doesNotMatch(silenceSource, /(?<!TRACKED_)ABILITY_CATALOG\.map/, 'silence list still includes excluded abilities');
assert.match(companionSource, /abilityFilterInteracting/, 'ability dropdown redraw guard missing');
assert.match(companionSource, /function refreshAbilityFilterUi/, 'the ability filter has no in-place refresh');
assert.match(companionSource, /refreshAbilityFilterUi\(main\)/, 'ability filter selections still require a full panel redraw');
// Growth savings arrive as raw seconds, and the egg boost reports its eggs and its time together.
assert.match(abilityLogSource, /const saved = `\$\{formatReduction\(data\.secondsReduced\)\} reduced`;/, 'growth savings are still shown as raw seconds');
// Boost rows read as what was affected, then what it got, rather than facts joined by a pipe.
assert.match(abilityLogSource, /const ARROW = '->';/, 'boost outcomes no longer point from the amount to its effect');
assert.match(abilityLogSource, /return `\$\{count\} \$\{ARROW\} \$\{boost\}`;/, 'crop size boost does not read as plants then gain');
assert.doesNotMatch(abilityLogSource, /parts\.join\(' \| '\)/, 'a boost outcome still joins its parts with a pipe');
// Plant growth reports numPlantsAffected, a count rather than a list, and it is checked last.
assert.match(abilityLogSource, /return data\.numPlantsAffected != null \? `\$\{countLabel\(Number\(data\.numPlantsAffected\), 'plant'\)\} \$\{ARROW\} \$\{saved\}` : saved;/, 'the plant growth boost reports its time without saying how many plants it hit');
assert.match(abilityLogSource, /if \(data\.eggsAffected\) return withReduction\(countLabel\(payloadItemCount\(data\.eggsAffected\), 'egg'\), data\.secondsReduced\);/, 'the egg growth boost hides the time it saved, or still lists every egg in the row');
assert.match(abilityLogSource, /if \(data\.growSlotsAffected\) return withReduction\(countLabel\(payloadItemCount\(data\.growSlotsAffected\), 'plant'\), data\.secondsReduced\);/, 'the plant growth boost does not report how many plants it touched');
// The breakdown moved to a tooltip, so the filter has to look there or those names become unfindable.
assert.match(abilityLogSource, /procOutcome\(log\.ability, log\.data\)} \$\{procOutcomeTooltip\(log\.ability, log\.data\)}`\.toLowerCase\(\)/, 'ability log search cannot reach detail held in a tooltip');
// The history runs to hundreds of rows per ability, so neither the filter nor the search may do
// per-row work that scales with the filter options or rebuild formatted text on every keystroke.
assert.match(abilityLogSource, /const visible = visibleAbilities\(selectedFilters\);/, 'the ability filter is resolved per row again');
assert.match(abilityLogSource, /const searchTextCache = new WeakMap<AbilityLogRow, string>\(\);/, 'ability log search text is rebuilt for every keystroke');
assert.match(abilityLogSource, /const owners = indexOwnedPets\(\);/, 'the ability log rebuilds the pet list for every row it draws');
// A sprite data url written into every row is megabytes of markup per keystroke.
assert.match(abilityLogSource, /<img data-log-sprite="\$\{escapeHtml\(key\)}"/, 'ability log rows carry a full sprite data url again');
assert.match(abilityLogSource, /hydrateAbilityLogSprites\(log\);/, 'filtered ability rows never get their sprites');
assert.match(abilityLogSource, /hydrateAbilityLogSprites\(main\);/, 'ability rows drawn with the panel never get their sprites');
// Options passed to toLocaleDateString build a formatter per call, and the log draws hundreds of
// rows per keystroke.
assert.match(abilityLogSource, /const LOG_DATE_FORMAT = new Intl\.DateTimeFormat\(undefined, /, 'the ability log builds a date formatter for every row');
assert.doesNotMatch(abilityLogSource, /toLocaleDateString\(undefined, \{/, 'the ability log formats dates the slow way again');
assert.doesNotMatch(abilityLogSource, /allPets\(\)\.find/, 'the ability log scans every pet per row again');
const abilityFilterEvents = abilityLogSource.slice(abilityLogSource.indexOf("const abilityFilter = main.querySelector('[data-ability-filter]')"));
assert.doesNotMatch(abilityFilterEvents, /renderPanel\(\)/, 'ability filter selection closes the dropdown by redrawing the panel');
assert.match(companionSource, /panelRefreshTimer = setTimeout[\s\S]*panelRefreshBlocked\(panel\)/, 'queued panel refresh does not re-check the open ability dropdown');
assert.match(abilityFilterEvents, /if \(abilityFilter\.open\) panelActions\.cancelPanelRefresh\(\)/, 'opening the ability dropdown does not cancel a queued panel refresh');
assert.match(companionSource, /abilityLog\.matches\(':hover'\) \|\| abilityLog\.scrollTop > 0/, 'proc history does not pause redraws while browsing');
assert.match(companionSource, /function selectPanelTab[\s\S]*cancelPanelRefresh\(\);[\s\S]*activeTab = tab/, 'tab selection does not cancel pending panel redraws');
assert.match(companionSource, /button\.onpointerdown = event =>[\s\S]*selectPanelTab\(button\.dataset\.tab\)/, 'panel tabs still wait for a click that can be lost during redraw');
assert.match(companionSource, /button\.onclick = \(\) => selectPanelTab\(button\.dataset\.tab\)/, 'panel tabs lack keyboard click handling');
assert.doesNotMatch(companionSource, /data-track=/, 'legacy ability tracking checkboxes remain');
assert.match(companionSource, /function combinedAbilityRows/, 'combined active-pet ability calculations missing');
assert.match(companionSource, /details\?\.baseProbability \?\? proc\?\.chance/, 'bundle proc chances are not used by combined abilities');
assert.match(companionSource, /Reduces hunger depletion by \$\{percent\(scaled\('hungerRefundPercentage'\)\)\}%/, 'Hunger Boost effect text is incorrect');
assert.doesNotMatch(companionSource, /Hunger refunded:/, 'Hunger Boost is incorrectly described as refunding hunger');
for (const passiveFamily of ['HungerBoost', 'WeatherMutationBoost', 'PetMutationBoost', 'DawnbinderBoost']) assert.match(companionSource, new RegExp(`key: '${passiveFamily}'`), `${passiveFamily} is not grouped for stacking`);
assert.match(companionSource, /return sum \+ base \* strength \/ 100;/, 'passive ability contributions are not stacked using each pet strength');
assert.match(companionSource, /entry\.pet\.hunger <= 0 \|\| requiredWeather && state\.game\?\.weather !== requiredWeather/, 'inactive passive ability owners are still included');
assert.match(companionSource, /ProduceEater: \{ chance: 60/, 'Crop Eater uses a stale ability id');
assert.match(companionSource, /SellBoostI: \{ chance: 10/, 'Sell Boost I uses a stale ability id');
assert.match(companionSource, /PetAgeBoostIII: \{ chance: 70/, 'Hatch XP Boost III calculation is missing');
assert.match(companionSource, /SeedFinderIV: \{ chance: \.01/, 'Seed Finder IV calculation is missing');
assert.match(companionSource, /PlantGrowthBoostIII: \{ chance: 30/, 'Plant Growth Boost III calculation is missing');
assert.match(companionSource, /values\.cooldownSeconds \/ Math\.max\(strength \/ 100, \.01\)/, 'activated ability cooldown does not use inverse strength scaling');
assert.doesNotMatch(companionSource, /Object\.entries\(details\?\.baseParameters/, 'raw ability parameter flavor text remains');
assert.match(companionSource, /PetXpBoost:\s*\{ baseChance: 30, baseXp: 300 \}/, 'Pet XP Boost reference values are missing');
assert.match(companionSource, /PetXpBoostI:\s*\{ baseChance: 30, baseXp: 300 \}/, 'Pet XP Boost I reference values are missing');
assert.match(companionSource, /PetXpBoostII:\s*\{ baseChance: 35, baseXp: 400 \}/, 'Pet XP Boost II reference values are missing');
assert.doesNotMatch(companionSource.slice(companionSource.indexOf('function teamXpPerHour'), companionSource.indexOf('function formatEstimate')), /baseParameters\?\.bonusXp/, 'maximum-strength estimates still count unrelated bundle XP abilities');
assert.match(companionSource, /xpToMax \/ xpRate \* 3600/, 'time until maximum pet strength missing');
assert.match(companionSource, /function teamXpPerHour\(pets: Pet\[\]\)/, 'active-team XP ability calculation is missing');
assert.match(companionSource.slice(companionSource.indexOf('function teamXpPerHour'), companionSource.indexOf('function formatEstimate')), /if \(pet\.hunger <= 0\) continue;/, 'hungry pets still contribute XP ability bonuses');
assert.match(companionSource.slice(companionSource.indexOf('function combinedAbilityRows'), companionSource.indexOf('function snapshotPayload')), /if \(pet\.hunger <= 0\) continue;/, 'hungry pets still contribute combined ability rates');
assert.match(companionSource, /const xpRate = teamXpPerHour\(active\)/, 'active pet cards do not use the full per-pet XP rate');
assert.match(companionSource, /XP\/hour per pet/, 'XP rate is not labelled as applying independently to every pet');
assert.match(companionSource, /const XP_PER_POTION = 20_000/, 'XP potion value is not defined');
assert.match(companionSource, /Math\.ceil\(metrics\.xpToMax \/ XP_PER_POTION\)/, 'XP potion estimate does not use each pet remaining XP');
assert.match(companionSource, /XP potion\$\{potionsToMax === 1 \? '' : 's'\} to max/, 'XP potion estimate is not shown on active pet cards');
assert.match(styleSource, /\.gc-pet-potions \{[^}]*color:#c4b5fd/s, 'XP potion estimate lacks active pet card styling');
assert.match(companionSource, /function renderAbilityLog/, 'Pet Abilities history tab missing');
assert.doesNotMatch(companionSource.slice(companionSource.indexOf('function renderAbilities()'), companionSource.indexOf('function renderAbilityLog()')), /Recent tracked procs/, 'proc history remains on Active Pets');
assert.match(companionSource, /activeTab === 'abilityLog' \? 'gc-ability-log-tab' : ''/, 'Pet Abilities tab cannot use the full panel height');
assert.match(companionSource, /gc-card gc-ability-log-card/, 'recent proc card lacks its expanding layout class');
assert.match(styleSource, /\.gc-ability-log-card \{[^}]*min-height:0[^}]*flex:1[^}]*display:flex[^}]*flex-direction:column/s, 'recent proc card does not expand vertically');
assert.match(styleSource, /\.gc-ability-log-tab \.gc-log \{[^}]*max-height:none[^}]*flex:1/s, 'recent proc list remains height-limited');
assert.match(companionSource, /\['seed', 'Seeds'\], \['dawn', 'Dawn'\], \['thunder', 'Thunder'\], \['snow', 'Snow'\], \['egg', 'Eggs'\], \['tool', 'Tools'\], \['decor', 'Decor'\]/, 'shop alarm tab order is incorrect');
for (const seasonalItem of ['Dawnbreaker', 'DawnCelestial', 'DawnEgg', 'ThunderCelestial', 'ThunderEgg', 'SnowEgg', 'ChilledPotion', 'FrozenPotion']) assert.ok(companionSource.includes(seasonalItem), `seasonal shop item ${seasonalItem} missing`);
assert.match(companionSource, /gc-team-abilities/, 'team creation does not show pet abilities');
assert.match(companionSource, /data-team-search placeholder="Filter by pet name, species, location, or ability"/, 'team pet filter is missing');
assert.match(companionSource, /Press Escape while recording to clear it/, 'keybind Escape guidance is missing');
assert.match(companionSource, /Press keys\.\.\. Esc cancels/, 'pet team key capture does not show Escape guidance');
assert.match(companionSource, /pet\.name[\s\S]*pet\.petSpecies[\s\S]*ABILITY_DETAILS\[ability\]\?\.name[\s\S]*\.toLowerCase\(\)/, 'team pet filter does not include names, species, and abilities');
assert.match(petTeamsSource, /bindListSearch\(picker\.querySelector\('\[data-team-search\]'\)\)/, 'team pet filter is not bound');
// Team order drives the keybinds and the cycle shortcut, so it is worth being able to set.
assert.match(petTeamsSource, /send\(\{ type: 'MovePetTeam', movePetTeamId: teamId, toPetTeamIndex: target \}\)/, 'teams cannot be reordered');
assert.match(petTeamsSource, /if \(index < 0 \|\| target < 0 \|\| target >= order\.length\) return;/, 'a team can be moved outside the list');
// The pointer is over the team list when the new order lands, which is when live refresh stands down.
assert.match(petTeamsSource, /function refreshCompletedTeamMove[\s\S]*panelActions\.renderPanelPreservingScroll\(\)/, 'a reordered team list is not redrawn when the new order arrives');
assert.match(companionSource, /refreshCompletedTeamMove\(\);/, 'the reorder redraw is never given a chance to run');
// #gc-panel button sets padding and font, so the arrows need matching specificity to size at all.
assert.match(styleSource, /#gc-panel \.gc-team-order button \{[^}]*padding:0/, 'the team reorder arrows overflow their buttons');
assert.doesNotMatch(petTeamsSource.slice(petTeamsSource.indexOf('function petPickerRows('), petTeamsSource.indexOf('export function activeTeamId()')), /hungerDisplay\(pet\)/, 'team creation still shows hunger');
assert.match(companionSource, /SavePetTeam', teamId, name/, 'saved teams cannot be updated');
assert.match(companionSource, /data-edit-team/, 'saved team edit control missing');
assert.match(companionSource, /refreshCompletedTeamSave\(\);[\s\S]*processActivities\(\)/, 'saved team state does not trigger a team refresh');
assert.match(companionSource, /pendingTeamSave = \{ teamId, name, petIds, emblem: teamId \? null : emblem \}/, 'team save completion is not tracked');
assert.doesNotMatch(companionSource, /\b(?:confirm|alert|prompt)\s*\(/, 'blocking browser dialog remains');
assert.match(companionSource, /data-confirm-delete-team/, 'non-blocking team deletion confirmation is missing');
assert.match(companionSource, /pendingTeamDeleteId = teamId/, 'team deletion completion is not tracked');
assert.match(companionSource, /refreshCompletedTeamDelete\(\);[\s\S]*processActivities\(\)/, 'deleted team state does not trigger a team refresh');
assert.match(companionSource, /!pendingTeamDeleteId \|\| teams\(\)\.some\(team => team\.id === pendingTeamDeleteId\)/, 'team view refreshes before deletion is confirmed');
assert.match(companionSource, /data-team-card/, 'saved team cards cannot be updated individually');
assert.match(companionSource, /if \(deletedCard && cards\.length > 1\) deletedCard\.remove\(\)/, 'deleted team card is not removed in place');
assert.match(companionSource, /data-delete-team[\s\S]*renderPanelPreservingScroll\(\)/, 'opening team deletion confirmation loses the scroll position');
assert.match(companionSource, /querySelectorAll<HTMLInputElement>\('#gc-panel \[data-team-key\]'\)[\s\S]*field\.value = config\.teamKeybinds/, 'team keybind changes still redraw the panel');
assert.match(companionSource, /\[880, 660, 880, 660, 0\]\[alarmPhase\+\+ % 5\]/, 'shop alarm does not use the alternating warning pattern');
assert.match(companionSource, /gain\.gain\.setValueAtTime\(\.25, now\)/, 'shop alarm is not loud enough');
assert.match(companionSource, /setInterval\(playAlarmTone, 420\)/, 'shop alarm warning pattern is not persistent');
assert.match(companionSource, /const VALUE_PREFIX = '🪙 ';/, 'crop value label is incorrect');
assert.match(companionSource, /const GROWTH_PREFIX = '🐢 ';/, 'growth estimate label is incorrect');
assert.match(companionSource, /`\$\{VALUE_PREFIX\}\$\{Math\.round/, 'crop value line does not use the coin prefix');
assert.match(companionSource, /`\$\{GROWTH_PREFIX\}\$\{formatDuration/, 'growth estimate line does not use the turtle prefix');
// The estimate has to land on the crop the game's own card is showing, gaps in slot ids and all.
assert.match(companionSource, /const bySlotId = \[\.\.\.crops\]\.sort\(\(left, right\) => Number\(left\?\.slotId\) - Number\(right\?\.slotId\)\);/, 'crop estimates pick a slot by array order rather than by slot id');
assert.match(companionSource, /bySlotId\.find\(slot => Number\(slot\?\.slotId\) >= selected\) \?\? bySlotId\[0\]/, 'a harvested slot id no longer falls through to the next crop');
// mySelectedSlotIdAtom is a primitive atom, so its value only ever moves through a write.
assert.match(companionSource, /if \(typeof atom\.write === 'function'\) \{\s*\n\s*const originalWrite = atom\.write;/, 'a primitive game atom changes value without the panel noticing');
assert.match(companionSource, /endsWith\('\/quinoaEngineAtom'\)/, 'game engine capture does not use the engine atom');
assert.match(companionSource, /engine\.getSystem\('gardenInfoCard'\)\?\.view/, 'garden card system is not captured from the game engine');
assert.match(companionSource, /key: 'time',[\s\S]*gardenCompanionEstimate: true/, 'estimates are not inserted as native garden card attributes');
assert.match(companionSource, /attributes: \[\.\.\.attributes, \.\.\.estimateAttributes\]/, 'native estimate attributes are not included in card measurement');
assert.doesNotMatch(companionSource, /nativeTimer\.text\}\\n/, 'native timer still uses the unsupported multiline layout');
assert.match(companionSource, /function shiftNativeRowToCardCenter[\s\S]*for \(const peer of peers\) peer\.x \+= offset \/ worldScale/, 'crop timer and estimate row is not centred as one unit');
assert.match(companionSource, /if \(!signature\.startsWith\(VALUE_PREFIX\)\) return false/, 'egg estimate is still repositioned away from the native timer row');
assert.doesNotMatch(companionSource, /gardenCompanionEggEstimateLayout|nativeBottom|section\.height \+= extraHeight/, 'legacy egg second-row layout remains');
assert.match(companionSource, /if \(refreshNativeGardenCard\(\)\) return;/, 'HTML estimate fallback remains active after the native hook succeeds');
assert.doesNotMatch(companionSource, /requestAnimationFrame\(renderTurtleOverlay\)/, 'garden card estimates still run every animation frame');
assert.match(companionSource, /setInterval\(renderTurtleOverlay, 250\)/, 'garden card estimate refresh is not throttled');
const panelSource = await readSource('src', 'companion.ts');
const featuresSource = panelSource.slice(panelSource.indexOf('function renderFeatures()'), panelSource.indexOf('function renderAbilities()'));
for (const removedToggle of ['overview', 'petTeams', 'abilities', 'rooms', 'shopAlarms', 'interfaceShortcuts', 'abilitySilencer', 'lunarTimer']) {
  assert.doesNotMatch(featuresSource, new RegExp(`\\['${removedToggle}',\\s*'`), `removed ${removedToggle} feature toggle remains`);
}
assert.match(styleSource, /\.gc-pet-sprite \{[^}]*width:48px[^}]*height:48px/s, 'pet sprite frame size is incorrect');
assert.match(styleSource, /\.gc-pet-sprite img \{[^}]*width:40px[^}]*height:40px/s, 'pet sprite artwork lacks safe scaling');
assert.match(styleSource, /\.gc-pet-sprite img \{[^}]*image-rendering:auto/s, 'pet sprites are not smoothly scaled');
assert.match(styleSource, /\.gc-shop-sprite img \{[^}]*image-rendering:auto/s, 'shop sprites are not smoothly scaled');
assert.match(styleSource, /#gc-panel img,#gc-alarm img,#gc-turtle img,#gc-overview-panel img \{ image-rendering:auto!important; \}/, 'smooth scaling is not applied to every companion-owned image');
assert.doesNotMatch(styleSource, /image-rendering:pixelated/, 'companion sprites still force pixelated scaling');
assert.match(companionSource, /function renderMutatedPetSprite/, 'per-species pet mutation rendering is missing');
assert.match(companionSource, /pixels\[\(y \* canvas\.width \+ x\) \* 4 \+ 3\] < 8/, 'rainbow gradient does not inspect visible pet pixels');
assert.match(companionSource, /createLinearGradient\(minimum \/ 2, minimum \/ 2, maximum \/ 2, maximum \/ 2\)/, 'rainbow gradient is not fitted to each pet body');
assert.match(companionSource, /globalCompositeOperation = 'color'/, 'rainbow sprite rendering does not preserve luminosity');
assert.match(companionSource, /globalCompositeOperation = 'destination-in'/, 'pet mutation rendering is not clipped to sprite transparency');
assert.doesNotMatch(styleSource, /gc-pet-sprite\[data-overlay=/, 'legacy CSS pet mutation overlay remains');
assert.match(companionSource, /send\(\{ type: 'FeedPet', petItemId, cropItemId \}\)/, 'pet food panel does not send the game feed command');
assert.match(companionSource, /petFood: true/, 'pet food panel is not enabled by default');
assert.match(companionSource, /item\?\.itemType === 'Produce'/, 'held produce is not read from the inventory');
assert.match(companionSource, /produceValue\(item\) > produceValue\(chosen\)/, 'feeding does not spend the most valuable matching crop');
assert.match(companionSource, /PET_CATALOG\[species\]\?\.diet \|\| \[\]/, 'preferred foods are not limited to each species diet');
assert.match(companionSource, /petFoodSignature = signature/, 'pet food panel redraws without change detection');
assert.match(companionSource, /const LIVE_REFRESH_TABS = \['abilities', 'abilityLog', 'petFood', 'teams', 'calculators', 'journal'\]/, 'state-backed tabs do not follow live game changes');
assert.match(companionSource, /activeTab === 'calculators'\) return calculatorsSignature\(\)/, 'the calculator tab lacks change-aware refreshes');
assert.match(companionSource, /activeTab === 'journal'\) return journalSignature\(\)/, 'the journal tab lacks change-aware refreshes');
assert.match(companionSource, /gc-petfood-count/, 'produce counts are not overlaid on the food icon');
assert.match(companionSource, /quinoaEngine\(\)\?\.getSystem\?\.\('petSlots'\)\?\.view/, 'pet food buttons are not docked to the native pet panel');
assert.match(companionSource, /blocked: Boolean\(view\.actionButtonGroup\) \|\| view\.selectedPetSlotId != null/, 'pet food buttons ignore an open pet card');
assert.match(companionSource, /if \(!dock \|\| dock\.blocked \|\| !anchors\.length \|\| petPanelCovered\(anchors\[0\]\)\) \{\s*panel\.hidden = true;/, 'pet food buttons stay visible over the native action buttons or overlays');
assert.match(companionSource, /dock\.byPet \? dock\.byPet\.get\(button\.dataset\.feedPet \|\| ''\)/, 'pet food buttons are not paired to their own pet');
assert.match(companionSource, /findVisiblePixiNodes\(surface, \['PetSlots', 'PetActionButtons'\]\)/, 'pet panel dock has no fallback when the engine system is unavailable');
assert.match(companionSource, /setInterval\(positionPetFood, 250\)/, 'docked pet food buttons do not track the pet panel');
assert.doesNotMatch(companionSource, /PET_FOOD_POSITION_KEY/, 'free-floating pet food panel position remains');
assert.match(petSpriteSource, /__gardenCompanionProduceSprites/, 'produce atlas sprites are not exposed');
assert.match(petSpriteSource, /cropFrames\(atlas, sheet, trimmedWanted, trimmedOutput, true\)/, 'produce sprites are not trimmed to their drawn pixels');
assert.match(petSpriteSource, /const trim = trimmed \? \{ x: 0, y: 0, w: frame\.w, h: frame\.h \} : null/, 'trimmed crops swap the dimensions of rotated atlas frames');
assert.match(petSpriteSource, /mapFrom\(produceCandidates, trimmed\)/, 'produce icons still use padded atlas frames');
assert.match(styleSource, /\.gc-petfood-count \{[^}]*position:absolute/, 'produce count badge is not overlaid');
assert.match(styleSource, /#gc-petfood \{[^}]*pointer-events:none/, 'docked pet food layer still blocks game clicks');
assert.match(styleSource, /#gc-petfood \[data-food-row\] \{[^}]*overflow:hidden/, 'food icons can spill outside their button');
assert.match(styleSource, /#gc-petfood \[data-food-row\] \{[^}]*box-sizing:border-box/, 'food button borders are added outside the docked size');
assert.doesNotMatch(styleSource, /#gc-petfood \[data-food-row\] img \{[^}]*%/, 'food icons use percentage sizing, which a button content box can resolve to auto');
assert.match(companionSource, /icon\.style\.height = `\$\{iconSize\}px`/, 'food icons are not sized in pixels against the docked button');
assert.match(companionSource, /roomAvatars\(slots\)/, 'room rows do not show player avatars');
assert.match(companionSource, /parsed\.protocol === 'https:' \|\| parsed\.protocol === 'http:'/, 'avatar URLs are not restricted to web protocols');
assert.match(companionSource, /referrerpolicy="no-referrer"/, 'avatar requests leak the game referrer');
assert.match(companionSource, /data-open-team-picker/, 'team creation does not open the popout picker');
assert.match(companionSource, /function openTeamPicker\(teamId: string \| null \| undefined\)/, 'team picker is missing');
assert.doesNotMatch(petTeamsSource.slice(petTeamsSource.indexOf('export function renderTeams()'), petTeamsSource.indexOf('export function teamsSignature()')), /data-pet-id/, 'the pet chooser is still inline in the Pet Teams tab');
assert.match(companionSource, /send\(\{ type: 'SetPetTeamEmblem', teamId, emblem \}\)/, 'team emblems are not saved to the game');
assert.match(companionSource, /if \(expected\.emblem && emblemKey\(expected\.emblem\) !== emblemKey\(saved\.emblem\)\) setPetTeamEmblem\(saved\.id, expected\.emblem\)/, 'a new team emblem is not applied once the game assigns an id');
assert.match(companionSource, /const EMBLEM_ICONS = \['rainbow', 'gold', 'thunder', 'dawn', 'amber', 'wet', 'chilled', 'frozen', 'coin', 'egg'\]/, 'emblem icon list is incomplete');
assert.match(companionSource, /Array\.from\(\{ length: 26 \}, \(_, index\) => String\.fromCharCode\(65 \+ index\)\)/, 'emblem letters do not cover A to Z');
assert.match(companionSource, /return \{ type: 'number', number: Number\(value\) \}/, 'letter emblems are not sent as their alphabet number');
assert.match(companionSource, /function takenEmblemNumbers\(\)/, 'letter emblems already used by another team are still offered');
assert.match(companionSource, /if \(teamPickerEmblem\?\.type === 'pet' && !species\.has\(teamPickerEmblem\.petSpecies\)\) teamPickerEmblem = null/, 'a pet emblem can outlive its species leaving the team');
assert.match(companionSource, /const MAX_PET_TEAMS = 25/, 'the game team limit is not enforced');
assert.match(companionSource, /const MAX_TEAM_PETS = 3/, 'the team pet limit is not shared');
assert.match(companionSource, /const full = count >= MAX_TEAM_PETS && !input\.checked;\s*input\.disabled = full;/, 'the picker still allows selecting a fourth pet');
assert.match(petSpriteSource, /rainbow: 'MutationRainbow', gold: 'MutationGold', thunder: 'MutationThundercharged'/, 'emblem icons do not use the games own sprites');
assert.match(petSpriteSource, /__gardenCompanionEmblemSprites/, 'emblem atlas sprites are not exposed');
assert.match(companionSource, /page\.__gardenCompanionEmblemSprites\?\.\[icon\]/, 'the emblem picker does not render game sprites');
assert.match(companionSource, /if \(!teamId && teams\(\)\.length >= MAX_PET_TEAMS\)/, 'a 26th team can still be requested');
assert.match(companionSource, /function teamMemberTile\(member/, 'saved teams do not show pet sprites');
assert.match(companionSource, /const filled = team\.members\.map\(member => teamMemberTile\(member, owned\.get\(member\.petId\)\)\)/, 'team cards do not render member tiles');
assert.match(companionSource, /MAX_TEAM_PETS - team\.members\.length/, 'team cards do not show their empty slots');
assert.match(styleSource, /\.gc-team-pets \{ display:grid/, 'team pets are not laid out on a grid');
assert.match(companionSource, /function activeTeamId\(\)/, 'the active team is not highlighted');
assert.match(styleSource, /\.gc-team-card\[data-active=true\]/, 'the active team card has no styling');
assert.match(companionSource, /function tabRefreshSignature\(\)/, 'live tabs redraw without change detection');
assert.match(companionSource, /function refreshTeamActiveMarkers\(\)/, 'the active team badge is not updated in place');
assert.match(companionSource, /refreshTeamActiveMarkers\(\);\s*refreshOpenPanel\(\)/, 'active team changes do not reach the open Pet Teams tab');
assert.doesNotMatch(petTeamsSource.slice(petTeamsSource.indexOf('export function teamsSignature()'), petTeamsSource.indexOf('export function requestTeamDelete(')), /activeTeamId\(\)/, 'the active team still forces a full Pet Teams redraw');
assert.match(companionSource, /const signature = tabRefreshSignature\(\);\s*if \(signature && signature === lastTabSignature\) return;/, 'an unchanged tab still schedules a redraw');
assert.match(companionSource, /return Boolean\(scrollable\?\.matches\(':hover'\)\)/, 'a redraw can interrupt scrolling in the Pet Teams and Pet Food tabs');
// An absent id equals an absent id, so a slot must never be matched on one: that handed us
// another player's slot in a lobby where the ids had not filled in yet.
// Two independent sources for who we are: the game's own slot atom, and the Welcome frame it
// seeds that atom from. Losing either must not put the panel back on another player's data.
assert.match(companionSource, /if \(typeof data !== 'string' \|\| !data\.includes\('"selfPlayerId"'\)\) return;/, 'the Welcome frame is no longer read for our player id');
// Welcome is the first frame after a socket opens, so the listener goes on at construction rather
// than being polled for, reusing the wrapper the update detector already installs.
assert.match(companionSource, /socket\.addEventListener\('close', handleGameSocketClose\);\s*listenForWelcome\(socket\);/, 'the Welcome listener can miss the frame it exists to read');
assert.match(companionSource, /state\.playerId = welcomePlayerId \|\|/, 'the Welcome player id is no longer preferred');
assert.match(companionSource, /if \(playerId\) \{\s*let slot = slots\.find/, 'a cached slot index can override a live id match');
assert.match(gameAtomsSource, /hookAtom\('playerIdAtom', 'atomPlayerId'\);/, "the game's empty starting player id can overwrite ours");
assert.match(companionSource, /const own = state\.userSlotIndex;\s*if \(typeof own === 'number' && own >= 0 && slots\[own\]\) return \{ slot: slots\[own\], index: own \};\s*return \{ slot: null, index: null \};/, 'a missing player id still guesses a user slot');
assert.match(companionSource, /if \(databaseId\) slot = slots\.find\(/, 'a missing database id still matches a user slot');
assert.match(companionSource, /const owned = new Map\((?:services\.)?allPets\(\)\.map\(pet => \[pet\.id, pet\]\)\)/, 'team member sprites rescan every pet per tile');
assert.match(companionSource, /const CALCULATOR_TABS = \[\['dust', 'Dust'\], \['value', 'Crop Value'\], \['food', 'Food'\], \['granter', 'Granters'\]\]/, 'calculator sub-tabs are missing');
// The crop value calculator has to match the game's own sums, not an approximation of them.
assert.match(mutationValueSource, /return \(growth \? MUTATION_CATALOG\[growth\]\.coinMultiplier : 1\) \* \(1 \+ added - others\.length\);/, 'crop mutation value no longer stacks the way the game does');
assert.match(calculatorsSource, /const mutation = catalogMutationMultiplier\(selected\);/, 'the crop value calculator no longer uses the shared catalog multiplier');
// The crop value calculator speaks in the numbers the game prints on a crop, not the raw scale.
assert.match(calculatorsSource, /weight: scale \* \(Number\(crop\?\.baseWeight\) \|\| 0\)/, 'crop weight is no longer taken from the catalog');
// Locale digit grouping turns 13,200,193 into 1,32,00,193 on an Indian locale, which reads as a
// corrupted number. Every printed number is pinned instead.
const numberSources = await Promise.all([
  ['src', 'companion.ts'], ['src', 'constants.ts'], ['src', 'pets.ts'],
  ['src', 'features', 'ability-log.ts'], ['src', 'features', 'calculators.ts'],
  ['src', 'features', 'crop-cleanser-helper.ts'], ['src', 'features', 'crop-estimates.ts'],
  ['src', 'features', 'fishing.ts'], ['src', 'features', 'garden-defence.ts'],
  ['src', 'features', 'garden-overview.ts'], ['src', 'features', 'journal.ts'],
  ['src', 'features', 'preserve-all.ts'],
].map(parts => readSource(...parts)));
for (const source of numberSources) {
  assert.doesNotMatch(source, /toLocaleString\(\)/, 'a number is printed in the browser locale instead of the pinned one');
}
assert.match(await readSource('src', 'utils.ts'), /export const NUMBER_LOCALE = 'en-US';/, 'the pinned number locale is gone');
assert.match(calculatorsSource, /if \(scale <= 1\) return 50;\s*if \(scale >= maxScale\) return 100;\s*return Math\.floor\(50 \+ 50 \* \(scale - 1\) \/ \(maxScale - 1\)\);/, 'crop size percent no longer matches the game');
assert.match(calculatorsSource, /write\('\[data-value-weight\]', formatWeight\(value\.weight\)\);/, 'weight does not follow the size slider');
assert.match(calculatorsSource, /write\('\[data-value-breakdown\]', valueBreakdown\(value\)\);/, 'the value breakdown does not follow the size slider');
assert.match(buildSource, /baseWeight:\(\[0-9\.e\+-\]\+\)/, 'the plant catalog no longer carries base weights');
// Preserve All spends real coins per slot, so it must copy the game's own preserve rules exactly.
assert.match(preserveAllSource, /Math\.round\(base \* \(Number\(targetScale\) \|\| 1\) \* catalogMutationMultiplier\(mutations\)\)/, 'the preserve price no longer matches what the game charges');
assert.match(preserveAllSource, /if \(!slot \|\| slot\.preserved === true \|\| slot\.slotId == null\) continue;\s+if \(Number\(slot\.endTime \|\| 0\) > now\) continue;/, 'preserve all no longer skips preserved or still-growing slots');
assert.match(companionSource, /const qualifies = slot => slot\?\.preserved !== true &&/, 'instant harvest can destroy a preserved crop');
// Crop Protection blocks the harvests instant harvest fires, so the two are mutually exclusive in
// config and again at the moment the key is pressed.
assert.match(companionSource, /if \(!feature\('instantHarvest'\) \|\| feature\('cropProtection'\) \|\|/, 'instant harvest still fires while Crop Protection is on');
assert.match(companionSource, /if \(input\.dataset\.feature === 'instantHarvest' && input\.checked\) config\.cropProtection = false;/, 'both harvest features can be enabled at once');
assert.match(protectionSource, /if \(enabled\.checked\) config\.instantHarvest = false;/, 'enabling Crop Protection leaves instant harvest on');
// The block has to happen on the way out, so every route into a harvest is covered.
assert.match(companionSource, /const blocked = blockOutgoingHarvest\(data\);\s*if \(!blocked\) return originalSend\.call\(this, data\);/, 'harvests are no longer blocked on the socket');
// A dropped command must be answered: the game's own five second timeout rejects, which skips
// the branch that undoes the harvest it already started drawing.
assert.match(companionSource, /if \(blocked\.requestId\) refuseCommand\(socket, blocked\.requestId\);/, 'a blocked harvest is left to time out');
assert.match(protectionSource, /type: 'QuinoaCommandResult', requestId, ok: false, code: 'garden_companion_blocked'/, 'the refusal no longer settles the game request');
// A harvest cannot be taken back, so an unknown garden holds rather than waves crops through.
assert.match(protectionSource, /if \(!garden\) return announce\(target, 'Harvest held/, 'harvests pass unprotected before the garden has loaded');
assert.match(protectionSource, /else delete next\[input\.dataset\.protectSpecies!\];/, 'unticked species are stored rather than dropped');
// The prune runs before the game's catalog is captured, so it must not test membership of it.
assert.match(configSource, /\.filter\(\(\[, on\]\) => on === true\)/, 'unticked species are no longer pruned');
assert.match(configSource, /!PET_CATALOG\[species\] \|\| PET_CATALOG\[species\]\.diet\?\.includes\(crop\)/, 'a pet food choice is dropped for a species newer than the baked catalog');
assert.doesNotMatch(configSource, /PLANT_CATALOG\[species\]/, 'pruning drops species the baked catalog has not caught up with');
assert.doesNotMatch(protectionSource, /'Gold'|'Rainbow'/, 'Gold and Rainbow are protected despite having their own hold to harvest');
assert.match(protectionSource, /MUTATION_CATALOG\[id\]\?\.group !== 'Growth'/, 'the colour mutations are no longer excluded from protection');
// Mutations and size are checked before the species list so an unticked species cannot expose them.
assert.match(protectionSource, /if \(matched\) return MUTATION_CATALOG[\s\S]*return 'max size';[\s\S]*if \(protectedSpecies\(\)\[species\] === true\)/, 'species protection no longer comes after the mutation rules');
assert.match(estimatesSource, /return protectionReason\(crop, crop\.species \|\| ''\) \? \[LOCK\] : \[\];/, 'the crop card padlock says more than that the crop is locked');
assert.match(companionSource, /'harvest', 'rainbowHarvest', 'goldHarvest', 'rarePatchHarvest'/, 'a rare patch crop under the cursor blocks instant harvest on the rest of the tile');
assert.doesNotMatch(companionSource, /'preservedHarvest'/, 'instant harvest accepts the preserved harvest action');
assert.match(preserveAllSource, /const card = findPixiCard\(\);/, 'preserve all no longer anchors to the game crop card');
// The bar sits over the world, so only the button itself may take clicks away from the game.
assert.match(styleSource, /#gc-preserve-all \{[^}]*pointer-events:none;/, 'the preserve all bar swallows clicks meant for the game');
assert.match(styleSource, /#gc-preserve-all button \{ pointer-events:auto;/, 'the preserve all button cannot be clicked');
assert.match(preserveAllSource, /if \(!state\.preservationMode\) \{ cancelHold\(\); return; \}/, 'a hold started at the station can still fire after the plant is put down');
assert.match(preserveAllSource, /if \(!state\.preservationMode \|\| rows\.length < 2\) return;/, 'preserve all can fire against the garden tile underfoot');
assert.match(preserveAllSource, /const progress = Math\.min\(1, \(performance\.now\(\) - holdStartedAt\) \/ HOLD_MS\);/, 'preserve all no longer needs a press and hold before spending coins');
assert.match(preserveAllSource, /if \(progress < 1\) \{ holdFrame = requestAnimationFrame\(tick\); return; \}\s*cancelHold\(\);\s*run\(\);/, 'preserve all can send before the hold completes');
assert.match(preserveAllSource, /const live = eligibleSlots\(\)\.find\(candidate => String\(candidate\.slotId\) === String\(row\.slotId\)\);/, 'preserve all no longer rechecks each slot as the batch runs');
assert.match(gameAtomsSource, /hookAtom\('isInPreservationModeAtom', 'preservationMode'\);/, 'the preservation station is no longer tracked');
assert.match(gameAtomsSource, /hookAtom\('myUserSlotIdxAtom', 'userSlotIndex'\);/, 'our own user slot index is no longer read from the game');
// debugLabels are bare names, so a hook written as a path never binds, and a bare endsWith would
// let lastCurrencyTransactionAtom answer to actionAtom.
assert.match(gameAtomsSource, /return label === match \|\| label\.endsWith\(`\/\$\{match\}`\);/, 'atom labels are matched loosely enough for one to swallow another');
assert.doesNotMatch(gameAtomsSource, /hookAtom\('[^']*\/[^']*'/, 'an atom hook is written as a path, which no debugLabel ever is');
assert.match(indexSource, /initPreserveAll\(\);/, 'preserve all is not started');
assert.match(calculatorsSource, /const each = Math\.round\(base \* scale \* mutation\);\s*\n\s*return \{[^}]*total: Math\.round\(each \* friend\)/, 'crop value no longer rounds before and after the room bonus');
assert.match(calculatorsSource, /Math\.min\(FRIEND_CAP, 1 \+ Math\.max\(0, Math\.floor\(friends\)\) \* FRIEND_STEP\)/, 'the room bonus is no longer capped the way the game caps it');
assert.match(calculatorsSource, /<span>Players<\/span><select data-value-friends>/, 'the room bonus selector is not labelled as total players');
assert.match(calculatorsSource, />\$\{count \+ 1\} \(\+\$\{Math\.round\(\(friendMultiplier\(count\) - 1\) \* 100\)\}%\)/, 'the room bonus player count is off by one');
assert.match(companionSource, /const DUST_RARITY: Record<string, number> = \{ Common: 1, Uncommon: 2, Rare: 5, Legendary: 10, Mythic: 50 \}/, 'dust rarity multipliers are wrong');
assert.match(companionSource, /hatch >= 50 \? 1 : hatch > 10 \? 2 : 5/, 'dust hatch multiplier does not match the calculator');
assert.match(companionSource, /weights\.set\(species, weight\)/, 'hatch chances are not derived from the egg catalog');
assert.match(calculatorsSource, /function hatchWeights\(\): Map<string, number>/, 'hatch chances are frozen at load, so a new egg is not counted');
assert.match(companionSource, /Math\.floor\(dustMultiplier\(pet\.petSpecies, pet\.mutations \|\| \[\]\) \* Number\(pet\.targetScale \|\| 1\)\)/, 'pet dust does not use the pets own size');
assert.match(companionSource, /1 - Math\.pow\(1 - \(ability \? ability\.probability \* granterStrengthFor\(index, pets\) \/ 100 : 0\) \/ 100, 1 \/ 60\)/, 'granter per-second chance does not match the calculator');
assert.match(companionSource, /function updateGranterResults\(main: HTMLElement\)/, 'granter sliders redraw the whole panel mid-drag');
assert.match(companionSource, /function updateGranterSection\(main: HTMLElement\)/, 'changing the ability does not rebuild the pet slots');
assert.match(companionSource, /function petMetrics\(pet: Pet \| undefined\)[\s\S]{0,160}if \(!pet\) return null;/, 'petMetrics throws on an empty pet slot');
assert.match(companionSource, /granterStrengths\[index\] \?\? \(pet \? (?:petHelpers\.)?petMetrics\(pet\)\?\.maxStrength : undefined\) \?\? 100/, 'unowned granters have no usable default Strength');
assert.match(companionSource, /Not owned - set a Strength to plan ahead/, 'unowned granter slots are not labelled');
assert.doesNotMatch(companionSource, /data-granter-ability[\s\S]{0,200}renderPanelPreservingScroll/, 'changing the granter ability still rebuilds the whole panel');
assert.doesNotMatch(companionSource, /data-granter-str[\s\S]{0,240}renderPanelPreservingScroll/, 'dragging a granter slider still rebuilds the panel');
assert.match(companionSource, /typeof details\.baseProbability === 'number'/, 'granter abilities are not read from the ability catalog');
assert.match(companionSource, /maxHunger \/ minutes \* 60 \/ Math\.min\(value, maxHunger\)/, 'food demand does not match the calculator');
assert.doesNotMatch(companionSource, /baseSellPrice: 800|slots: 7, regrows/, 'crop values and slots are duplicated instead of read from the plant catalog');
assert.match(companionSource, /\{ id: 'teamCycleNext', label: 'Next pet team', step: 1 \}/, 'pet team cycling keybinds are missing');
assert.match(companionSource, /function cyclePetTeam\(step: number\)/, 'pet team cycling is not implemented');
assert.match(companionSource, /TEAM_CYCLE_KEYS\.map\(item => shortcutRow\(/, 'team cycling keybinds are not shown on the Features tab');
assert.match(companionSource, /list\[\(\(\(current < 0 \? -step : current \+ step\) % list\.length\) \+ list\.length\) % list\.length\]/, 'team cycling does not wrap around');
assert.match(styleSource, /--gc-muted: rgba\(255,255,255,\.72\)/, 'secondary text is too dim to read');
assert.doesNotMatch(styleSource, /(?<![a-z-])color:rgba\(255,255,255,\.(0|1|2|3|4)[0-9]?\)/, 'low-contrast text colours remain');
assert.match(styleSource, /input::placeholder \{ color:rgba\(255,255,255,\.5\)/, 'placeholder text is unreadable');
assert.match(companionSource, /function renderKeybinds\(\)/, 'the keybinds tab is missing');
assert.doesNotMatch(featuresSource, /data-interface-key|data-overview-key/, 'keybinds remain on the Features tab');
assert.doesNotMatch(petTeamsSource, /data-team-key/, 'team keybind fields remain on the Pet Teams tab');
assert.match(companionSource, /teams\(\)\.map\(team => shortcutRow\(team\.name/, 'team keybinds are not listed on the Keybinds tab');
assert.match(companionSource, /const ABILITY_COLOURS = __ABILITY_COLOURS__/, 'ability chips do not use the games own colours');
assert.match(companionSource, /const ABILITY_COLOUR_FALLBACK = '#969696'/, 'ability chip fallback does not match the game');
assert.match(buildSource, /function abilityColoursFromBundle/, 'ability colours are not extracted from the bundle');
assert.match(buildSource, /if \(Object\.keys\(colours\)\.length >= 40\) return colours;/, 'a partial ability colour extraction can ship');
assert.ok(built.includes('#B49600'), 'extracted ability colours are missing from the build');
assert.ok(buildSource.includes('linear-gradient'), 'gradient ability colours are not extracted');
assert.ok(/RainbowGranter: "linear-gradient\(135deg, #C80000/.test(built), 'the rainbow granter chip is not a top-left to bottom-right gradient');
assert.ok(/GoldGranter: "linear-gradient\(135deg/.test(built), 'the gold granter chip is not a gradient');
assert.match(companionSource, /<p>\$\{escapeHtml\(humanize\(pet\.petSpecies\)\)\}<\/p>\$\{abilityChips\(pet\.abilities \|\| \[\]\)\}/, 'active pet cards do not show ability chips');
assert.match(companionSource, /\? abilityChips\(pet\.abilities \|\| \[\]\) : '<span class="gc-team-abilities">No abilities<\/span>'/, 'the team picker does not show ability chips');
assert.match(styleSource, /\.gc-pet-grid span\.gc-ability-chips \{[^}]*flex-direction:row;flex-wrap:nowrap/, 'picker ability chips stack instead of sitting in a row');
assert.match(companionSource, /gc-pet-str">\$\{metrics\.strength\}<i>\/\$\{metrics\.maxStrength\}/, 'the team picker does not show current and maximum Strength');
assert.match(plannerSource, /system\.updateTileData\(globalIndex, data\)/, 'the planner does not draw through the games tile system');
assert.doesNotMatch(plannerSource, /sendMessage|QuinoaCommand|SavePetTeam|HarvestCrop|PlantSeed/, 'the layout planner must never talk to the server');
assert.match(plannerSource, /dirt\.userSlotIdx === ownSlotIndex\(\)/, 'the planner can edit dirt tiles outside your own garden');
assert.match(plannerSource, /boardwalk\.userSlotIdx === ownSlotIndex\(\) && planner\.mode === 'decor'/, 'boardwalk tiles are not limited to your own decor');
assert.match(plannerSource, /indexes\[`board:\$\{local\}`\]/, 'boardwalk tiles cannot be planned');
assert.match(plannerSource, /function close\(\)[\s\S]{0,200}applyAllTiles\(\)/, 'leaving the planner does not restore the real garden');
assert.match(companionSource, /page\.__gardenCompanionTogglePlanner\?\.\(\)/, 'the planner cannot be opened from the panel');
assert.match(indexSource, /initGardenPlanner\(\);/, 'the planner is not installed');
assert.match(plannerSource, /function sortedSpecies\(\)[\s\S]{0,320}rarityRank\(left\) - rarityRank\(right\)/, 'the planner palette is not sorted by rarity');
assert.doesNotMatch(plannerSource, /data-plan-species'\)\.forEach\(button => button\.onclick = \(\) => \{[\s\S]{0,120}renderPanel\(\)/, 'selecting a plant still rebuilds the planner list');
assert.match(buildSource, /slotCapacity:\(\[0-9\]\+\)/, 'patch capacity is not read from the bundle');
assert.match(buildSource, /capacityBySeed/, 'rare patch variants do not inherit their parent capacity');
assert.match(plannerSource, /const RARITY_ORDER = \['Common', 'Uncommon', 'Rare', 'Legendary', 'Mythic', 'Divine', 'Celestial'\]/, 'celestial plants are not sorted last');
assert.match(plannerSource, /function patchSlotOffset\(index: number, count: number\)/, 'patch plants have no per-slot positions');
assert.match(plannerSource, /\.\.\.\(isPatch \? patchSlotOffset\(slotId, capacity\) : \{\}\)/, 'patch slots are placed without x and y, so only one crop draws');
assert.match(plannerSource, /const started = now - 3_600_000;\s*const matured = now - 60_000;/, 'planned plants use a zero length growth window, which breaks their size');
assert.doesNotMatch(plannerSource, /startTime: now - 60_000,\s*endTime: now - 60_000/, 'planned slots still start and end at the same instant');
assert.match(plannerSource, /!PLANTS\[name\]\?\.component/, 'component species still get their own planner button');
assert.match(plannerSource, /const grown = contents\?\.\[slotId\] \|\| PLANTS\[species\]\?\.slotSpecies\?\.\[slotId\] \|\| species;/, 'slot species overrides are ignored');
assert.match(buildSource, /speciesOverride:`\(\[A-Za-z0-9_\]\+\)`/, 'slot species overrides are not extracted');
assert.ok(built.includes('slotSpecies: ["ThunderCelestialShroomPlant"'), 'Thunderspire stormcap slots are missing');
assert.match(plannerSource, /const MUTATIONS = MUTATION_CATALOG/, 'planner mutations are not read from the game catalog');
assert.match(plannerSource, /if \(details\.group === button\.dataset\.group\) planner\.mutations\.delete\(id\)/, 'mutations in the same group are not exclusive');
assert.match(buildSource, /coinMultiplier:\(\[0-9\.\]\+\),group:/, 'the mutation catalog is not extracted');
assert.ok(built.includes('Dawncharged: { name: "Dawnbound"'), 'mutation display names are missing');
assert.match(companionSource, /function petPanelCovered\(anchor: PetDockRow\)/, 'feed buttons ignore overlays covering the pet panel');
assert.match(companionSource, /!top\.closest\('\.QuinoaCanvas'\) && !top\.closest\('#gc-petfood'\)/, 'the cover check does not test the game canvas');
assert.match(plannerSource, /data-plan-mode="plants"/, 'the planner has no plants and decor toggle');
assert.match(plannerSource, /objectType: 'decor', decorId: planner\.decorId, rotation: decorRotation\(\)/, 'decor tiles are not planned with a rotation');
assert.match(buildSource, /Decor\\./, 'the decor catalog is not extracted');
assert.match(plannerSource, /function fromPlannerUi\(event: Event\)/, 'planner clicks fall through to the farm');
assert.match(plannerSource, /if \(!planner\.open \|\| fromPlannerUi\(event\)\) return;/, 'clicking the planner panel still places a tile');
assert.match(plannerSource, /DECOR\[planner\.decorId\]\?\.rotates/, 'decor without rotation variants still offers a facing control');
assert.match(plannerSource, /return planner\.rotation === 0 \? -360 : -planner\.rotation;/, 'flipped decor is not encoded as a negative rotation');
assert.match(plannerSource, /data-plan-flip="true"/, 'decor cannot be flipped');
// A patch is built one crop at a time, and the rare variants share their cousin's patch.
assert.match(plannerSource, /patchSlotOffset\(slotId, capacity\)/, 'growing a patch rearranges the crops already placed in it');
assert.match(plannerSource, /Snowdrop: 'SnowdropDouble', SnowdropDouble: 'Snowdrop'/, 'rare crop variants cannot share their common patch');
assert.match(plannerSource, /function sharesPatch\(host: string, species: string\)[\s\S]*host === species \|\| PATCH_VARIANTS\[host\] === species/, 'patch hosting is not symmetric between a species and its variant');
assert.match(plannerSource, /place\(localIndex, event\.shiftKey\)/, 'shift-click no longer fills a patch in one go');
assert.match(plannerSource, /const custom = capacity > 0 && grown\.length > 0[\s\S]*grown\.some\(name => name !== host\)/, 'a part-filled or mixed patch is not saved with its layout');
// Appending to a full patch would be sliced straight back off, so the click looks like a no-op.
assert.match(plannerSource, /current\.length >= capacity\s*\?\s*\[\.\.\.current\.slice\(0, capacity - 1\), planner\.species\]/, 'a variant cannot be added to a patch that is already full');
assert.match(plannerSource, /const capacity = patchCapacity\(host\);/, 'patch capacity is measured on the selected species rather than the host tile');
assert.match(petSpriteSource, /decor: DECOR_IDS/, 'decor sprites still use a hardcoded list');
assert.ok(built.includes('FanousLantern: { name: "Fanous Lantern"'), 'newer decor is missing from the catalog');
// A fixed width both keeps the flex parent from stretching the button and keeps every launch
// button on the Features tab the same size, whatever its label says.
assert.match(styleSource, /#gc-panel \.gc-launch-row button \{[^}]*width:132px[^}]*flex:0 0 auto/, 'the launch buttons size themselves to their labels');
assert.match(plannerSource, /const NATIVE_UI_LABELS = \['GardenInfoCardSystem', 'ActionHud', 'PetActionButtons'\]/, 'the native crop card and action buttons are not hidden while planning');
assert.match(plannerSource, /function restoreNativeCardUi\(\)/, 'the native crop card is never restored');
assert.match(plannerSource, /restoreNativeCardUi\(\);\s*document\.body\.classList\.remove\('gc-planning'\)/, 'leaving the planner does not restore the native crop card');
assert.match(companionSource, /atomKey\.endsWith\('\/isCinematicModeAtom'\)/, 'the cinematic atom is not captured');
assert.match(plannerSource, /page\.__gardenCompanionSetCinematic\?\.\(true, 'gardenPlanner'\)/, 'the planner does not use the games cinematic mode');
assert.match(plannerSource, /page\.__gardenCompanionSetCinematic\?\.\(false, 'gardenPlanner'\)/, 'cinematic mode is not turned off when leaving the planner');
assert.match(gameAtomsSource, /const cinematicOwners = new Set<string>\(\);/, 'cinematic users can disable one another when their views overlap');
for (const building of ['SeedSilo: { name: "Seed Silo"', 'PetHutch: { name: "Pet Hutch"', 'DecorShed: { name: "Decor Shed"']) {
  assert.ok(built.includes(building), `storage building missing from the decor catalog: ${building}`);
}
assert.match(buildSource, /canDisplayCrop:!0/, 'mountable decor is not detected from the game data');
assert.match(buildSource, /name\.endsWith\('\.js'\)/, 'the build only searches the main chunk, so a split bundle is missed');
assert.match(plannerSource, /tile\.mountedCrop = \{/, 'pedestals cannot display a crop');
assert.match(plannerSource, /DECOR\[planner\.decorId\]\?\.mountable && planner\.mountedSpecies/, 'the mounted crop is applied to decor that cannot display one');
assert.ok(built.includes('WoodStoolShort: { name: "Short Wood Stool"'), 'the newest decor is missing from the catalog');
assert.match(plannerSource, /function scaleFor\(species: string\)/, 'planned crops have no adjustable size');
assert.match(plannerSource, /if \(planner\.scale === null\) return max;/, 'the size slider does not default to the species maximum');
assert.match(plannerSource, /targetScale: scaleFor\(/, 'slots ignore the chosen size');
assert.match(plannerSource, /function mutationIcon\(id: string\)/, 'mutations are still text buttons');
assert.match(petSpriteSource, /__gardenCompanionMutationSprites/, 'mutation icons are not decoded');
assert.match(petSpriteSource, /pick\(candidates, decorIds\.has\(itemId\) \? trimmed : frames\)/, 'decor sprites are not trimmed, so they sit oddly in their boxes');
assert.match(styleSource, /\.gc-planner-grid img \{ position:absolute;inset:4px/, 'planner icons are sized against an indefinite box, so tall sprites clip');
assert.match(plannerSource, /function refreshScaleControl\(panel: HTMLElement\)/, 'the size slider does not follow the selected crop');
assert.match(plannerSource, /slider\.max = max\.toFixed\(2\)/, 'the size slider keeps a stale maximum when the crop changes');
assert.match(plannerSource, /slider\.disabled = max <= 1/, 'crops with a single size still offer a slider');
assert.match(plannerSource, /const previousScroll = panel\.querySelector<HTMLElement>\('\.gc-planner-grid:not\(\.gc-planner-mount\)'\)\?\.scrollTop/, 'the palette loses its scroll position when rows appear');
assert.match(plannerSource, /nameInput\.addEventListener\(type, event => event\.stopPropagation\(\)\)/, 'layout names leak keypresses to the game');
assert.match(plannerSource, /const MAX_LAYOUTS = 25/, 'saved layouts are unbounded');
assert.match(plannerSource, /function toRecipe\(tile: GardenTile\)/, 'layouts are stored expanded rather than as recipes');
assert.match(plannerSource, /return 'Layout could not be saved: browser storage is full\.'/, 'a failed save is silent');
assert.doesNotMatch(plannerSource, /encodeLayout|decodeLayout|data-plan-code/, 'share codes were removed but references remain');
assert.match(companionSource, /\['journal', 'Journal'\]/, 'the Journal tab is missing');
assert.match(journalSource, /'Normal', 'Wet', 'Chilled', 'Frozen', 'Dawnlit', 'Ambershine', 'Thunderstruck',/, 'journal produce variants do not match the game');
assert.match(journalSource, /const PET_VARIANTS = \['Normal', 'Gold', 'Rainbow', 'Max Weight'\]/, 'journal pet variants do not match the game');
assert.match(journalSource, /MUTATION_CATALOG\[variant\]\?\.name \|\| variant/, 'the journal shows internal mutation ids rather than their in-game names');

assert.match(shopAlarmsSource, /if \(previous !== undefined && seconds > previous\) restocked\.add\(shop\)/, 'shop restocks are not detected from the countdown');
assert.match(shopAlarmsSource, /restocked\.has\(row\.shop\)/, 'an always-stocked item never re-alarms on restock');

assert.match(catalogSource, /return previous\.call\(this, value\) as string\[\]/, 'the Object.keys hook does not delegate to the previous implementation');
assert.match(catalogSource, /if \(objectConstructor\.keys === hook\) objectConstructor\.keys = previous;/, 'unhooking Object.keys can discard a later hook');
assert.match(catalogSource, /if \(baked\[id\] \|\| !isObject\(row\)\) continue;/, 'live capture overwrites baked catalog entries');
assert.match(catalogSource, /if \(watching && !scanning\)/, 'the catalog scan can re-enter itself');
assert.match(indexSource, /initCatalogCapture\(\);\ninitCompanion\(\);/, 'catalog capture does not run before the game starts up');
assert.match(companionSource, /export function activeTeamIds\(\): string\[\]/, 'teams holding the same pets cannot be told apart');
assert.match(companionSource, /const from = lastCycledTeamId && \(active\.includes\(lastCycledTeamId\) \|\| !active\.length\)/, 'team cycling stalls on duplicate teams or before a swap is applied');
assert.match(catalogSource, /const objectConstructor = \(page\.Object as ObjectConstructor\) \|\| Object;/, 'the catalog hook watches the sandbox Object rather than the game\'s');
// Exactly one place may hook Object.keys, so the capture cannot be duplicated per feature.
for (const [file, source] of [['features/garden-overview.ts', overviewSource], ['companion.ts', panelSource]] as const) {
  assert.doesNotMatch(source, /\.keys = /, `${file} installs a second Object.keys hook`);
}
// Each `__X_CATALOG__` reference is inlined as its own object, so a file reading one directly would
// not see species added at runtime. constants.ts owns the single shared instance; the pet sprite
// loader is exempt because it is a separate bundle injected into the page.
for (const [file, source] of [
  ['companion.ts', panelSource],
  ['features/calculators.ts', calculatorsSource],
  ['features/garden-overview.ts', overviewSource],
  ['features/garden-planner.ts', plannerSource],
  ['features/journal.ts', journalSource],
] as const) {
  assert.doesNotMatch(source, /__(?:PLANT|PET|EGG|MUTATION|DECOR)_CATALOG__/, `${file} inlines its own catalog copy instead of sharing constants.ts`);
}
assert.match(companionSource, /if \(panelRefreshBlocked\(panel\)\) \{ refreshPending = true; return; \}/, 'a blocked live refresh is dropped instead of retried');
assert.match(companionSource, /panel\.addEventListener\('focusout'.*refreshPending/, 'a pending refresh is not retried when focus leaves the panel');
assert.match(companionSource, /main\.addEventListener\('pointerleave'.*refreshPending/, 'a pending refresh is not retried when the pointer leaves the blocked tab content');

assert.match(searchSource, /input\.closest\('section, #gc-team-picker, main'\)/, 'a search box wrapped in a row cannot find its list');

// The fishing minigame is ours alone: it must never reach the game, and its clicks must never fall
// through to the canvas underneath, where they would move a plant or harvest a crop.
assert.doesNotMatch(fishingSource, /sendMessage|sendQuinoaCommand|from '\.\.\/game-connection/, 'the fishing minigame sends messages to the game');
assert.match(fishingSource, /card\.addEventListener\(type, event => event\.stopPropagation\(\)\)/, 'fishing clicks are not stopped from reaching the game');
assert.match(fishingSource, /'pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu'/, 'the fishing card lets some pointer events through to the game');
assert.match(fishingSource, /pondInput\.addEventListener\(type, event => event\.stopPropagation\(\)\)/, 'world pond clicks are not stopped from reaching the garden');
assert.match(fishingSource, /if \(type !== 'wheel'\) pondInput\.addEventListener/, 'the fishing pond blocks camera zoom from the mouse wheel');
assert.match(fishingSource, /gameCanvas\.dispatchEvent\(new WheelEvent\('wheel'/, 'pond wheel input is not forwarded to the game canvas');
assert.match(worldSceneSource, /AvatarContainer \(\$\{id\}\)/, 'a scene rod cannot be attached to the live player avatar');
assert.match(fishingSource, /owner: 'fishing'/, 'fishing does not claim the world scene under its own name');
assert.match(fishingSource, /scene\.enter\(\);/, 'opening fishing does not claim the farm');
assert.match(fishingSource, /scene\.exit\(\);/, 'closing fishing does not hand the farm back');
assert.match(companionSource, /worldSceneActive\(\)/, 'instant harvest remains active while a minigame holds the farm');
assert.match(worldSceneSource, /node\.visible = false;\s*node\.renderable = false;/, 'native crop refreshes can render through a world scene');
assert.match(worldSceneSource, /node\.label === 'WorldOverlay'/, 'standing-on-plant world effects remain visible over a world scene');
assert.match(worldSceneSource, /restoreNodes\(hiddenTiles\);\s*restoreNodes\(hiddenEffects\);/, 'a world scene does not restore both the garden and the standing effects');
assert.match(worldSceneSource, /if \(suppressTileDraw\) return;\s*return originalDraw\.apply\(this, args\);/, 'tile views regenerate crop selection and standing effects while a scene is up');
assert.match(worldSceneSource, /if \(!active \|\| !currentGeometry \|\| !penArea\) return;/, 'active pets leave their pen when a scene subview is opened');
assert.doesNotMatch(fishingSource, /gf-bank-pet|gf-boardwalk-pets/, 'fishing draws duplicate pet sprites instead of constraining the native pets');
assert.match(plantDragSource, /system\?\.name === 'pet' && system\.views instanceof pageWindow\.Map/, 'the native active-pet system is not captured');
assert.match(worldSceneSource, /const result = originalDraw\.apply\(this, args\);\s*penActivePets\(this\);/, 'active pets are constrained before the game updates their positions');
// Plant drag listens on document in the capture phase, so stopPropagation inside our panel cannot
// reach it. It has to recognise a companion canvas as ours and leave it alone.
assert.match(fishingSource, /host\.dataset\.gcUi = 'fishing'/, 'the fishing panel is not marked as companion UI');
assert.match(plantDragSource, /target\?\.tagName === 'CANVAS' && !target\.closest\?\.\('\[data-gc-ui\]'\)/, 'plant drag treats a companion canvas as the game canvas');
// Fishing sound is synthesized: a userscript cannot host audio files, and a second AudioContext
// would be one more than the page should ever hold.
assert.doesNotMatch(fishingAudioSource, /new Audio\(|fetch\(|\.mp3|\.ogg|\.wav|new AudioContext/, 'fishing audio loads external sound rather than synthesizing it');
assert.match(fishingAudioSource, /const context = armAlarmAudio\(\);/, 'fishing audio does not share the alarm audio context');
// A weather fish is the reward for fishing during that weather, so it must not bite outside it.
assert.match(fishingSource, /FISH\.filter\(fish => \(!fish\.weather \|\| fish\.weather === weather\)/, 'weather fish bite outside their own weather');
assert.match(fishingSource, /common: \{[^}]*weight: 48[\s\S]*uncommon: \{[^}]*weight: 28[\s\S]*rare: \{[^}]*weight: 15[\s\S]*epic: \{[^}]*weight: 6[\s\S]*legendary: \{[^}]*weight: 2\.5[\s\S]*mythic: \{[^}]*weight: \.5/, 'fishing rarity rates have drifted from the balanced distribution');
assert.match(fishingSource, /const WEATHER_FISH_WEIGHT = 2;/, 'matching-weather fish no longer receive their within-tier boost');
assert.match(fishingSource, /const WEATHER_MYTHIC_CHANCE = \.015;/, 'event mythics no longer use the agreed one-point-five percent rate');
assert.match(fishingSource, /eventMythics\.length && Math\.random\(\) < WEATHER_MYTHIC_CHANCE/, 'event mythics are not rolled separately from the ordinary rarity pool');
assert.match(fishingSource, /const rarity = weightedPick\(rarities, value => RARITIES\[value\]\.weight\);/, 'fish are selected before rarity, so adding species changes tier rates');
assert.match(fishingSource, /!eventMythics\.includes\(fish\)/, 'event mythics can also appear through the ordinary mythic roll');
// The bench exists to measure a fight, not to fill in a collection that is meant to be earned.
assert.match(fishingSource, /if \(!testing\) \{\s*\n\s*record\.fish\[hooked\.id\] =/, 'a bench fight is written into the catch record');
assert.match(fishingSource, /if \(phase === 'reel' && testing\) \{[^}]*playEscape\(\);/s, 'a lost bench fight counts against the record');
// One input surface: a Cast button beside the world pond reads as a separate reel control.
assert.doesNotMatch(fishingSource, /data-cast/, 'the fishing game view has a cast button separate from the canvas');
// A fixed zone speed against a per-tier fish speed makes the top tiers unwinnable rather than hard.
assert.match(fishingSource, /const agility = zoneAgility\(rule\.speed\);/, 'hook zone control no longer scales with the tier it is chasing');
// Friction is the difference between a zone you can park and one that can only overshoot.
assert.match(fishingSource, /zoneVelocity \*= Math\.pow\(ZONE_FRICTION, delta \* 60\);/, 'the hook zone has no friction, so holding accelerates without bound');
assert.match(fishingSource, /fishVelocity \*= Math\.pow\(\.93, delta \* 60\);/, 'fish damping is per frame, so the fight differs by refresh rate');
// Ending a cast must not end the animation loop, or the panel freezes after the first fish.
assert.match(fishingSource, /if \(progress >= 1\) land\(\);\s*\n\s*else if \(progress <= LOSE_FLOOR\) lose\(/, 'ending a cast returns before the next frame is queued');
assert.match(fishingSource, /\(inside \? rule\.fill \* equipmentFill\(\) : -rule\.drain\) \* FIGHT_PACE \* delta/, 'equipped progress bonuses are not applied only while the fish is controlled');
assert.match(fishingSource, /record\.coins \+= reward\.coins;[\s\S]*record\.xp \+= reward\.xp;/, 'landed fish do not award local fishing coins and XP');
assert.match(fishingSource, /candidate\.foundFrom === fish\.id && !record\.equipment\[candidate\.id\]/, 'equipment drops are not tied to specific fish');
assert.match(worldSceneSource, /userSlotIdxAndBoardwalkTileIdxToGlobalTileIdx/, 'a scene does not hide objects placed on the local boardwalk');
assert.match(fishingSource, /catch \(error\) \{\s*scene\.fail\(error, 'Fishing pool could not be drawn\.'\);\s*\}\s*frame = requestAnimationFrame\(step\);/, 'a world renderer failure stops fishing queueing its next frame');
assert.match(worldSceneSource, /fail\(error: unknown, message: string\): void \{\s*broken = true;[\s\S]*teardown\(\);/, 'a failed scene does not tear itself down');
assert.match(worldSceneSource, /sync\(\): WorldGeometry \| null \{\s*if \(!active \|\| broken\) return null;/, 'a failed scene is still rebuilt every frame');
assert.match(dragSource, /button, input, select, textarea, a, \[data-no-drag\]/, 'draggable panels no longer honour data-no-drag');
const fishingOpenSource = fishingSource.slice(fishingSource.indexOf('function open('), fishingSource.indexOf('function close()'));
assert.match(fishingOpenSource, /host\.hidden = false;\s*scene\.enter\(\);\s*primeFishingAudio\(\);\s*renderChrome\(\);\s*if \(!draggableReady\) \{[\s\S]*makeDraggable\(card, POSITION_KEY\)/, 'the saved fishing position is restored while the panel is still hidden');
assert.match(fishingSource, /function open\(targetView: 'game' \| 'bench' = 'game'\): void \{[\s\S]*view = targetView;/, 'opening fishing does not default to the fishing game');
assert.match(fishingSource, /__gardenCompanionFishingBench = \(\) => \{\s*open\('bench'\);/, 'the tuning bench no longer opens directly');
assert.doesNotMatch(fishingSource, /gf-rod-shop|stallX|Rod Shop/, 'the removed world rod shop is still rendered');
assert.match(worldSceneSource, /renderLayer\.zIndex = WORLD_OVERLAY_Z_INDEX \+ 1;[\s\S]*renderLayer\.attach\?\.\(graphic\);/, 'an abovePlayer layer is not lifted over the world overlay and player');
assert.match(fishingSource, /abovePlayer: \['rod'\]/, 'the fishing rod is not drawn above the player');
assert.match(fishingSource, /castElapsed < CAST_WINDUP[\s\S]*castElapsed - CAST_WINDUP\) \/ CAST_FLIGHT[\s\S]*lineEndX = rodTipX \+ \(targetX - rodTipX\) \* progress;/, 'the world rod and line do not animate through the cast');
assert.doesNotMatch(fishingSource.slice(fishingSource.indexOf('function mount()')), /makeDraggable\(card, POSITION_KEY\)/, 'fishing drag is initialised before the hidden panel has a measurable size');
const fishingViewHandler = fishingSource.slice(fishingSource.indexOf("card.querySelectorAll<HTMLButtonElement>('[data-view]')"), fishingSource.indexOf("card.querySelectorAll<HTMLButtonElement>('[data-fight]')"));
assert.doesNotMatch(fishingViewHandler, /pauseLoop\(|stopLoop\(/, 'opening Catch Record or Equipment pauses the pond and active cast');
assert.match(worldSceneSource, /enter\(\): void \{\s*active = true;\s*broken = false;\s*warned = false;/, 'reopening a scene does not recover from a previous renderer failure');
assert.match(fishingSource, /function pauseLoop\(\)[\s\S]*pausedAt = performance\.now\(\);[\s\S]*stopLoop\(\);/, 'fishing does not record when its animation loop was paused');
assert.match(fishingSource, /function shiftActiveTimers\(duration: number\)[\s\S]*waitUntil \+= duration;[\s\S]*biteAt \+= duration;[\s\S]*reelStartedAt \+= duration;[\s\S]*reelEndsAt \+= duration;[\s\S]*retargetAt \+= duration;/, 'not every active fishing timer is shifted by a pause');
assert.match(fishingSource, /const pausedFor = performance\.now\(\) - pausedAt;\s*shiftActiveTimers\(pausedFor\);/, 'resuming fishing does not shift its active timers');
assert.match(fishingSource, /const gap = Math\.max\(0, now - lastTime\);[\s\S]*if \(gap > 1000\) shiftActiveTimers\(gap\);/, 'a throttled animation frame can expire an active fishing timer');
assert.match(fishingSource, /function startLoop\(\): void \{\s*lastTime = performance\.now\(\);\s*if \(frame === null\) frame = requestAnimationFrame\(step\);/, 'a new fishing action can inherit and apply a stale frame gap');
assert.match(fishingSource, /function cast\(\)[\s\S]*playCast\(\);\s*resumeLoop\(\);/, 'casting bypasses fishing pause recovery');
assert.match(fishingSource, /function close\(\)[\s\S]*host\.hidden = true;\s*pauseLoop\(\);/, 'closing fishing does not pause its active timers');
assert.match(worldSceneSource, /image\.complete && image\.naturalWidth > 0/, 'a half-loaded scene image can be drawn');
assert.doesNotMatch(fishingSource, /function canvas\(|function draw\(\): void|drawWeatherSky\(|avatarLayers\(|<canvas/, 'the removed canvas fishing renderer is still bundled');
assert.match(worldSceneSource, /if \(cachedOverlay\?\.destroyed\) cachedOverlay = null;[\s\S]*cachedOverlay \|\| findNode/, 'the stable world overlay is searched across the full PIXI scene every frame');
assert.match(worldSceneSource, /if \(cachedAvatarId !== id \|\| cachedAvatar\?\.destroyed\)/, 'the stable local avatar is searched across the full PIXI scene every frame');
assert.match(fishingSource, /Number\.isFinite\(xp\) \? Math\.max\(0, xp\) : 0/, 'non-finite saved fishing XP can hang the level calculation');
assert.match(fishingSource, /equipment\[id\] > 0 && EQUIPMENT_BY_ID\.get\(id\)\?\.slot === slot/, 'loaded equipment is not validated against ownership and slot');
assert.match(fishingSource, /\.gf-card\[data-view=game\]\{width:min\(360px,calc\(100vw - 24px\)\)\}/, 'the world fishing HUD is not compact on a small viewport');
assert.match(fishingSource, /\.gf-body\{[^}]*max-height:min\(430px,calc\(100vh - 150px\)\)/, 'a fishing list can put its header above a short viewport');
assert.match(fishingSource, /castDistance = [^;]*Math\.random\(\)[^;]*;[\s\S]*hookDepth = [^;]*Math\.random\(\)[^;]*;/, 'fishing casts no longer vary their landing distance and hook depth');
// Tile draw wrappers outlive the scene unless restored, blanking the garden after the scene fails.
assert.match(worldSceneSource, /function restoreTileDraws\(\)[\s\S]*if \(!tileView\.destroyed\) tileView\.draw = originalDraw;[\s\S]*wrappedTileViews\.clear\(\)/, 'suppressed tile draws are never restored');
assert.match(worldSceneSource, /function teardown\(\): void \{\s*suppressTileDraw = false;\s*restoreTileDraws\(\);/, 'tearing a scene down leaves its tile draws suppressed');
assert.doesNotMatch(worldSceneSource, /panel\(\)\?\.hidden === false\) return;/, 'a wrapped tile draw does a DOM lookup on every frame');

// A world scene borrows the player's real farm tiles, so its whole contract is that the garden
// comes back. Every scene shares this module, so a regression here breaks all of them at once.
assert.doesNotMatch(worldSceneSource, /sendMessage|sendQuinoaCommand|from '\.\/game-connection/, 'a world scene sends messages to the game');
assert.match(worldSceneSource, /exit\(\): void \{\s*active = false;\s*activeScenes\.delete\(config\.owner\);\s*teardown\(\);\s*releaseCinematic\(\);/, 'leaving a scene does not release the farm, the cinematic claim and its owner slot together');
assert.match(worldSceneSource, /function teardown\(\)[\s\S]*restoreNodes\(hiddenTiles\);[\s\S]*restoreNodes\(hiddenEffects\);[\s\S]*clearSprites\(\);/, 'a scene teardown leaves sprites or hidden nodes behind');
assert.match(worldSceneSource, /const activeScenes = new Set<string>\(\);/, 'scenes cannot tell each other apart, so one closing frees another still holding the farm');
// Two scenes open at once would fight over the same tiles, so each claims cinematic mode by name.
assert.match(worldSceneSource, /__gardenCompanionSetCinematic\?\.\(true, config\.owner\)/, 'a scene does not claim cinematic mode under its own name');
assert.match(worldSceneSource, /__gardenCompanionSetCinematic\?\.\(false, config\.owner\)/, 'a scene does not release cinematic mode under its own name');
assert.match(worldSceneSource, /if \(signature !== next \|\| !graphics\.size\)/, 'a scene is rebuilt even when the farm has not changed shape');

// Garden Defence is a second consumer of the shared scene, and is bound by the same promise as
// fishing: it draws over the farm and never touches it.
assert.doesNotMatch(gardenDefenceSource, /sendMessage|sendQuinoaCommand|from '\.\.\/game-connection/, 'the garden defence minigame sends messages to the game');
assert.match(gardenDefenceSource, /owner: 'gardenDefence'/, 'garden defence does not claim the world scene under its own name');
assert.match(gardenDefenceSource, /card\.addEventListener\(type, event => event\.stopPropagation\(\)\)/, 'garden defence clicks are not stopped from reaching the game');
assert.match(gardenDefenceSource, /if \(type !== 'wheel'\) lawnInput\.addEventListener/, 'the lawn blocks camera zoom from the mouse wheel');
assert.match(gardenDefenceSource, /gameCanvas\.dispatchEvent\(new WheelEvent\('wheel'/, 'lawn wheel input is not forwarded to the game canvas');
assert.match(gardenDefenceSource, /host\.dataset\.gcUi = 'gardenDefence'/, 'the garden defence panel is not marked as companion UI');
// Every tower is a real plant, or its sprite silently never resolves and the tile renders empty.
for (const tower of ['Sunflower', 'Saffron', 'Pumpkin', 'Cactus', 'Starweaver', 'Cardoon', 'Milkcap']) {
  assert.match(gardenDefenceSource, new RegExp(`id: '${tower}'`), `garden defence is missing its ${tower} tower`);
  assert.ok(built.includes(`${tower}: { crop: {`), `garden defence tower ${tower} is not a real plant in the game catalog`);
}
// Pests are the game's own Worm sprite, so they carry the same lifetime rules as the towers.
assert.match(gardenDefenceSource, /const PEST_SPECIES = 'Worm';/, 'pests no longer use the games own worm sprite');
assert.ok(built.includes('Worm: { name: "Worm"'), 'the worm pest species is not a real pet in the game catalog');
assert.match(gardenDefenceSource, /readyImage\(page\.__gardenCompanionPetSprites\?\.\[PEST_SPECIES\]\)/, 'the pest sprite is not taken from the injected pet sprites');
assert.match(gardenDefenceSource, /function removePest[\s\S]*scene\.removeSprite\(pest\.sprite\);\s*pest\.sprite = null;/, 'a dead pest leaks its world sprite');
assert.match(gardenDefenceSource, /for \(const pest of pests\) if \(pest\.hp <= 0\) removePest\(pest\);/, 'killed pests are filtered out without releasing their sprites');
assert.match(gardenDefenceSource, /for \(const pest of pests\) removePest\(pest\);\s*pests = \[\];/, 'clearing pests in tuning mode leaks their sprites');
assert.match(gardenDefenceSource, /for \(const pest of pests\) pest\.sprite = null;/, 'pest sprites are not reclaimed when the scene is rebuilt');
// The sprite faces right and every pest walks left, so an unmirrored worm moonwalks into the house.
assert.match(gardenDefenceSource, /pest\.sprite\.scale\.x = Math\.abs\(Number\(pest\.sprite\.scale\.x\) \|\| 1\)/, 'pests are not mirrored to face the way they walk');
assert.match(gardenDefenceSource, /sprite\.tint = now < pest\.slowUntil \? 0x8ec5e8/, 'a snared pest is not tinted, so the slow is invisible');

// Some towers only look like themselves as the growing plant, so both sprite maps are needed.
assert.match(gardenDefenceSource, /id: 'Starweaver'[^\n]*art: 'plant'/, 'the Starweaver tower is drawn as its crop rather than the plant');
assert.match(gardenDefenceSource, /if \(def\.art === 'plant' && plant\) return plant;/, 'a tower asking for plant art still falls back to its crop first');
assert.match(petSpriteSource, /__gardenCompanionPlantSprites/, 'growing-plant sprites are not exposed');
assert.match(petSpriteSource, /const plantSprite = __PLANT_CATALOG__\[species\]\?\.plantSprite;/, 'plant sprites are not resolved from the captured plant frame');
assert.match(buildSource, /plantSprite: plantBlock\.match\(\/sprite:\[A-Za-z_\$\]\+\\.Plant\\.\(\[A-Za-z0-9_\]\+\)\/\)/, 'the plant sprite frame is not captured from the game bundle');
assert.ok(built.includes('plantSprite: "StarweaverPlant"'), 'the Starweaver plant frame is missing from the built catalog');

// The fruit is what makes a Starweaver recognisable, so it is drawn as a second sprite over the
// plant and has to be released on exactly the same paths as the plant itself.
assert.match(gardenDefenceSource, /fruit\?: \{ scale: number \}/, 'a tower cannot opt into showing its fruit');
// The mount point is the game's own slot offset, not a number invented here.
assert.match(gardenDefenceSource, /const offset = PLANT_CATALOG\[plant\.def\.id\]\?\.slotOffset;/, 'the fruit is hung on a guessed offset rather than the plants real mount point');
assert.match(gardenDefenceSource, /y: base - height \/ 2 \+ \(offset\?\.y \?\? 0\) \* height/, 'the fruit offset is not measured from the plant centre against its drawn height');
assert.ok(buildSource.includes('slotOffsets:'), 'the plant slot offset is not captured from the game bundle');
assert.ok(built.includes('slotOffset: { x: 4e-3, y: -0.308 }'), 'the Starweaver mount point is missing from the built catalog');
assert.match(gardenDefenceSource, /id: 'Starweaver'[^\n]*fruit: \{/, 'the Starweaver tower does not show its fruit');
assert.match(gardenDefenceSource, /scene\.removeSprite\(plant\.sprite\);\s*scene\.removeSprite\(plant\.fruitSprite\);/, 'a dug-up plant leaks its fruit sprite');
assert.match(gardenDefenceSource, /for \(const plant of plants\) plant\.sprite = plant\.fruitSprite = null;/, 'fruit sprites are not reclaimed when the scene is rebuilt');
assert.match(gardenDefenceSource, /zIndex: zIndex \+ 1/, 'the fruit does not draw above its own plant');
assert.match(gardenDefenceSource, /const zIndex = -998_950 \+ plant\.lane \* 4;/, 'lanes leave no z room for a fruit above its plant');
// Tinting is the only per-pest colour available, so the rare tiers ride on it.
assert.match(gardenDefenceSource, /id: 'bloatworm'[^\n]*rainbow: true/, 'the bloat worm is not rainbow');
assert.match(gardenDefenceSource, /id: 'huskworm'[^\n]*colour: 0xffcf4d/, 'the husk worm is not gold');
assert.match(gardenDefenceSource, /pest\.def\.rainbow \? hueTint\(/, 'a rainbow pest is drawn with a flat tint');
assert.match(gardenDefenceSource, /now < pest\.slowUntil \? 0x8ec5e8\s*:/, 'the rainbow cycle hides that a pest is snared');

// Losing a run or a render failure must not end the animation loop, or reopening shows a dead board.
assert.match(gardenDefenceSource, /catch \(error\) \{\s*scene\.fail\(error, 'Garden defence could not be drawn\.'\);\s*\}\s*frame = requestAnimationFrame\(step\);/, 'a world renderer failure stops garden defence queueing its next frame');
assert.match(gardenDefenceSource, /if \(pests\.some\(pest => pest\.x <= -\.3\)\) endRun\(\);/, 'a pest crossing the house does not end the run');
assert.match(gardenDefenceSource, /if \(!dev && wave > record\.best\) \{\s*record\.best = wave;/, 'a finished run does not record the best wave');
// Digging a plant has to release its sprite, or the board leaks one sprite per plant lost.
assert.match(gardenDefenceSource, /function removePlant[\s\S]*scene\.removeSprite\(plant\.sprite\);[\s\S]*plant\.sprite = null;/, 'digging or losing a plant leaks its world sprite');
// The HUD is rebuilt wholesale, so doing it every frame would swallow the click that opened it.
assert.match(gardenDefenceSource, /if \(now - chromeAt > 250\) \{ chromeAt = now; renderStatus\(\); \}/, 'the garden defence HUD is rebuilt every frame');
// Tuning mode hands out free towers, so nothing it does may reach the saved record.
assert.match(gardenDefenceSource, /if \(!dev && wave > record\.best\) \{/, 'a tuning run can set the best wave');
assert.match(gardenDefenceSource, /if \(!dev\) \{\s*record\.runs\+\+;/, 'a tuning run is counted as a real run');
assert.match(gardenDefenceSource, /if \(!dev\) \{\s*record\.sun \+= suns\[index\]\.value;/, 'sun collected in tuning mode is added to the record');
assert.match(gardenDefenceSource, /if \(!dev && sun < def\.cost\)[\s\S]*if \(!dev\) sun -= def\.cost;/, 'tuning mode still charges for towers');
assert.match(gardenDefenceSource, /reset\(\);\s*if \(panel\(\)\?\.hidden !== false\) open\(\);/, 'toggling tuning mode lets open() reset again and double-count the run');
// The panel has no tuning button on purpose, so a normal player never sees these controls.
assert.doesNotMatch(gardenDefenceSource, /data-open-dev|data-dev-toggle/, 'tuning mode is exposed in the normal panel');
assert.match(gardenDefenceSource, /page\.__gardenCompanionGardenDefenceDev = \(enabled = !dev\)/, 'tuning mode cannot be reached from the console');
// A health bar denominator read from the live wave drifts as the ramp moves past a spawned pest.
assert.match(gardenDefenceSource, /const hp = waveHp\(def\);\s*pests\.push\(\{ def, lane, x: columns \+ \.35, hp, maxHp: hp/, 'a pest does not remember the health it spawned with');
assert.match(gardenDefenceSource, /pest\.hp < pest\.maxHp[\s\S]*pest\.hp \/ pest\.maxHp/, 'the pest health bar is measured against the current wave rather than its own spawn');
assert.match(indexSource, /initGardenDefence\(\);/, 'garden defence is never started');

// A reconnect hands the world back in pieces. Diffing against the pre-drop world across that gap
// reads an empty shop list as every watched item vanishing, then reappearing, which alarms for all
// of them at once. The settled snapshot has to be adopted silently instead.
assert.match(plantDragSource, /noteRoomSocketOpened\(\);/, 'a reopened room socket is not published to the rest of the script');
assert.match(plantDragSource, /socket\.addEventListener\('close', noteRoomSocketClosed\)/, 'a dropped room socket is not published to the rest of the script');
assert.match(connectionStateSource, /roomSocketOpens\+\+;\s*if \(roomSocketOpens > 1\) emit\(\);/, 'the first connection of a session is announced as a reconnect');
assert.match(shopAlarmsSource, /onRoomConnectionInterrupted\(beginResettle\)/, 'shop alarms do not re-baseline after a reconnect');
assert.match(shopAlarmsSource, /function beginResettle\(\)[\s\S]*resettling = true;[\s\S]*restockClocks\.clear\(\);/, 'a reconnect leaves the restock clocks holding pre-drop values');
assert.match(shopAlarmsSource, /if \(resettling\) \{\s*settleAfterReconnect\(shopSignature\(availableShopItems\(\)\)\);\s*return;\s*\}/, 'shop snapshots are still diffed while the connection is resettling');
// Re-baselining must not run the initial-load path, which deliberately alarms for everything held.
assert.doesNotMatch(shopAlarmsSource, /beginResettle[\s\S]{0,400}state\.initializedShops = false/, 'a reconnect re-runs the initial load and alarms for every item already in stock');
assert.match(shopAlarmsSource, /resettling = false;[\s\S]*state\.lastShopSignature = settled;[\s\S]*restockedShops\(\);\s*state\.initializedShops = true;/, 'the settled reconnect snapshot is not adopted as the new silent baseline');
assert.match(shopAlarmsSource, /if \(settled !== resettleSignature\) \{\s*settleAfterReconnect\(settled\);/, 'the reconnect settle does not wait for the shops to stop changing');
assert.ok(RECONNECT_SETTLE_MS_VALUE > INITIAL_SETTLE_MS_VALUE, 'a reconnect settles no slower than a first load, so partial state can still slip through');

// Catching the engine's private farm systems means patching Object.defineProperty, Map.prototype.set
// and three accessors on Object.prototype. All three are on the hot path of every script on the
// page - a bundler defines a property per export, the game fills Maps constantly, and an accessor
// on Object.prototype sits on the prototype chain of every object there is. Leaving them installed
// for the whole session taxes the game's own code forever, so they must come back off.
assert.match(plantDragSource, /function restoreDefinePropertyCapture\(\)[\s\S]*objectCtor\.defineProperty = originalDefineProperty;/, 'the patched Object.defineProperty is never restored');
assert.match(plantDragSource, /function restoreSystemRegistryCapture\(\)[\s\S]*mapProto\.set = originalMapSet;/, 'the patched Map.prototype.set is never restored');
assert.match(plantDragSource, /function releaseGlobalHooksIfIdle\(\)\s*\{\s*if \(armedSystemFields\.size === 0\) restoreDefinePropertyCapture\(\);/, 'the global hooks are not released once every system is captured');
assert.match(plantDragSource, /\} else return;\s*releaseGlobalHooksIfIdle\(\);/, 'capturing a system does not check whether the global hooks can come off');
// A system that never arrives must not leave the page permanently patched.
assert.match(plantDragSource, /const HOOK_RELEASE_TIMEOUT_MS = 60_000;/, 'there is no backstop for hooks waiting on a system that never arrives');
assert.match(plantDragSource, /function scheduleHookRelease\(\)[\s\S]*for \(const key of \[\.\.\.armedSystemFields\]\) disarmPrivateField\(key\);[\s\S]*restoreDefinePropertyCapture\(\);\s*restoreSystemRegistryCapture\(\);/, 'the backstop does not remove every global hook');
// A reconnect rebuilds the systems, so the hooks have to go back on with it.
assert.match(plantDragSource, /function armPrivateSystemCapture\(\)\s*\{\s*installDefinePropertyCapture\(\);\s*installSystemRegistryCapture\(\);\s*scheduleHookRelease\(\);/, 'a reconnect does not re-install the capture hooks it needs');
assert.match(plantDragSource, /installDefinePropertyCapture\(\) \{\s*if \(\(objectCtor\.defineProperty as any\)\?\.\[WRAPPED_FLAG\]\) return;/, 'the defineProperty hook can be installed on top of itself');

// A switch for measuring what the sprite pipeline costs on a cold load. It has to live in storage:
// the loader runs during startup, so a session-only flag could never be set before it had run.
assert.match(petSpriteInjector, /const DISABLE_KEY = 'gardenCompanion\.disableSprites';/, 'sprite loading cannot be turned off for a load-time comparison');
assert.match(petSpriteInjector, /if \(injected \|\| spritesDisabled\(\)\) return;/, 'a pointer press still injects sprites when they are disabled');
assert.match(petSpriteInjector, /page\.__gardenCompanionDisableSprites = \(disabled = true\)/, 'the sprite switch is not reachable from the console');
assert.match(buildSource, /const withoutSprites = process\.argv\.includes\('--no-sprites'\);/, 'there is no build that ships without the sprite pipeline');

// Decoding a few hundred sprites means a few hundred synchronous PNG encodes. In one loop that is
// over a second of blocked main thread, landing on the game's startup; sliced, the work is the same
// but no single burst of it can hold a frame.
assert.match(petSpriteSource, /const SLICE_BUDGET_MS = 8;/, 'sprite decoding has no main-thread budget');
assert.match(petSpriteSource, /async function cropFrames\(/, 'sprite decoding cannot yield, so it runs as one long task');
assert.match(petSpriteSource, /if \(performance\.now\(\) - sliceStarted >= SLICE_BUDGET_MS\) \{\s*await yieldToBrowser\(\);/, 'sprite decoding never hands the thread back');
assert.match(petSpriteSource, /scheduler\.postTask\(\(\) => resolve\(\), \{ priority: 'background' \}\)/, 'sprite decoding does not yield at background priority where that is available');
assert.match(petSpriteSource, /await cropFrames\(atlas, sheet, wanted, output\);\s*await cropFrames\(atlas, sheet, trimmedWanted, trimmedOutput, true\);/, 'the atlas loop does not await the sliced decode');

// Decoding produces identical bytes for a given game release, so it is paid once per release rather
// than once per load. Anything else means every reload rebuilds a few hundred PNGs from scratch.
assert.match(petSpriteSource, /const CACHE_DB = 'gardenCompanionSprites';/, 'decoded sprites are not cached between loads');
assert.match(petSpriteSource, /const cached = await readCache\(key\);\s*if \(cached\) \{ publish\(cached\); return; \}/, 'a cache hit still decodes every sprite');
assert.match(petSpriteSource, /const key = `\$\{fingerprintKey\}:\$\{stage\}:/, 'the sprite cache is not keyed by the atlas fingerprint');
assert.match(petSpriteSource, /if \(!existing\.startsWith\(`\$\{fingerprint\}:`\) \|\| existing\.startsWith\(stalePrefix\)\) store\.delete\(existing\);/, 'superseded sprite bundles are never evicted from the cache');
assert.doesNotMatch(petSpriteSource, /localStorage\.setItem\('gardenCompanionSprites/, 'sprite data URLs are pushed into localStorage, which cannot hold them');
// Only the player's own pets and crops are on screen during load; everything else waits to be asked.
assert.match(petSpriteSource, /async function decodeEssential\(\)[\s\S]*produce: mapFrom\(produceCandidates, trimmed\)/, 'the startup sprite stage is not limited to pets and produce');
assert.match(petSpriteSource, /async function decodeDeferred\(\)[\s\S]*plant: mapFrom\(plantCandidates, trimmed\)/, 'decor and growing-plant art is not deferred');
assert.match(petSpriteSource, /await runStage\('essential'\);/, 'the essential sprite stage never runs');
assert.match(petSpriteSource, /page\.__gardenCompanionLoadSpriteGroup = /, 'the deferred sprite stage cannot be requested');
assert.match(plannerSource, /page\.__gardenCompanionLoadSpriteGroup\?\.\('deferred'\)/, 'the layout planner does not request the decor art it draws');
assert.match(celestialGuideSource, /page\.__gardenCompanionLoadSpriteGroup\?\.\('deferred'\)/, 'the celestial guide does not request the plant art it draws');
// A stage in flight must not be started twice by two features opening at once.
assert.match(petSpriteSource, /const existing = running\.get\(stage\);\s*if \(existing\) return existing;/, 'a sprite stage can be decoded twice at once');

// Both ids for the winter egg are live in the game's catalog and only one of them has atlas art,
// so a lookup by the other id has to resolve to the same frame rather than nothing.
assert.match(petSpriteSource, /egg: \[[^\]]*'SnowEgg', 'WinterEgg'/, 'the winter egg is missing from the egg sprite list under one of its ids');
assert.match(petSpriteSource, /itemId === 'SnowEgg' \|\| itemId === 'WinterEgg'/, 'only one of the winter egg ids resolves to its sprite');
for (const eggId of ['SnowEgg', 'WinterEgg']) {
  assert.ok(built.includes(`${eggId}: { name:`), `${eggId} is not a real egg in the game catalog`);
}
// This is how the winter egg lost its art: a live egg with no entry in the sprite list gets no
// sprite, silently. Every egg the game ships has to be named here or the icon is simply absent.
const eggSpriteList = petSpriteSource.match(/egg: \[([^\]]*)\]/)?.[1] ?? '';
const catalogEggIds = [...built.matchAll(/([A-Za-z][A-Za-z0-9_]*): \{ name: "[^"]*", spawnWeights/g)].map(match => match[1]);
assert.ok(catalogEggIds.length >= 9, 'the egg catalog could not be read out of the build');
for (const eggId of catalogEggIds) {
  assert.ok(eggSpriteList.includes(`'${eggId}'`), `${eggId} is in the game's egg catalog but has no sprite entry, so its icon will be missing`);
}

// The atlas fingerprint tracks the game's artwork. It cannot notice that we started asking for a
// sprite we never asked for before, which is how the winter egg fix sat behind a stale cache.
assert.match(petSpriteSource, /function requestSignature\(wanted: Set<string>, trimmedWanted: Set<string>\)/, 'the cache key ignores which sprites are being asked for');
assert.match(petSpriteSource, /const key = `\$\{fingerprintKey\}:\$\{stage\}:\$\{requestSignature\(request\.wanted, request\.trimmedWanted\)\}`;/, 'the request set is not part of the cache key');
assert.match(petSpriteSource, /existing\.startsWith\(stalePrefix\)/, 'a superseded request set is left in the cache forever');
// Both halves of the key have to come from the same place the decode does, or they drift apart.
assert.match(petSpriteSource, /const \{ wanted, trimmedWanted \} = essentialRequest\(\);/, 'the essential decode does not use the request set the cache key was built from');
assert.match(petSpriteSource, /const \{ wanted, trimmedWanted \} = deferredRequest\(\);/, 'the deferred decode does not use the request set the cache key was built from');

console.log('Static checks passed');
// Auto-store only tops up a stack the storage already holds, and the silo and shed key their
// contents by species and decor id rather than by an item id.
assert.match(autoStoreSource, /if \(!key \|\| !stored\.has\(key\)\) continue;/, 'auto-store files items the storage has never held');
assert.match(autoStoreSource, /storageId: 'SeedSilo', itemType: 'Seed', key: item => item\.species/, 'the seed silo rule no longer keys on species');
assert.match(autoStoreSource, /storageId: 'DecorShed', itemType: 'Decor', key: item => item\.decorId/, 'the decor shed rule no longer keys on decor id');
assert.match(autoStoreSource, /send\(\{ type: 'PutItemInStorage', itemId: next\.key, storageId: next\.rule\.storageId \}\)/, 'auto-store no longer sends the command the game sends');
// A whole inventory of eligible items must not leave as one burst, and the toggle can be turned
// off while the queue is still draining.
assert.match(autoStoreSource, /drainTimer = window\.setTimeout\(\(\) => \{ drainTimer = 0; drain\(\); \}, SEND_INTERVAL_MS\);/, 'auto-store sends every eligible move in one tick');
assert.match(autoStoreSource, /if \(next\.rule\.enabled\(\)\) \{/, 'a draining queue ignores the toggle being turned off');
assert.match(autoStoreSource, /if \(sentAt\.has\(pending\) \|\| queued\.has\(pending\)\) continue;/, 'auto-store resends a move before the server has echoed it');
// The grace has to start when the move leaves, not when it joins the queue: a queue longer than the
// grace would otherwise let the same key be queued twice.
assert.match(autoStoreSource, /send\(\{ type: 'PutItemInStorage', itemId: next\.key, storageId: next\.rule\.storageId \}\);\s*sentAt\.set\(next\.pending, Date\.now\(\)\);/, 'the resend grace starts before the move is sent');
// Patches arrive whatever the player is doing, so an item the server will not accept must not be
// sent again every few seconds forever.
assert.match(autoStoreSource, /if \(signature === lastQueuedSignature\) return;/, 'auto-store retries a stuck item for as long as the tab is open');
assert.match(autoStoreSource, /if \(queuedAny\) lastQueuedSignature = signature;/, 'a flush that queued nothing still blocks the next one');
assert.match(companionSource, /autoStoreSeeds: false,\s*autoStoreDecor: false,/, 'auto-store is on by default');
assert.match(companionSource, /processAutoStore\(\);/, 'auto-store never runs');
