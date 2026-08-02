import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const built = await readFile(resolve(root, 'dist', 'garden-companion.user.js'), 'utf8');
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
].map(parts => readFile(resolve(root, ...parts), 'utf8')))).join('\n');
// Assertions that depend on where a function sits relative to another must name the file they
// live in, otherwise a slice across the combined source silently matches nothing.
const petTeamsSource = await readFile(resolve(root, 'src', 'features', 'pet-teams.ts'), 'utf8');
const shopAlarmsSource = await readFile(resolve(root, 'src', 'features', 'shop-alarms.ts'), 'utf8');
const journalSource = await readFile(resolve(root, 'src', 'features', 'journal.ts'), 'utf8');
const searchSource = await readFile(resolve(root, 'src', 'list-search.ts'), 'utf8');
const catalogSource = await readFile(resolve(root, 'src', 'game-catalogs.ts'), 'utf8');
const calculatorsSource = await readFile(resolve(root, 'src', 'features', 'calculators.ts'), 'utf8');
const abilityLogSource = await readFile(resolve(root, 'src', 'features', 'ability-log.ts'), 'utf8');
const styleSource = await readFile(resolve(root, 'src', 'style.css'), 'utf8');
const overviewSource = await readFile(resolve(root, 'src', 'features', 'garden-overview.ts'), 'utf8');
const plantDragSource = await readFile(resolve(root, 'src', 'features', 'plant-drag-move.ts'), 'utf8');
const indexSource = await readFile(resolve(root, 'src', 'index.ts'), 'utf8');
const petSpriteSource = await readFile(resolve(root, 'src', 'pet-sprites.ts'), 'utf8');
const petSpriteInjector = await readFile(resolve(root, 'src', 'pet-sprites-injector.ts'), 'utf8');
const buildSource = await readFile(resolve(root, 'scripts', 'build.ts'), 'utf8');
const plannerSource = await readFile(resolve(root, 'src', 'features', 'garden-planner.ts'), 'utf8');
const fishingSource = await readFile(resolve(root, 'src', 'features', 'fishing.ts'), 'utf8');
const fishingAudioSource = await readFile(resolve(root, 'src', 'features', 'fishing-audio.ts'), 'utf8');
const petsSource = await readFile(resolve(root, 'src', 'pets.ts'), 'utf8');
const dragSource = await readFile(resolve(root, 'src', 'draggable.ts'), 'utf8');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string };
const packageLock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version: string }> };

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
assert.match(companionSource, /const LOG_PER_ABILITY = 400/, 'ability history no longer keeps a deep log');
assert.match(companionSource, /if \(saveLocalOrFail\(LOG_KEY, state\.abilityLog\)\) return;/, 'a full storage quota silently stops persisting the log');
assert.match(companionSource, /data-log-search/, 'the ability log cannot be searched');
assert.match(companionSource, /data: snapshotPayload\(entry\.parameters \|\| \{\}\)/, 'ability result payload is not snapshotted');
assert.match(companionSource, /ability\.includes\('SeedFinder'\) && data\.speciesId[\s\S]*payloadItemName\(data\.speciesId\)/, 'seed finder result is not placed on the main line');
assert.match(companionSource, /growSlot\?\.species[\s\S]*payloadItemName\(growSlot\.species\)/, 'mutation granter target is not placed on the main line');
assert.match(companionSource, /class="gc-proc-result"[\s\S]*&rarr;[\s\S]*procOutcome/, 'proc result is not displayed after the ability name');
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
assert.match(styleSource, /#gc-lunar::before[\s\S]*linear-gradient/, 'lunar timer accent line is missing');
assert.doesNotMatch(companionSource, /slice\(0, 500\)/, 'legacy global ability history limit found');
assert.match(overviewSource, /structureSignature/, 'overview structural refresh guard missing');
assert.match(overviewSource, /installPlantFocus/, 'overview plant focus missing');
assert.match(overviewSource, /focusEnabled\.onchange[\s\S]*focusEnabled\.blur\(\)/, 'plant focus enabled checkbox keeps keyboard focus');
assert.match(overviewSource, /focusInvert\.onchange[\s\S]*focusInvert\.blur\(\)/, 'plant focus invert checkbox keeps keyboard focus');
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
assert.match(petSpriteSource, /__gardenCompanionShopSprites/, 'shop atlas sprites are not exposed');
assert.match(companionSource, /gc-shop-sprite/, 'shop alarm items do not render sprites');
for (const excludedTool of ['Shovel', 'FeedingTrough', 'DecorShed', 'PetHutch', 'SeedSilo']) assert.match(companionSource, new RegExp(`EXCLUDED_TOOL_ALERTS[\\s\\S]*'${excludedTool}'`), `${excludedTool} is not excluded from tool alarms`);
assert.match(companionSource, /shop === 'tool' && EXCLUDED_TOOL_ALERTS\.has\(id\)/, 'excluded tools can still trigger live alarms');
assert.match(companionSource, /shopAlarmTab !== 'tool' \|\| !EXCLUDED_TOOL_ALERTS\.has\(id\)/, 'excluded tools remain in the alarm list');
assert.match(companionSource, /\['teams', 'abilities', 'shops', 'petFood'\]\.includes\(activeTab\)/, 'open shop alarms do not refresh when sprites load');
for (const shopSpriteGroup of ["seed", "egg", "tool"]) assert.match(petSpriteSource, new RegExp(`${shopSpriteGroup}: \\[`), `missing ${shopSpriteGroup} sprite group`);
assert.match(petSpriteInjector, /script\.textContent = __PET_SPRITE_LOADER__/, 'pet atlas loader is not injected into the game page');
assert.match(indexSource, /initPlantDragMove\(\);/, 'plant drag is not installed for runtime toggling');
assert.doesNotMatch(indexSource, /if \(page\.__gardenCompanionFeature\?\.\('dragMove'\)\) initPlantDragMove/, 'plant drag still requires a reload to install');
assert.match(plantDragSource, /function isEnabled\(\)[\s\S]*__gardenCompanionFeature\?\.\('dragMove'\)/, 'plant drag does not read its live feature setting');
assert.match(plantDragSource, /if \(!isEnabled\(\) \|\| press \|\| event\.button/, 'disabled plant drag still starts presses');
assert.match(companionSource, /Plant drag, estimates, and harvest settings apply immediately\. Background mode applies after a reload\./, 'Features note is outdated');
assert.match(companionSource, /Hold, drag and release a plant - consumes planter pots/, 'Plant drag move description is incorrect');
assert.match(overviewSource, /\.go-card\{width:min\(344px,94vw\)/, 'overview does not match the standalone compact width');
assert.match(overviewSource, /row\.totalSeconds/, 'overview detailed granter estimates missing');
assert.match(overviewSource, /rows\.filter\(\(\[, , count\]\) => count > 0\)/, 'overview still displays empty mutation rows');
assert.match(overviewSource, /stats\.mature === 0/, 'overview first-ready card behavior differs from standalone');
assert.match(companionSource, /alarm = \{ timer: setInterval\(playAlarmTone, 420\), options \}/, 'shared alarm is not persistent');
assert.match(companionSource, /\['abilities', 'Active Pets'\], \['abilityLog', 'Pet Abilities'\], \['teams', 'Pet Teams'\], \['petFood', 'Pet Food'\], \['calculators', 'Calculators'\], \['shops', 'Shop Alarms'\], \['silence', 'Ignore Alerts'\], \['journal', 'Journal'\], \['rooms', 'Rooms'\], \['keybinds', 'Keybinds'\], \['features', 'Features'\]/, 'tab order is incorrect');
assert.match(companionSource, /\[4, 5\]\.includes\(Number\(room\.players_count\)\)/, 'rooms are not restricted to 4 or 5 players');
assert.match(companionSource, /sort\(\(left, right\) => Number\(right\.players_count\) - Number\(left\.players_count\)\)/, '5-player rooms are not sorted above 4-player rooms');
assert.match(companionSource, /Public rooms with one or two open slots\./, 'room description is incorrect');
assert.match(companionSource, /data-ability-filter/, 'Pet Abilities filter missing');
assert.match(companionSource, /data-ability-option/, 'Pet Abilities multi-selection options missing');
assert.match(companionSource, /data-ability-all[\s\S]*data-ability-none/, 'Pet Abilities All and None selections missing');
assert.match(companionSource, /config\.trackedAbilities = \[\.\.\.currentKeys\]/, 'Pet Abilities selections are not saved together');
assert.match(companionSource, /abilityFilter\.addEventListener\('focusout'[\s\S]*abilityFilter\.open = false/, 'ability filter does not close after focus leaves');
assert.match(styleSource, /\.gc-ability-picker \{ position:absolute;top:39px/, 'ability filter still shifts the panel layout');
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
const panelSource = await readFile(resolve(root, 'src', 'companion.ts'), 'utf8');
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
assert.match(petSpriteSource, /trimmed\.get\(key\)/, 'produce icons still use padded atlas frames');
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
assert.match(companionSource, /const owned = new Map\((?:services\.)?allPets\(\)\.map\(pet => \[pet\.id, pet\]\)\)/, 'team member sprites rescan every pet per tile');
assert.match(companionSource, /const CALCULATOR_TABS = \[\['dust', 'Dust'\], \['food', 'Food'\], \['granter', 'Granters'\]\]/, 'calculator sub-tabs are missing');
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
assert.match(plannerSource, /\.\.\.\(isPatch \? patchSlotOffset\(slotId, slots\) : \{\}\)/, 'patch slots are placed without x and y, so only one crop draws');
assert.match(plannerSource, /const started = now - 3_600_000;\s*const matured = now - 60_000;/, 'planned plants use a zero length growth window, which breaks their size');
assert.doesNotMatch(plannerSource, /startTime: now - 60_000,\s*endTime: now - 60_000/, 'planned slots still start and end at the same instant');
assert.match(plannerSource, /!PLANTS\[name\]\?\.component/, 'component species still get their own planner button');
assert.match(plannerSource, /species: PLANTS\[species\]\?\.slotSpecies\?\.\[slotId\] \|\| species/, 'slot species overrides are ignored');
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
assert.match(petSpriteSource, /decor: DECOR_IDS/, 'decor sprites still use a hardcoded list');
assert.ok(built.includes('FanousLantern: { name: "Fanous Lantern"'), 'newer decor is missing from the catalog');
// A fixed width both keeps the flex parent from stretching the button and keeps every launch
// button on the Features tab the same size, whatever its label says.
assert.match(styleSource, /#gc-panel \.gc-launch-row button \{[^}]*width:132px[^}]*flex:0 0 auto/, 'the launch buttons size themselves to their labels');
assert.match(plannerSource, /const NATIVE_UI_LABELS = \['GardenInfoCardSystem', 'ActionHud', 'PetActionButtons'\]/, 'the native crop card and action buttons are not hidden while planning');
assert.match(plannerSource, /function restoreNativeCardUi\(\)/, 'the native crop card is never restored');
assert.match(plannerSource, /restoreNativeCardUi\(\);\s*document\.body\.classList\.remove\('gc-planning'\)/, 'leaving the planner does not restore the native crop card');
assert.match(companionSource, /atomKey\.endsWith\('\/isCinematicModeAtom'\)/, 'the cinematic atom is not captured');
assert.match(plannerSource, /page\.__gardenCompanionSetCinematic\?\.\(true\)/, 'the planner does not use the games cinematic mode');
assert.match(plannerSource, /page\.__gardenCompanionSetCinematic\?\.\(false\)/, 'cinematic mode is not turned off when leaving the planner');
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
assert.match(petSpriteSource, /const source = decorIds\.has\(itemId\) \? trimmed : frames;/, 'decor sprites are not trimmed, so they sit oddly in their boxes');
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
assert.match(fishingSource, /<canvas data-no-drag>/, 'dragging inside the fishing canvas moves the panel');
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
// One input surface: a Cast button beside a canvas you hold to reel reads as a reel control.
assert.doesNotMatch(fishingSource, /data-cast/, 'the fishing game view has a cast button separate from the canvas');
// A fixed zone speed against a per-tier fish speed makes the top tiers unwinnable rather than hard.
assert.match(fishingSource, /const agility = zoneAgility\(rule\.speed\);/, 'hook zone control no longer scales with the tier it is chasing');
// Friction is the difference between a zone you can park and one that can only overshoot.
assert.match(fishingSource, /zoneVelocity \*= Math\.pow\(ZONE_FRICTION, delta \* 60\);/, 'the hook zone has no friction, so holding accelerates without bound');
assert.match(fishingSource, /fishVelocity \*= Math\.pow\(\.93, delta \* 60\);/, 'fish damping is per frame, so the fight differs by refresh rate');
// Ending a cast must not end the animation loop, or the panel freezes after the first fish.
assert.match(fishingSource, /if \(progress >= 1\) land\(\);\s*\n\s*else if \(progress <= LOSE_FLOOR\) lose\(/, 'ending a cast returns before the next frame is queued');
// Scaling fill and drain together is what keeps a longer fight from also being an easier one.
assert.match(fishingSource, /\(inside \? rule\.fill : -rule\.drain\) \* FIGHT_PACE \* delta/, 'fight pacing no longer scales fill and drain by the same factor');
assert.match(fishingSource, /draw\(\);\s*\n\s*frame = requestAnimationFrame\(step\);\s*\n\s*\}/, 'the animation loop does not always queue its next frame');
assert.match(dragSource, /button, input, select, textarea, a, \[data-no-drag\]/, 'draggable panels no longer honour data-no-drag');
const fishingOpenSource = fishingSource.slice(fishingSource.indexOf('function open()'), fishingSource.indexOf('function close()'));
assert.match(fishingOpenSource, /host\.hidden = false;\s*primeFishingAudio\(\);\s*renderChrome\(\);\s*if \(!draggableReady\) \{[\s\S]*makeDraggable\(card, POSITION_KEY\)/, 'the saved fishing position is restored while the panel is still hidden');
assert.doesNotMatch(fishingSource.slice(fishingSource.indexOf('function mount()')), /makeDraggable\(card, POSITION_KEY\)/, 'fishing drag is initialised before the hidden panel has a measurable size');
assert.equal((fishingSource.match(/if \(view === 'game'\) resumeLoop\(\);\s*else pauseLoop\(\);/g) ?? []).length, 2, 'non-game fishing views do not pause and resume the animation loop');
assert.match(fishingSource, /function pauseLoop\(\)[\s\S]*pausedAt = performance\.now\(\);[\s\S]*stopLoop\(\);/, 'fishing does not record when its animation loop was paused');
assert.match(fishingSource, /function shiftActiveTimers\(duration: number\)[\s\S]*waitUntil \+= duration;[\s\S]*biteAt \+= duration;[\s\S]*reelStartedAt \+= duration;[\s\S]*reelEndsAt \+= duration;[\s\S]*retargetAt \+= duration;/, 'not every active fishing timer is shifted by a pause');
assert.match(fishingSource, /const pausedFor = performance\.now\(\) - pausedAt;\s*shiftActiveTimers\(pausedFor\);/, 'resuming fishing does not shift its active timers');
assert.match(fishingSource, /const gap = Math\.max\(0, now - lastTime\);[\s\S]*if \(gap > 1000\) shiftActiveTimers\(gap\);/, 'a throttled animation frame can expire an active fishing timer');
assert.match(fishingSource, /function startLoop\(\): void \{\s*lastTime = performance\.now\(\);\s*if \(frame === null\) frame = requestAnimationFrame\(step\);/, 'a new fishing action can inherit and apply a stale frame gap');
assert.match(fishingSource, /function cast\(\)[\s\S]*playCast\(\);\s*resumeLoop\(\);/, 'casting bypasses fishing pause recovery');
assert.match(fishingSource, /function close\(\)[\s\S]*host\.hidden = true;\s*pauseLoop\(\);/, 'closing fishing does not pause its active timers');
// The angler is the player's own blobbling, read from the cosmetic the game already stores on them.
assert.match(fishingSource, /self\?\.cosmetic\?\.avatar/, 'the fishing angler does not use the player cosmetic');
assert.match(fishingSource, /`\$\{base\}cosmetic\/\$\{layer\}`/, 'avatar layers are not loaded from the cosmetic asset path');
// The asset version is scraped from the page, never written down, or a game update blanks the art.
assert.doesNotMatch(fishingSource, /version\/\d+\//, 'fishing pins a game asset version instead of detecting it');
assert.match(fishingSource, /\/\\\/version\\\/\(\[\^\/\]\+\)\\\//, 'the fishing asset base is no longer detected from the page');
assert.match(fishingSource, /const source = pet \? petSpriteSource\(pet\) : undefined;/, 'shore pets do not use the mutation-tinted pet sprites');
assert.match(petsSource, /export function petSpriteSource/, 'the tinted pet sprite is not shared with anything that draws');
assert.match(fishingSource, /image\.complete && image\.naturalWidth > 0/, 'a half-loaded image can be drawn');
// Sprites are padded to their own frames, so standing one on the ground by its box leaves it hovering.
assert.match(fishingSource, /const inset = footInset\(bottomImage, bottomSource\);/, 'the angler is placed by its image box rather than its artwork');
assert.match(fishingSource, /inset = \(probe\.height - 1 - y\) \/ probe\.height;/, 'sprite ground contact is guessed rather than measured');

console.log('Static checks passed');
