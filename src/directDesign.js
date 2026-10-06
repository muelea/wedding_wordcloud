'use strict';

const DIRECT_DESIGN_TITLE = 'Euer Erinnerungsstück';

// Public word-cloud creation always requires an organizer PIN. Direct designs
// use the existing nullable PIN pair for their isolated, event-scoped workspace.
function isDirectDesignEvent(event) {
  return event?.organizer_pin_hash === null && event.organizer_pin_salt === null;
}

module.exports = { DIRECT_DESIGN_TITLE, isDirectDesignEvent };
