import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const built = await readFile(resolve(root, 'dist', 'garden-companion.user.js'), 'utf8');
const companionSource = await readFile(resolve(root, 'src', 'companion.ts'), 'utf8');
const styleSource = await readFile(resolve(root, 'src', 'style.css'), 'utf8');
const overviewSource = await readFile(resolve(root, 'src', 'features', 'garden-overview.ts'), 'utf8');
const plantDragSource = await readFile(resolve(root, 'src', 'features', 'plant-drag-move.ts'), 'utf8');
const indexSource = await readFile(resolve(root, 'src', 'index.ts'), 'utf8');
const petSpriteSource = await readFile(resolve(root, 'src', 'pet-sprites.ts'), 'utf8');
const petSpriteInjector = await readFile(resolve(root, 'src', 'pet-sprites-injector.ts'), 'utf8');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string };

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
assert.ok(!built.includes('\u2014'), 'em dash found');
assert.ok(!built.includes('@ts-nocheck'), 'unchecked TypeScript boundary found');
assert.ok(!/setInterval\([^)]*(PurchaseShopItem|HarvestCrop|ApplyPetTeam)/s.test(built), 'unattended command loop found');
assert.ok(!built.includes('vendor/'), 'vendored source reference found');
assert.match(companionSource, /send\(\{ type: 'QuinoaCommand', requestId, command \}\)/, 'Quinoa command envelope missing');
assert.match(companionSource, /sendQuinoaCommand\(\{ type: 'PurchaseShopItem', shop: live\.shop, item: itemPayload\(live\.item, live\.shop\) \}\)/, 'purchase does not use Quinoa envelope');
assert.doesNotMatch(companionSource, /send\(\{ type: 'PurchaseShopItem'/, 'unwrapped purchase command found');
assert.doesNotMatch(companionSource, /send\(\{ type: 'Ping'/, 'redundant game Ping sender found');
assert.doesNotMatch(companionSource, /dispatchEvent\(new MouseEvent/, 'synthetic activity event found');
assert.match(companionSource, /event\.code === 4710/, 'version-expired WebSocket detection missing');
assert.match(companionSource, /game update available/, 'game update dialog detection missing');
assert.match(companionSource, /'visibilityState'.*'visible'/s, 'background visibility mode missing');
assert.match(companionSource, /if \(input\.checked\)[\s\S]*showSelectedShopAlarm\(key\)/, 'enabling an alarm does not inspect current stock');
assert.match(companionSource, /if \(input\.checked\)[\s\S]*armAlarmAudio\(\)/, 'alarm audio is not armed by the settings gesture');
assert.doesNotMatch(companionSource, /alarm\?\.audio\?\.close/, 'alarm stop closes the reusable audio context');
assert.match(companionSource, /count >= 100/, 'per-ability history limit missing');
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
assert.match(styleSource, /\.gc-lunar-countdown strong \{[^}]*font:650 27px/, 'lunar countdown is too small');
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
assert.match(companionSource, /\['teams', 'abilities', 'shops'\]\.includes\(activeTab\)/, 'open shop alarms do not refresh when sprites load');
for (const shopSpriteGroup of ["seed", "egg", "tool", "decor"]) assert.match(petSpriteSource, new RegExp(`${shopSpriteGroup}: \\[`), `missing ${shopSpriteGroup} sprite group`);
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
assert.match(companionSource, /\['abilities', 'Active Pets'\], \['abilityLog', 'Pet Abilities'\], \['teams', 'Pet Teams'\], \['shops', 'Shop Alarms'\], \['silence', 'Silence'\], \['rooms', 'Rooms'\], \['features', 'Features'\]/, 'tab order is incorrect');
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
assert.match(companionSource, /function renderAbilityLog/, 'Pet Abilities history tab missing');
assert.doesNotMatch(companionSource.slice(companionSource.indexOf('function renderAbilities()'), companionSource.indexOf('function renderAbilityLog()')), /Recent tracked procs/, 'proc history remains on Active Pets');
assert.match(companionSource, /activeTab === 'abilityLog' \? 'gc-ability-log-tab' : ''/, 'Pet Abilities tab cannot use the full panel height');
assert.match(companionSource, /gc-card gc-ability-log-card/, 'recent proc card lacks its expanding layout class');
assert.match(styleSource, /\.gc-ability-log-card \{[^}]*min-height:0[^}]*flex:1[^}]*display:flex[^}]*flex-direction:column/s, 'recent proc card does not expand vertically');
assert.match(styleSource, /\.gc-ability-log-tab \.gc-log \{[^}]*max-height:none[^}]*flex:1/s, 'recent proc list remains height-limited');
assert.match(companionSource, /\['seed', 'Seeds'\], \['dawn', 'Dawn'\], \['thunder', 'Thunder'\], \['snow', 'Snow'\], \['egg', 'Eggs'\], \['tool', 'Tools'\], \['decor', 'Decor'\]/, 'shop alarm tab order is incorrect');
for (const seasonalItem of ['Dawnbreaker', 'DawnCelestial', 'DawnEgg', 'ThunderCelestial', 'ThunderEgg', 'SnowEgg', 'ChilledPotion', 'FrozenPotion']) assert.ok(companionSource.includes(seasonalItem), `seasonal shop item ${seasonalItem} missing`);
assert.match(companionSource, /gc-team-abilities/, 'team creation does not show pet abilities');
assert.match(companionSource, /data-team-search placeholder="Filter by pet name, species, or ability"/, 'team pet filter is missing');
assert.match(companionSource, /Press Esc to cancel or clear/, 'pet team keybind Escape guidance is missing');
assert.match(companionSource, /Press keys\.\.\. Esc cancels/, 'pet team key capture does not show Escape guidance');
assert.match(companionSource, /pet\.name[\s\S]*pet\.petSpecies[\s\S]*ABILITY_DETAILS\[ability\]\?\.name[\s\S]*\.toLowerCase\(\)/, 'team pet filter does not include names, species, and abilities');
assert.match(companionSource, /bindListSearch\(main\.querySelector\('\[data-team-search\]'\), query => \{ teamSearchQuery = query; \}\)/, 'team pet filter is not bound or preserved');
assert.doesNotMatch(companionSource.slice(companionSource.indexOf('function renderTeams()'), companionSource.indexOf('function renderAbilities()')), /hungerDisplay\(pet\)/, 'team creation still shows hunger');
assert.match(companionSource, /SavePetTeam', teamId, name/, 'saved teams cannot be updated');
assert.match(companionSource, /data-edit-team/, 'saved team edit control missing');
assert.match(companionSource, /refreshCompletedTeamSave\(\);[\s\S]*processActivities\(\)/, 'saved team state does not trigger a team refresh');
assert.match(companionSource, /pendingTeamSave = \{ teamId, name, petIds \}/, 'team save completion is not tracked');
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
assert.match(companionSource, /`Value: \$\{Math\.round/, 'crop value label is incorrect');
assert.match(companionSource, /`Growth estimate: \$\{formatDuration/, 'growth estimate label is incorrect');
assert.match(companionSource, /endsWith\('\/quinoaEngineAtom'\)/, 'game engine capture does not use the engine atom');
assert.match(companionSource, /engine\.getSystem\('gardenInfoCard'\)\?\.view/, 'garden card system is not captured from the game engine');
assert.match(companionSource, /key: 'time',[\s\S]*gardenCompanionEstimate: true/, 'estimates are not inserted as native garden card attributes');
assert.match(companionSource, /attributes: \[\.\.\.attributes, \.\.\.estimateAttributes\]/, 'native estimate attributes are not included in card measurement');
assert.doesNotMatch(companionSource, /nativeTimer\.text\}\\n/, 'native timer still uses the unsupported multiline layout');
assert.match(companionSource, /function shiftNativeRowToCardCenter[\s\S]*for \(const peer of peers\) peer\.x \+= offset \/ worldScale/, 'crop timer and estimate row is not centred as one unit');
assert.match(companionSource, /if \(!signature\.startsWith\('Value:'\)\) return false/, 'egg estimate is still repositioned away from the native timer row');
assert.doesNotMatch(companionSource, /gardenCompanionEggEstimateLayout|nativeBottom|section\.height \+= extraHeight/, 'legacy egg second-row layout remains');
assert.match(companionSource, /if \(refreshNativeGardenCard\(\)\) return;/, 'HTML estimate fallback remains active after the native hook succeeds');
assert.doesNotMatch(companionSource, /requestAnimationFrame\(renderTurtleOverlay\)/, 'garden card estimates still run every animation frame');
assert.match(companionSource, /setInterval\(renderTurtleOverlay, 250\)/, 'garden card estimate refresh is not throttled');
const featuresSource = companionSource.slice(companionSource.indexOf('function renderFeatures()'), companionSource.indexOf('function renderTeams()'));
for (const removedToggle of ['overview', 'petTeams', 'abilities', 'rooms', 'shopAlarms', 'interfaceShortcuts', 'abilitySilencer', 'lunarTimer']) {
  assert.doesNotMatch(featuresSource, new RegExp(`\\['${removedToggle}',\\s*'`), `removed ${removedToggle} feature toggle remains`);
}
assert.match(styleSource, /\.gc-pet-sprite \{[^}]*width:48px[^}]*height:48px/s, 'pet sprite frame size is incorrect');
assert.match(styleSource, /\.gc-pet-sprite img \{[^}]*width:40px[^}]*height:40px/s, 'pet sprite artwork lacks safe scaling');
assert.match(companionSource, /function renderMutatedPetSprite/, 'per-species pet mutation rendering is missing');
assert.match(companionSource, /pixels\[\(y \* canvas\.width \+ x\) \* 4 \+ 3\] < 8/, 'rainbow gradient does not inspect visible pet pixels');
assert.match(companionSource, /createLinearGradient\(minimum \/ 2, minimum \/ 2, maximum \/ 2, maximum \/ 2\)/, 'rainbow gradient is not fitted to each pet body');
assert.match(companionSource, /globalCompositeOperation = 'color'/, 'rainbow sprite rendering does not preserve luminosity');
assert.match(companionSource, /globalCompositeOperation = 'destination-in'/, 'pet mutation rendering is not clipped to sprite transparency');
assert.doesNotMatch(styleSource, /gc-pet-sprite\[data-overlay=/, 'legacy CSS pet mutation overlay remains');
console.log('Static checks passed');
