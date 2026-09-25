'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const landing = fs.readFileSync(path.join(ROOT, 'views', 'landing.ejs'), 'utf8');
const display = fs.readFileSync(path.join(ROOT, 'views', 'display.ejs'), 'utf8');
const configure = fs.readFileSync(path.join(ROOT, 'views', 'configure.ejs'), 'utf8');
const shipping = fs.readFileSync(path.join(ROOT, 'views', 'shipping.ejs'), 'utf8');
const orderConfirmation = fs.readFileSync(path.join(ROOT, 'views', 'order-confirmation.ejs'), 'utf8');
const siteHeader = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'site-header.ejs'), 'utf8');
const hamburgerIcon = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'hamburger-icon.ejs'), 'utf8');
const siteHeaderStyles = fs.readFileSync(path.join(ROOT, 'public', 'site-header.css'), 'utf8');
const legalStyles = fs.readFileSync(path.join(ROOT, 'public', 'legal.css'), 'utf8');
const i18nStyles = fs.readFileSync(path.join(ROOT, 'public', 'i18n.css'), 'utf8');
const mobileStyles = fs.readFileSync(path.join(ROOT, 'public', 'mobile-foundation.css'), 'utf8');
const mobileRuntime = fs.readFileSync(path.join(ROOT, 'public', 'js', 'mobile-ui.js'), 'utf8');
const workspaceStyles = fs.readFileSync(path.join(ROOT, 'public', 'configurator-workspace.css'), 'utf8');
const landingWorkflowStyles = fs.readFileSync(path.join(ROOT, 'public', 'landing-workflow.css'), 'utf8');
const landingWorkflowRuntime = fs.readFileSync(path.join(ROOT, 'public', 'js', 'landing-workflow.js'), 'utf8');
const documentViews = [
  '404.ejs',
  'configure.ejs',
  'datenschutz.ejs',
  'bestellinformationen.ejs',
  'display.ejs',
  'impressum.ejs',
  'landing.ejs',
  'order-confirmation.ejs',
  'shipping.ejs',
].map((file) => ({ file, source: fs.readFileSync(path.join(ROOT, 'views', file), 'utf8') }));
const database = fs.readFileSync(path.join(ROOT, 'src', 'db.js'), 'utf8');
const eventsRoute = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'events.js'), 'utf8');
const titleMigration = fs.readFileSync(path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260901000000_generalize_event_naming.sql'
), 'utf8');
const organizerMigration = fs.readFileSync(path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260901010000_organizer_pin_and_personal_palettes.sql'
), 'utf8');

test('event titles use the general title contract and a data-preserving migration', () => {
  assert.match(titleMigration, /alter table events rename column couple_name to title/i);
  assert.match(titleMigration, /alter table events rename column event_label to subtitle/i);
  assert.match(titleMigration, /alter table orders rename column event_label_snapshot to event_title_snapshot/i);
  assert.match(titleMigration, /app_schema_versions \(version\) values \(2\)/i);
  assert.doesNotMatch(database, /couple_name|coupleName|event_label|eventLabel/);
  assert.doesNotMatch(eventsRoute, /couple_name|coupleName|invalid_couple_name|event_label|eventLabel/);
  assert.match(eventsRoute, /title: event\.title/);
  assert.match(organizerMigration, /drop column subtitle/i);
  assert.match(organizerMigration, /drop column theme/i);
  assert.match(organizerMigration, /drop column is_draft/i);
  assert.match(organizerMigration, /rename column admin_pin_hash to organizer_pin_hash/i);
  assert.match(organizerMigration, /rename to organizer_pin_failures/i);
  assert.match(organizerMigration, /app_schema_versions \(version\) values \(3\)/i);
  assert.doesNotMatch(database, /admin_pin_hash|admin_pin_salt|admin_pin_failures/);
  assert.doesNotMatch(eventsRoute, /subtitle: event\.subtitle|event\.theme|event\.is_draft/);
  assert.match(eventsRoute, /error: 'invalid_title'/);
});

test('live word cloud uses a font-ready HiDPI backing canvas', () => {
  assert.match(display, /MAX_CANVAS_PIXEL_RATIO = 3/);
  assert.match(display, /window\.devicePixelRatio/);
  assert.match(display, /canvas\.width = Math\.max\(1, Math\.round\(width \* pixelRatio\)\)/);
  assert.match(display, /canvas\.height = Math\.max\(1, Math\.round\(height \* pixelRatio\)\)/);
  assert.match(display, /canvas\.style\.width = `\$\{width\}px`/);
  assert.match(display, /ctx\.setTransform\(canvas\.width \/ width, 0, 0, canvas\.height \/ height, 0, 0\)/);
  assert.match(display, /document\.fonts\?\.load/);
});

test('flat previews supersample screen pixels without unbounded canvas allocations', () => {
  const source = configure.match(/    function setupCanvas\(canvas\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(source);
  const window = { devicePixelRatio: 1 };
  const setupCanvas = vm.runInNewContext(`${source}; setupCanvas`, { window });
  const context = {};
  let rect = { width: 300, height: 450 };
  let dimensions = { width: 0, height: 0 };
  let allocations = 0;
  const canvas = {
    getBoundingClientRect: () => rect,
    getContext: () => context,
    get width() { return dimensions.width; },
    set width(value) { dimensions.width = value; allocations++; },
    get height() { return dimensions.height; },
    set height(value) { dimensions.height = value; allocations++; },
  };
  for (const [dpr, width, height] of [[1, 600, 900], [2, 1024, 1536], [3, 1024, 1536]]) {
    window.devicePixelRatio = dpr;
    assert.equal(setupCanvas(canvas), context);
    assert.deepEqual(dimensions, { width, height });
    const before = allocations;
    setupCanvas(canvas);
    assert.equal(allocations, before, 'ordinary redraws reuse the existing bitmap');
  }
  rect = { width: 450, height: 300 };
  setupCanvas(canvas);
  assert.deepEqual(dimensions, { width: 1536, height: 1024 }, 'landscape keeps the same density and proportions');
  rect = { width: 4000, height: 4000 };
  setupCanvas(canvas);
  assert.deepEqual(dimensions, { width: 1536, height: 1536 }, 'large viewports stay bounded');
  rect = { width: 0, height: 0 };
  setupCanvas(canvas);
  assert.deepEqual(dimensions, { width: 1, height: 1 }, 'hidden previews remain valid canvases');
});

test('word cloud header keeps the keepsake action compact at mobile widths', () => {
  assert.match(siteHeader, /class="ww-display-header-actions"[\s\S]*?id="memory-cta"[\s\S]*?id="display-page-menu"/);
  assert.match(display, /\.ww-keepsake-cta \{[\s\S]*?height: 44px;[\s\S]*?min-width: 44px;/);
  assert.match(display, /@media \(max-width: 620px\)[\s\S]*?\.ww-keepsake-cta-label-full \{ display: none; \}[\s\S]*?\.ww-keepsake-cta-label-compact \{ display: inline; \}/);
  assert.match(display, /@media \(max-width: 360px\)[\s\S]*?\.ww-keepsake-cta \{ width: 44px; padding: 0; \}[\s\S]*?\.ww-keepsake-cta-label-compact \{ display: none; \}/);
});

test('every header menu uses the one shared premium hamburger component', () => {
  assert.equal((siteHeader.match(/include\('hamburger-icon'\)/g) || []).length, 3);
  assert.equal((hamburgerIcon.match(/<i><\/i>/g) || []).length, 3);
  assert.doesNotMatch(siteHeader, /(?:landing-menu-toggle-icon|ww-display-menu-icon)/);
  assert.doesNotMatch(landing, /landing-menu-toggle-icon/);
  assert.doesNotMatch(display, /ww-display-menu-icon/);
  assert.match(siteHeaderStyles, /\.ww-menu-trigger \{[\s\S]*?width: 44px;[\s\S]*?border-radius: 50%;/);
  assert.match(siteHeaderStyles, /\.ww-hamburger-icon i \{[\s\S]*?width: 18px;[\s\S]*?height: 1px;/);
});

test('the configurator always keeps language in its menu and moves back navigation there when compact', () => {
  assert.match(siteHeader, /variant === 'back' && mobileMenu/);
  assert.match(siteHeader, /class="ww-mobile-header-menu-back"[\s\S]*?mobileBackId/);
  assert.match(siteHeader, /languagePickerClass: 'ww-mobile-header-menu-language'/);
  assert.match(siteHeaderStyles, /\.ww-back-header-desktop-language \{ display: none !important; \}/);
  assert.match(siteHeaderStyles, /\.ww-mobile-header-menu \{[\s\S]*?display: block;/);
  assert.match(siteHeaderStyles, /\.ww-mobile-header-menu-back \{[\s\S]*?display: none;/);
  assert.match(siteHeaderStyles, /@media \(max-width: 780px\)[\s\S]*?\.ww-back-link-desktop \{ display: none !important; \}[\s\S]*?\.ww-mobile-header-menu-back \{[\s\S]*?display: flex;/);
});

test('the configurator uses one conditional header cart at every viewport size', () => {
  assert.match(siteHeader, /if \(cartButton\)[\s\S]*?class="ww-header-cart ww-menu-trigger"/);
  assert.match(siteHeader, /class="ww-header-cart-icon"[\s\S]*?class="ww-header-cart-badge"/);
  assert.match(siteHeaderStyles, /\.ww-back-header-actions \{[\s\S]*?gap: 8px;/);
  assert.match(siteHeaderStyles, /\.ww-header-cart\[hidden\] \{ display: none !important; \}/);
  assert.match(siteHeaderStyles, /\.ww-header-cart-badge \{[\s\S]*?position: absolute;[\s\S]*?border-radius: 999px;/);
  assert.doesNotMatch(configure, /mobile-cart-summary|mobileCartSummary/);
  assert.match(configure, /function updateHeaderCart\(items\)[\s\S]*?headerCart\.hidden = count === 0;[\s\S]*?String\(count\)/);
  assert.match(configure, /function renderOrderBox\(\)[\s\S]*?updateHeaderCart\(items\)/);
  assert.match(configure, /headerCart\?\.addEventListener\('click'[\s\S]*?orderBox\.scrollIntoView/);
});

test('wide back-header navigation is centered against the viewport, not unequal side content', () => {
  assert.match(siteHeaderStyles, /\.ww-nav \{[\s\S]*?position: relative !important;/);
  assert.match(siteHeaderStyles, /\.ww-back-link-desktop \{[\s\S]*?position: absolute;[\s\S]*?top: 50%;[\s\S]*?left: 50%;[\s\S]*?transform: translate\(-50%, -50%\);/);
});

test('shipping keeps both return links synchronized behind the same responsive header menu', () => {
  assert.match(shipping, /const mobileBackLink = document\.getElementById\('mobile-back-link'\)/);
  assert.match(shipping, /const backLinks = \[backLink, mobileBackLink\]\.filter\(Boolean\)/);
  assert.match(shipping, /function setBackHref\(href\)[\s\S]*?backLinks\.forEach/);
  assert.match(shipping, /backLinks\.forEach\(\(link\) => \{ link\.addEventListener\('click', saveShippingDraft\); \}\)/);
});

test('customs notice stays with purchase information instead of the site footer', () => {
  const notice = /Bei Lieferungen in bestimmte Länder können zusätzliche Zölle, Einfuhrsteuern oder sonstige Einfuhrgebühren anfallen\. Diese sind vom Empfänger zu tragen\./;
  for (const source of [shipping, orderConfirmation]) assert.match(source, notice);
  for (const source of [landing, configure]) assert.doesNotMatch(source, notice);
  const footer = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'site-footer.ejs'), 'utf8');
  assert.doesNotMatch(footer, notice);
});

test('the personal display palette is handed off to the configurator', () => {
  assert.match(siteHeader, /id="display-palette-picker"/);
  assert.match(siteHeader, /class="ww-palette-menu" role="radiogroup"/);
  assert.match(siteHeader, /class="ww-palette-option[^\"]*"[\s\S]*?role="radio"[\s\S]*?aria-checked=/);
  assert.doesNotMatch(siteHeader, /id="display-palette-select"|<select[^>]*aria-label="Farbwelt"/);
  assert.match(display, /\.ww-palette-menu \{[\s\S]*?position: absolute;[\s\S]*?border-radius: 14px;/);
  assert.match(display, /palettePicker\?\.addEventListener\('keydown'/);
  assert.match(display, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/);
  assert.match(display, /paletteStorageKey = `wordcloud-palette:\$\{slug\}`/);
  assert.match(display, /localStorage\.setItem\(paletteStorageKey, resolvedKey\)/);
  assert.match(configure, /paletteStorageKey = `wordcloud-palette:\$\{slug\}`/);
  assert.match(configure, /localStorage\.getItem\(paletteStorageKey\)/);
  assert.match(configure, /option\.key === preferredPalette && option\.key !== 'custom'/);
});

test('the phone configurator starts with one preview-first purchase path', () => {
  assert.match(configure, /id="config-studio" data-mobile-editor-expanded="false"/);
  assert.match(configure, /id="mobile-editor-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="design-toolbar editor-card"/);
  assert.match(configure, /id="mobile-editor-collapse"[^>]*aria-expanded="true"[^>]*aria-controls="design-toolbar editor-card"/);
  assert.match(configure, /id="mobile-selected-product-name"/);
  assert.match(configure, /id="mobile-selected-theme-swatches"/);
  assert.match(configure, /id="continue-order-label"/);
  assert.equal((configure.match(/id="wrap-canvas"/g) || []).length, 1,
    'the compact purchase surface must reuse the only editor canvas');
  assert.match(configure, /@media \(max-width: 620px\)[\s\S]*?\.config-studio\[data-mobile-editor-expanded="false"\] \.design-toolbar,[\s\S]*?\.editor-card \{[\s\S]*?display: none;/);
  assert.match(configure, /\.config-studio\[data-mobile-editor-expanded="false"\] \.checkout-panel \{[\s\S]*?position: fixed;[\s\S]*?bottom: max\(8px, var\(--ww-safe-bottom\)\);[\s\S]*?padding: 0;[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
  assert.match(configure, /\.mobile-editor-caret \{[\s\S]*?width: 7px;[\s\S]*?border-right: 1\.5px solid currentColor;[\s\S]*?transform: rotate\(45deg\);/);
  assert.doesNotMatch(configure, /class="mobile-editor-caret"[^>]*>[^<]+<\/span>/,
    'mobile disclosure buttons use the aligned CSS chevron, not a font glyph');
  assert.match(configure, /function setMobileEditorExpanded\(expanded, \{ scroll = true \} = \{\}\)/);
  assert.match(configure, /setText\(continueOrderLabel, items\.length\s*\? 'Zur Lieferadresse'/);
  assert.match(configure, /!await saveCurrentDesign\(continueOrderButton\)/,
    'the explicit compact CTA approves the current design before navigation');
  assert.match(configure, /id="shipping-choice-dialog"[\s\S]*?id="shipping-choice-current-cart"[\s\S]*?id="shipping-choice-save"/);
  assert.match(workspaceStyles,
    /grid-template-areas: 'create create selection layout reset' 'view view view history history'/,
    'Select all and Fill the area stay adjacent in the compact editor toolbar');
  assert.match(configure, /<h2 class="editor-title workspace-section-title"[^>]*>[\s\S]*?<div id="editor-compact-toolbar"><\/div>[\s\S]*?<div class="wrap-preview">/);
  assert.match(configure, /class="workspace-shell"[\s\S]*?class="workspace-tools"[\s\S]*?class="workbench"/);
  assert.match(configure, /class="editor-title workspace-section-title" id="editor-title"/);
  assert.match(configure, /class="workspace-section-title" id="preview-title">Euer Design<\/h2>/);
  assert.match(configure, /\.workspace-section-title \{[\s\S]*?clip-path: inset\(50%\)/);
  assert.match(configure, /@media \(max-width: 620px\) \{[\s\S]*?#preview-title\.workspace-section-title \{[\s\S]*?position: static;[\s\S]*?clip-path: none;/);
  assert.match(configure, /@media \(min-width: 941px\) \{[\s\S]*?\.workspace-shell \{[\s\S]*?grid-template-areas:[\s\S]*?"workspace-toolbar workspace-toolbar"[\s\S]*?"workspace-canvas workspace-preview"[\s\S]*?"workspace-inspector workspace-inspector"/);
  assert.match(configure, /@media \(min-width: 941px\) \{[\s\S]*?\.preview-card \{[\s\S]*?border-left: 1px solid var\(--line\)/);
  assert.match(workspaceStyles, /@media \(max-width: 940px\) \{[\s\S]*?\.workspace-tools \{ display: none; \}[\s\S]*?#editor-compact-toolbar \{[\s\S]*?display: block;/);
  assert.match(workspaceStyles, /#editor-compact-toolbar \{[\s\S]*?border-bottom: 1px solid var\(--line\)/);
});

test('shipping is the compact cart review with edit, remove and quantity controls', () => {
  assert.match(shipping, /setText\(productsTitle, 'Euer Warenkorb'\)/);
  assert.match(shipping, /edit\.href = configureHref\(itemConfiguration\.id\)/);
  assert.match(shipping, /setText\(edit, 'Design anpassen'\)/);
  assert.match(shipping, /setText\(remove, 'Entfernen'\)/);
  assert.match(shipping, /removeConfigurationFromCart\(itemConfiguration\.id\)/);
  assert.match(shipping, /row\.append\(image, copy, actions, control\)/);
});

test('landing page uses an accessible desktop scroll story with a static mobile sequence', () => {
  assert.match(landing, /html \{ max-width: 100%;[\s\S]*?overflow-x: clip; \}/);
  assert.match(landing, /asset\('\/landing-workflow\.css'\)/);
  assert.match(landing, /asset\('\/js\/landing-workflow\.js'\)/);
  assert.equal((landing.match(/data-workflow-trigger="/g) || []).length, 5);
  assert.equal((landing.match(/data-workflow-panel="/g) || []).length, 5);
  assert.equal((landing.match(/aria-hidden="false" data-workflow-panel=/g) || []).length, 5);
  assert.match(landing, /id="workflow-step-0"[^>]*aria-controls="workflow-panel-0"[^>]*aria-current="step"/);
  assert.match(landing, /id="workflow-panel-0"[^>]*aria-labelledby="workflow-step-0"[^>]*aria-hidden="false"/);
  assert.match(landing, /class="workflow-locale-screenshot workflow-create-screenshot"[\s\S]*?asset\('\/assets\/workflow\/01_' \+ locale \+ '\.png'\)/);
  assert.match(landing, /class="workflow-locale-screenshot workflow-share-screenshot"[\s\S]*?asset\('\/assets\/workflow\/02_' \+ locale \+ '\.png'\)/);
  assert.match(landing, /class="workflow-locale-screenshot workflow-live-screenshot"[\s\S]*?asset\('\/assets\/workflow\/04_' \+ locale \+ '\.png'\)/);
  assert.equal((landing.match(/asset\('\/assets\/workflow\/03_' \+ locale \+ '\.png'\)/g) || []).length, 5);
  assert.match(landing, /workflow-contributor-phone--focus">\s*<img[\s\S]*?03_' \+ locale \+ '\.png'/);
  for (const step of ['01', '02', '04']) {
    for (const locale of ['de', 'en', 'es', 'fr', 'it', 'tr']) {
      assert.match(landing, new RegExp(`data-workflow-src-${locale}="<%= asset\\('\\/assets\\/workflow\\/${step}_${locale}\\.png'\\) %>"`));
    }
  }
  for (const locale of ['de', 'en', 'es', 'fr', 'it', 'tr']) {
    assert.match(landing, new RegExp(`data-workflow-src-${locale}="<%= asset\\('\\/assets\\/workflow\\/03_${locale}\\.png'\\) %>"`));
  }
  assert.equal((landing.match(/data-workflow-locale-screenshot(?=[\s>])/g) || []).length, 7);
  assert.equal((landing.match(/data-workflow-locale-screenshot-group/g) || []).length, 1);
  assert.equal((landing.match(/workflow-panel--capture/g) || []).length, 3);
  assert.match(landingWorkflowStyles, /\.workflow-locale-screenshot \{[\s\S]*?object-fit: cover;/);
  assert.match(landingWorkflowStyles, /\.workflow-panel--capture \{[\s\S]*?border: 0;[\s\S]*?background: transparent;/);
  assert.match(landingWorkflowStyles, /\.workflow-panel--capture \.workflow-panel-art \{[\s\S]*?inset: 0;/);
  assert.match(landingWorkflowStyles, /\.workflow-panel--capture \.workflow-locale-screenshot \{[\s\S]*?display: block;/);
  assert.match(landingWorkflowStyles, /\.workflow-panel--capture \.workflow-panel-art > :not\(\.workflow-locale-screenshot\) \{[\s\S]*?display: none;/);
  assert.match(landingWorkflowStyles, /\.workflow-panel--live \.workflow-panel-art \{[\s\S]*?inset: 0;/);
  assert.match(landingWorkflowStyles, /\.workflow-panel--live \.workflow-live-screenshot \{[\s\S]*?width: auto;[\s\S]*?height: auto;[\s\S]*?max-width: 100%;[\s\S]*?max-height: 100%;[\s\S]*?border: 1px solid[\s\S]*?border-radius: 14px;/);
  assert.match(landingWorkflowStyles, /\.workflow-panel--collect \.workflow-guest-phone \{[\s\S]*?display: none;/);
  assert.match(landingWorkflowStyles, /\.workflow-panel--collect \.workflow-contributor-crowd \{[\s\S]*?display: block;/);
  assert.match(landingWorkflowStyles, /\.workflow-contributor-phone \{[\s\S]*?position: absolute;[\s\S]*?top: 50%;[\s\S]*?overflow: visible;/);
  assert.match(landingWorkflowStyles, /\.workflow-contributor-phone img \{[\s\S]*?width: auto;[\s\S]*?max-width: none;[\s\S]*?height: 100%;[\s\S]*?object-fit: contain;/);
  assert.doesNotMatch(landingWorkflowStyles, /\.workflow-contributor-phone img \{[^}]*object-fit: fill;/);
  assert.match(landingWorkflowStyles, /\.workflow-contributor-phone--focus \{[\s\S]*?left: 50%;[\s\S]*?height: 94%;/);
  for (const product of ['01', '02', '03']) {
    assert.match(landing, new RegExp(`asset\\('\\/assets\\/workflow\\/05_${product}_' \\+ locale \\+ '\\.png'\\)`));
    for (const locale of ['de', 'en', 'es', 'fr', 'it', 'tr']) {
      assert.match(landing, new RegExp(`data-workflow-src-${locale}="<%= asset\\('\\/assets\\/workflow\\/05_${product}_${locale}\\.png'\\) %>"`));
    }
  }
  assert.match(landingWorkflowStyles, /\.workflow-keepsake-default \{[\s\S]*?display: none;/);
  assert.match(landingWorkflowStyles, /\.workflow-keepsake-gallery \{[\s\S]*?display: block;/);
  assert.match(landingWorkflowStyles, /\.workflow-keepsake-asset--mug \{[\s\S]*?z-index: 3;[\s\S]*?width: 86%;/);
  assert.match(landingWorkflowStyles, /@media \(max-width: 760px\) \{[\s\S]*?\.workflow-panel,[\s\S]*?\.workflow-step > \.workflow-panel \{[\s\S]*?aspect-ratio: \.94;/);
  assert.match(landingWorkflowStyles, /@media \(max-width: 760px\) \{[\s\S]*?\.workflow-panel--live,[\s\S]*?\.workflow-step > \.workflow-panel--live \{[\s\S]*?aspect-ratio: 840 \/ 1038;/);
  assert.match(landingWorkflowRuntime, /function updateLocaleScreenshots\(locale\)[\s\S]*?data-workflow-src-[\s\S]*?setAttribute\('src', nextSource\)/);
  assert.match(landingWorkflowRuntime, /document\.querySelectorAll\('\[data-workflow-locale-screenshot\]'\)/);
  assert.match(landingWorkflowRuntime, /localeScreenshotGroups\.forEach[\s\S]*?group\.querySelectorAll\('img'\)[\s\S]*?setAttribute\('src', nextSource\)/);
  assert.match(landingWorkflowRuntime, /wolkenworte:localechange[\s\S]*?updateLocaleScreenshots\(event\.detail && event\.detail\.locale\)/);
  const applyProgressSource = landingWorkflowRuntime.slice(
    landingWorkflowRuntime.indexOf('function applyProgress'),
    landingWorkflowRuntime.indexOf('function measureScrollProgress')
  );
  assert.match(applyProgressSource, /var transitionBaseIndex = reducedMotion\.matches \? activeIndex : Math\.floor\(progress\);[\s\S]*?var opacity = index < transitionBaseIndex \? 0 : clamp\(reveal \* 1\.65\);/);
  assert.match(landingWorkflowStyles, /min-height: calc\(var\(--workflow-sticky-height\) \+ 200vh\)/);
  assert.match(landingWorkflowStyles, /html\.workflow-scroll-ready \.workflow-sticky \{[\s\S]*?position: sticky;/);
  assert.match(landing, /--landing-split-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(landing, /--landing-split-gap: clamp\(56px, 5vw, 72px\);/);
  assert.match(landing, /\.hero-grid, \.print-grid \{[^}]*grid-template-columns: var\(--landing-split-columns\);[^}]*gap: var\(--landing-split-gap\);/);
  assert.match(landingWorkflowStyles, /grid-template-columns: var\(--landing-split-columns,[^;]+\);[\s\S]*?column-gap: var\(--landing-split-gap,/);
  assert.doesNotMatch(landingWorkflowStyles, /grid-template-columns: minmax\(315px, \.72fr\)/);
  assert.match(landingWorkflowStyles, /@media \(min-width: 1051px\) and \(max-height: 820px\) \{[\s\S]*?\.workflow-step-copy:not\(\[data-active='true'\]\) \.workflow-step-text > span \{[\s\S]*?display: none;/);
  assert.match(landingWorkflowStyles, /@media \(min-width: 1051px\) and \(max-width: 1279px\) \{[\s\S]*?\.workflow-step-copy:not\(\[data-active='true'\]\) \.workflow-step-text > span \{[\s\S]*?display: none;/);
  assert.match(landingWorkflowStyles, /@media \(max-width: 1050px\)[\s\S]*?html\.workflow-scroll-ready \.workflow-stage \{[\s\S]*?display: none;/);
  assert.match(landingWorkflowStyles, /\.workflow-step > \.workflow-panel \{[\s\S]*?margin: 4px auto 34px;/);
  assert.match(landingWorkflowStyles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(landingWorkflowRuntime, /matchMedia\('\(min-width: 1051px\)'\)/);
  assert.match(landingWorkflowRuntime, /window\.requestAnimationFrame\(renderScrollProgress\)/);
  assert.match(landingWorkflowRuntime, /window\.addEventListener\('scroll', requestScrollUpdate, \{ passive: true \}\)/);
  assert.match(landingWorkflowRuntime, /var scrubDurationMs = 240/);
  assert.match(landingWorkflowRuntime, /--workflow-panel-stack-y/);
  assert.match(landingWorkflowRuntime, /--workflow-panel-grayscale/);
  assert.doesNotMatch(landingWorkflowRuntime, /index < activeIndex \? 0/);
  assert.doesNotMatch(landingWorkflowRuntime, /--workflow-panel-saturation/);
  assert.doesNotMatch(landingWorkflowStyles, /box-shadow: 0 34px 80px/);
  assert.match(landingWorkflowStyles, /filter: brightness\(var\(--workflow-panel-brightness\)\) grayscale\(var\(--workflow-panel-grayscale\)\)/);
  assert.match(landingWorkflowRuntime, /steps\[index\]\.appendChild\(panel\)/);
  assert.match(landingWorkflowRuntime, /panel\.setAttribute\('aria-hidden', desktopLayout\.matches \? String\(!isActive\) : 'false'\)/);
  assert.match(landing, /\.print-grid \{[^}]*grid-template-areas: 'visual copy';/);
  assert.match(landing, /\.print-copy \{ grid-area: copy;[^}]*justify-self: start;/);
  assert.match(landing, /\.cup-stage \{ grid-area: visual;/);
  assert.match(landing, /<div class="print-grid">\s*<div class="print-copy">\s*<p class="eyebrow">[^<]+<\/p>\s*<h2 id="keepsakes-title">/);
  assert.match(landing, /@media \(max-width: 760px\)[\s\S]*?\.print-grid \{ grid-template-areas: 'copy' 'visual'; text-align: center; \}/);
  assert.doesNotMatch(landing, /\.cup-stage \{[^}]*order: -1;/);
  assert.match(landing, /<section class="quote" id="testimonials">[\s\S]*?<\/section>\s*<\/main>/);
  assert.doesNotMatch(landing, /class="cta"|\.cta-box|Bereit für euren Moment\?|Lasst eure Worte/);
  assert.match(landing, /\.homepage-mug-mockup \{ width: min\(380px, 100%\); aspect-ratio: 1;/);
  assert.match(landing, /class="homepage-mug-mockup"[\s\S]*?asset\('\/assets\/workflow\/05_01_' \+ locale \+ '\.png'\)/);
  assert.doesNotMatch(landing, /id="mug-canvas"|Zum Drehen ziehen|asset\('\/js\/mug-3d-viewer\.js'\)/);
  assert.match(landing, /#site-header:not\(\.landing-menu-open\) \.landing-section-links/);
  assert.doesNotMatch(landing, /#intro-overlay:not\(\.fade-out\) ~ #site-header \.landing-menu-toggle/);
  assert.doesNotMatch(siteHeader, /landing-menu-start/,
    'the persistent header CTA must not be duplicated inside the compact menu');
  assert.doesNotMatch(landing, /landing-menu-start/);
  assert.match(siteHeader, /for \(const link of navLinks\)/);
  assert.match(siteHeader, /data-i18n-source="<%= link\.label %>"/);
  assert.doesNotMatch(siteHeader, /href="#testimonials">Stimmen</);
  assert.match(landing, /@media \(max-width: 360px\)[\s\S]*?\.landing-start-button \{ display: none; \}/);
  assert.match(landing, /\.landing-menu-toggle \{ display: grid; margin-left: 0; \}/);
  assert.match(landing, /\.landing-start-button \{ min-height: var\(--ww-touch-target\); height: var\(--ww-touch-target\); \}/);
});

test('landing intro selects a portrait-optimized video and poster on phones', () => {
  assert.match(
    landing,
    /source src="<%= asset\('\/assets\/video\/teaser-mobile\.mp4'\) %>" type="video\/mp4" media="\(max-width: 760px\) and \(orientation: portrait\)"/
  );
  assert.match(
    landing,
    /source src="<%= asset\('\/assets\/video\/teaser\.mp4'\) %>" type="video\/mp4"/
  );
  assert.match(
    landing,
    /@media \(max-width: 760px\) and \(orientation: portrait\) \{[\s\S]*?teaser-poster-mobile\.jpg/
  );
  assert.doesNotMatch(landing, /poster="\/assets\/video\//);
});

test('mobile naming dialog is visual-viewport aware and does not force the keyboard open', () => {
  assert.match(landing, /class="start-dialog ww-mobile-dialog"/);
  assert.match(mobileStyles, /--ww-visual-viewport-height/);
  assert.match(mobileStyles, /--ww-keyboard-inset/);
  assert.match(mobileRuntime, /window\.visualViewport/);
  assert.match(mobileRuntime, /window\.innerHeight - height - offsetTop/);
  assert.match(landing, /window\.matchMedia\('\(pointer: fine\)'\)\.matches/);
  assert.doesNotMatch(landing, /\sautofocus(?:\s|>)/);
  assert.match(landing, /\.start-dialog-close \{[^}]*width: 44px; height: 44px/);
  assert.match(mobileStyles, /border-radius: 24px 24px 0 0/);
});

test('every rendered page uses the same safe-area and mobile viewport foundation', () => {
  for (const { file, source } of documentViews) {
    assert.match(source, /name="viewport" content="[^"]*viewport-fit=cover/, `${file} must opt into safe areas`);
    assert.match(source, /name="theme-color"/, `${file} must color the browser chrome`);
    assert.match(source, /\/mobile-foundation\.css/, `${file} must load the shared mobile CSS`);
    assert.match(source, /\/js\/mobile-ui\.js/, `${file} must load the visual viewport helper`);
  }
});

test('mobile foundation contains horizontal gestures and respects safe areas', () => {
  assert.match(mobileStyles, /overscroll-behavior-x: none/);
  assert.match(mobileStyles, /@supports \(overflow: clip\)/);
  assert.match(mobileStyles, /padding-left: max\(16px, var\(--ww-safe-left\)\)/);
  assert.match(mobileStyles, /padding-right: max\(16px, var\(--ww-safe-right\)\)/);
  assert.match(mobileStyles, /dialog\.ww-mobile-dialog[\s\S]*?--ww-visual-viewport-height/);
  assert.match(i18nStyles, /@media \(max-width: 620px\)[\s\S]*?\.ww-language-trigger \{ width: 112px/);
  assert.doesNotMatch(mobileStyles, /\.ww-language-inline \.ww-language-trigger|\.ww-language-current-name\s*\{\s*display:\s*none/);
  assert.match(configure, /\.mug-viewer \{[\s\S]*?touch-action: pan-y pinch-zoom;/);
  assert.match(configure, /\.mug-viewer \{[\s\S]*?-webkit-user-select: none;[\s\S]*?-webkit-touch-callout: none;/);
  assert.match(configure, /\.mug-interaction-region \{[\s\S]*?touch-action: none;[\s\S]*?-webkit-touch-callout: none;/);
  assert.match(configure, /\.mug-viewer\.is-flat \{[\s\S]*?touch-action: auto;/);
  assert.match(landing, /\.homepage-mug-mockup img \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?object-fit: contain;/);
  assert.doesNotMatch(landing, /\.homepage-mug-viewer|\.mug-interaction-region|#mug-canvas/);
});

test('mobile forms prevent iOS input zoom and expose full-size controls', () => {
  assert.match(display, /\.draft-settings input \{[^}]*font: 16px/);
  assert.match(display, /\.dialog-close \{ width: 44px; height: 44px/);
  assert.match(configure, /\.editor-text-input,[\s\S]*?\.editor-font-toggle \{ height: var\(--ww-touch-target\); font-size: 16px; \}/);
  assert.match(configure, /\.editor-font-size-input \{ height: var\(--ww-touch-target\); font-size: 16px; \}/);
  assert.match(configure, /\.custom-color-remove \{ width: var\(--ww-touch-target\); height: var\(--ww-touch-target\); \}/);
  assert.match(shipping, /\.search-input \{[^}]*height: 44px;[^}]*font-size: 16px/);
  assert.match(shipping, /\.search-option \{[^}]*min-height: 44px/);
  assert.match(shipping, /\.quantity-control \{[^}]*height: 46px/);
});

test('mobile legal copy and configurator controls reflow instead of widening the page', () => {
  assert.match(legalStyles, /h1 \{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?hyphens: auto;/);
  assert.match(legalStyles, /\.legal-section a \{[\s\S]*?overflow-wrap: anywhere/);
  assert.doesNotMatch(configure, /\.editor-selection:not\(\.is-active\)/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-properties \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(configure, /data-editor-tool=|id="editor-tool-panel"/);
  assert.match(configure, /\.page \{[\s\S]*?margin-left: max\(14px, var\(--ww-safe-left\)\);[\s\S]*?margin-right: max\(14px, var\(--ww-safe-right\)\)/);
});

test('compact configurator uses a dense two-column inspector at every compact width', () => {
  assert.match(configure, /\.editor-field-label-color \{ min-width: 197px;/);
  assert.match(configure, /\.editor-font-controls \{[\s\S]*?grid-template-columns: minmax\(125px, 1fr\) auto;/);
  assert.match(configure, /\.editor-selection-row \{[\s\S]*?minmax\(360px, \.95fr\)/);
  assert.match(configure, /\.editor-swatches \{[\s\S]*?min-width: 196px;[\s\S]*?max-width: 100%;[\s\S]*?flex: 0 1 auto;[\s\S]*?flex-wrap: wrap;/);
  assert.match(configure, /\.editor-swatch \{[\s\S]*?flex: 0 0 23px;/);
  assert.match(configure, /\.editor-color-input \{[\s\S]*?flex: 0 0 28px;/);
  assert.match(configure, /\.editor-properties \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(configure, /\.editor-selection-row \{[^}]*flex: 1 1 760px;[^}]*min-width: min\(100%, 760px\)/);
  assert.match(configure, /\.editor-actions \{[^}]*flex: 0 0 auto;[^}]*justify-content: flex-start;[^}]*flex-wrap: wrap;/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-selection-row \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-properties \{[\s\S]*?width: 100%;[\s\S]*?margin: 0;/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-format-controls \{[\s\S]*?width: min\(100%, 350px\);[\s\S]*?grid-template-columns: minmax\(88px, 96px\) minmax\(0, 1fr\)/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-colors \{[\s\S]*?width: 100%;/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-swatches \{[\s\S]*?width: 100%;[\s\S]*?display: flex;[\s\S]*?flex-wrap: wrap;/);
  assert.match(configure, /id="editor-swatches"[\s\S]*?id="editor-color"[\s\S]*?<\/div>/);
  assert.match(configure, /class="editor-nudge-controls"[\s\S]*?class="editor-transform-controls"/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-actions \{[\s\S]*?width: 100%;[\s\S]*?display: flex;[\s\S]*?flex-wrap: wrap;[\s\S]*?justify-content: flex-start;/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-actions \{[\s\S]*?--editor-compact-action-size: 44px;[\s\S]*?--editor-compact-action-gap: 6px;/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-actions \.editor-button\.editor-icon-button \{[\s\S]*?flex: 0 0 var\(--editor-compact-action-size\);[\s\S]*?min-width: var\(--editor-compact-action-size\);/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-nudge-controls \{[\s\S]*?flex: 0 0 auto;[\s\S]*?grid-template-columns: repeat\(4, var\(--editor-compact-action-size\)\);[\s\S]*?gap: var\(--editor-compact-action-gap\);/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-transform-controls \{[\s\S]*?flex: 0 0 var\(--editor-compact-transform-width\);[\s\S]*?max-width: 100%;[\s\S]*?display: flex;[\s\S]*?flex-wrap: wrap;[\s\S]*?gap: var\(--editor-compact-action-gap\);/);
  assert.match(workspaceStyles, /#editor-compact-inspector \.editor-style-button > \* \{[^}]*transform: translateY\(2px\)/);
  assert.match(workspaceStyles, /\.editor-selection-head \{[\s\S]*?clip: rect\(0 0 0 0\)/);
  assert.match(workspaceStyles, /\.workbench \.editor-card \{ position: relative; z-index: 2; \}/);
});

test('compact configurator widths keep product and palette beside each other', () => {
  assert.match(configure,
    /@media \(max-width: 940px\)[\s\S]*?\.design-toolbar-controls,[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(configure,
    /\.design-toolbar-controls > \.toolbar-product \{ grid-column: 1; grid-row: 1; \}[\s\S]*?\.design-toolbar-controls > #theme-step \{ grid-column: 2; grid-row: 1; \}/);
  assert.match(configure,
    /\.design-toolbar-controls > #orientation-step \{ grid-column: 1 \/ -1; grid-row: 2; \}/);
  assert.match(configure,
    /@media \(max-width: 620px\)[\s\S]*?\.selected-product \{[\s\S]*?min-height: 112px;[\s\S]*?grid-template-columns: 40px minmax\(0, 1fr\);/);
  assert.match(configure,
    /#theme-step \.toolbar-summary \{[\s\S]*?min-height: 112px;[\s\S]*?height: 100%;/);
});
