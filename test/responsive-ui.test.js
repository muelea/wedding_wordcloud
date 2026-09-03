'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const landing = fs.readFileSync(path.join(ROOT, 'views', 'landing.ejs'), 'utf8');
const display = fs.readFileSync(path.join(ROOT, 'views', 'display.ejs'), 'utf8');
const configure = fs.readFileSync(path.join(ROOT, 'views', 'configure.ejs'), 'utf8');
const shipping = fs.readFileSync(path.join(ROOT, 'views', 'shipping.ejs'), 'utf8');
const siteHeader = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'site-header.ejs'), 'utf8');
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

test('word cloud header keeps the keepsake action compact at mobile widths', () => {
  assert.match(siteHeader, /class="ww-display-header-actions"[\s\S]*?id="memory-cta"[\s\S]*?id="display-page-menu"/);
  assert.match(display, /\.ww-keepsake-cta \{[\s\S]*?height: 44px;[\s\S]*?min-width: 44px;/);
  assert.match(display, /@media \(max-width: 620px\)[\s\S]*?\.ww-keepsake-cta-label-full \{ display: none; \}[\s\S]*?\.ww-keepsake-cta-label-compact \{ display: inline; \}/);
  assert.match(display, /@media \(max-width: 360px\)[\s\S]*?\.ww-keepsake-cta \{ width: 44px; padding: 0; \}[\s\S]*?\.ww-keepsake-cta-label-compact \{ display: none; \}/);
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

test('landing page uses an accessible desktop scroll story with a static mobile sequence', () => {
  assert.match(landing, /html \{ max-width: 100%;[\s\S]*?overflow-x: clip; \}/);
  assert.match(landing, /asset\('\/landing-workflow\.css'\)/);
  assert.match(landing, /asset\('\/js\/landing-workflow\.js'\)/);
  assert.equal((landing.match(/data-workflow-trigger="/g) || []).length, 5);
  assert.equal((landing.match(/data-workflow-panel="/g) || []).length, 5);
  assert.equal((landing.match(/aria-hidden="false" data-workflow-panel=/g) || []).length, 5);
  assert.match(landing, /id="workflow-step-0"[^>]*aria-controls="workflow-panel-0"[^>]*aria-current="step"/);
  assert.match(landing, /id="workflow-panel-0"[^>]*aria-labelledby="workflow-step-0"[^>]*aria-hidden="false"/);
  assert.match(landingWorkflowStyles, /min-height: calc\(var\(--workflow-sticky-height\) \+ 200vh\)/);
  assert.match(landingWorkflowStyles, /html\.workflow-scroll-ready \.workflow-sticky \{[\s\S]*?position: sticky;/);
  assert.match(landingWorkflowStyles, /grid-template-columns: minmax\(340px, \.76fr\) minmax\(0, 1\.42fr\)/);
  assert.match(landingWorkflowStyles, /@media \(max-width: 1050px\)[\s\S]*?html\.workflow-scroll-ready \.workflow-stage \{[\s\S]*?display: none;/);
  assert.match(landingWorkflowStyles, /\.workflow-step > \.workflow-panel \{[\s\S]*?margin: 4px auto 34px;/);
  assert.match(landingWorkflowStyles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(landingWorkflowRuntime, /matchMedia\('\(min-width: 1051px\)'\)/);
  assert.match(landingWorkflowRuntime, /window\.requestAnimationFrame\(renderScrollProgress\)/);
  assert.match(landingWorkflowRuntime, /window\.addEventListener\('scroll', requestScrollUpdate, \{ passive: true \}\)/);
  assert.match(landingWorkflowRuntime, /var scrubDurationMs = 240/);
  assert.match(landingWorkflowRuntime, /var opacity = clamp\(reveal \* 1\.65\) \* clamp\(3\.15 - depth\)/);
  assert.match(landingWorkflowRuntime, /--workflow-panel-stack-y/);
  assert.match(landingWorkflowRuntime, /--workflow-panel-grayscale/);
  assert.doesNotMatch(landingWorkflowRuntime, /index < activeIndex \? 0/);
  assert.doesNotMatch(landingWorkflowRuntime, /--workflow-panel-saturation/);
  assert.doesNotMatch(landingWorkflowStyles, /box-shadow: 0 34px 80px/);
  assert.match(landingWorkflowStyles, /filter: brightness\(var\(--workflow-panel-brightness\)\) grayscale\(var\(--workflow-panel-grayscale\)\)/);
  assert.match(landingWorkflowRuntime, /steps\[index\]\.appendChild\(panel\)/);
  assert.match(landingWorkflowRuntime, /panel\.setAttribute\('aria-hidden', desktopLayout\.matches \? String\(!isActive\) : 'false'\)/);
  assert.match(landing, /#mug-canvas \{ width: min\(360px, 100%\); height: auto/);
  assert.match(landing, /#site-header:not\(\.landing-menu-open\) \.landing-section-links/);
  assert.doesNotMatch(landing, /#intro-overlay:not\(\.fade-out\) ~ #site-header \.landing-menu-toggle/);
  assert.match(siteHeader, /class="landing-menu-start"[^>]*data-open-start-dialog/);
  assert.match(siteHeader, /for \(const link of navLinks\)/);
  assert.match(siteHeader, /data-i18n-source="<%= link\.label %>"/);
  assert.doesNotMatch(siteHeader, /href="#testimonials">Stimmen</);
  assert.match(landing, /@media \(max-width: 360px\)[\s\S]*?\.landing-start-button \{ display: none; \}/);
  assert.match(landing, /\.landing-menu-toggle,[\s\S]*?\.landing-start-button \{ min-height: var\(--ww-touch-target\); height: var\(--ww-touch-target\); \}/);
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
});

test('mobile forms prevent iOS input zoom and expose full-size controls', () => {
  assert.match(display, /\.draft-settings input \{[^}]*font: 16px/);
  assert.match(display, /\.dialog-close \{ width: 44px; height: 44px/);
  assert.match(configure, /\.editor-text-input,[\s\S]*?\.editor-font-toggle \{ height: var\(--ww-touch-target\); font-size: 16px; \}/);
  assert.match(configure, /\.custom-color-remove \{ width: var\(--ww-touch-target\); height: var\(--ww-touch-target\); \}/);
  assert.match(shipping, /\.search-input \{[^}]*height: 44px;[^}]*font-size: 16px/);
  assert.match(shipping, /\.search-option \{[^}]*min-height: 44px/);
  assert.match(shipping, /\.quantity-control \{[^}]*height: 46px/);
});

test('mobile legal copy and configurator controls reflow instead of widening the page', () => {
  assert.match(legalStyles, /h1 \{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?hyphens: auto;/);
  assert.match(legalStyles, /\.legal-section a \{[\s\S]*?overflow-wrap: anywhere/);
  assert.doesNotMatch(configure, /\.editor-selection:not\(\.is-active\)/);
  assert.match(workspaceStyles, /\.editor-dock \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(configure, /\.page \{[\s\S]*?margin-left: max\(14px, var\(--ww-safe-left\)\);[\s\S]*?margin-right: max\(14px, var\(--ww-safe-right\)\)/);
});

test('compact configurator widths keep color controls horizontal and separate from actions', () => {
  assert.match(configure, /\.editor-field-label-color \{ min-width: 197px;/);
  assert.match(configure, /\.editor-swatches \{ min-width: 163px;[\s\S]*?flex-wrap: wrap;/);
  assert.match(configure, /\.editor-swatch \{[\s\S]*?flex: 0 0 23px;/);
  assert.match(configure, /\.editor-color-input \{[\s\S]*?flex: 0 0 28px;/);
  assert.match(configure, /@media \(max-width: 1180px\)[\s\S]*?\.editor-properties \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(workspaceStyles, /\.editor-tool-panel \.editor-actions \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
});
