import * as atomCache from './atom-cache.js';
import * as config from './config.js';
import * as connectionState from './connection-state.js';
import * as constants from './constants.js';
import * as cropSize from './crop-size.js';
import * as draggable from './draggable.js';
import * as gameConnection from './game-connection.js';
import * as listSearch from './list-search.js';
import * as pageModule from './page.js';
import * as panelActions from './panel-actions.js';
import * as pets from './pets.js';
import * as retry from './retry.js';
import * as state from './state.js';
import * as ticker from './ticker.js';
import * as toast from './toast.js';
import * as utils from './utils.js';
import * as autoStore from './features/auto-store.js';
import * as cropProtection from './features/crop-protection.js';
import * as petFood from './features/pet-food.js';
import * as petTeams from './features/pet-teams.js';
import * as shopAlarms from './features/shop-alarms.js';
import { page } from './page.js';

/**
 * Bumped only when an exposed module changes in a way an add-on built against the old shape would
 * misread. Adding a module or an export does not need a bump.
 */
export const ADDON_API_VERSION = 1;

/** Fired on the page once the modules below are published. */
export const ADDON_READY_EVENT = 'gardencompanion:addon-ready';

/**
 * Publishes the companion's own module instances for add-on userscripts, keyed by their path under
 * src/ without the extension. An add-on has to share these rather than bundle copies: the room state,
 * the command sequencer, the pet teams and the live game catalogs only exist once, inside this
 * script. Each value is the module namespace itself, so a binding the module reassigns later
 * (panelActions) is still current when an add-on reads it.
 */
export function exposeAddonApi(): void {
  page.__gardenCompanionAddonApi = {
    version: ADDON_API_VERSION,
    scriptVersion: state.state.version,
    modules: {
      'atom-cache': atomCache,
      'config': config,
      'connection-state': connectionState,
      'constants': constants,
      'crop-size': cropSize,
      'draggable': draggable,
      'game-connection': gameConnection,
      'list-search': listSearch,
      'page': pageModule,
      'panel-actions': panelActions,
      'pets': pets,
      'retry': retry,
      'state': state,
      'ticker': ticker,
      'toast': toast,
      'utils': utils,
      'features/auto-store': autoStore,
      'features/crop-protection': cropProtection,
      'features/pet-food': petFood,
      'features/pet-teams': petTeams,
      'features/shop-alarms': shopAlarms,
    },
  };
  try { page.dispatchEvent(new Event(ADDON_READY_EVENT)); } catch { /* nothing listening */ }
}
