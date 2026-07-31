import { initCompanion } from './companion.js';
import { initAbilitySilencer } from './features/ability-silencer.js';
import { initGardenOverview } from './features/garden-overview.js';
import { initGardenPlanner } from './features/garden-planner.js';
import { initPlantDragMove } from './features/plant-drag-move.js';
import { installPetSpriteLoader } from './pet-sprites-injector.js';
import type { CompanionPage } from './types.js';

initCompanion();
initAbilitySilencer();
installPetSpriteLoader();

const page = window as unknown as CompanionPage;
if (page.__gardenCompanionFeature?.('overview')) initGardenOverview();
initPlantDragMove();
initGardenPlanner();
