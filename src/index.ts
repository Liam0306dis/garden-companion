import { initCatalogCapture } from './game-catalogs.js';
import { initCompanion } from './companion.js';
import { initAbilitySilencer } from './features/ability-silencer.js';
import { initGardenOverview } from './features/garden-overview.js';
import { initGardenPlanner } from './features/garden-planner.js';
import { initFishing } from './features/fishing.js';
import { initPlantDragMove } from './features/plant-drag-move.js';
import { initPlanterPotSelection } from './features/planter-pot-selection.js';
import { initCelestialLayoutGuide } from './features/celestial-layout-guide.js';
import { installPetSpriteLoader } from './pet-sprites-injector.js';
import type { CompanionPage } from './types.js';

// First, so the game's own catalogs are seen before it finishes starting up.
initCatalogCapture();
initCompanion();
initAbilitySilencer();
installPetSpriteLoader();

const page = window as unknown as CompanionPage;
if (page.__gardenCompanionFeature?.('overview')) initGardenOverview();
initPlantDragMove();
initPlanterPotSelection();
initCelestialLayoutGuide();
initGardenPlanner();
initFishing();
