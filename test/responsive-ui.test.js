'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const landing = fs.readFileSync(path.join(ROOT, 'views', 'landing.ejs'), 'utf8');
const display = fs.readFileSync(path.join(ROOT, 'views', 'display.ejs'), 'utf8');
const database = fs.readFileSync(path.join(ROOT, 'src', 'db.js'), 'utf8');
const eventsRoute = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'events.js'), 'utf8');
const titleMigration = fs.readFileSync(path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260901000000_generalize_event_naming.sql'
), 'utf8');

test('event titles use the general title contract and a data-preserving migration', () => {
  assert.match(titleMigration, /alter table events rename column couple_name to title/i);
  assert.match(titleMigration, /alter table events rename column event_label to subtitle/i);
  assert.match(titleMigration, /alter table orders rename column event_label_snapshot to event_title_snapshot/i);
  assert.match(titleMigration, /app_schema_versions \(version\) values \(2\)/i);
  assert.doesNotMatch(database, /couple_name|coupleName|event_label|eventLabel/);
  assert.doesNotMatch(eventsRoute, /couple_name|coupleName|invalid_couple_name|event_label|eventLabel/);
  assert.match(eventsRoute, /title: event\.title/);
  assert.match(eventsRoute, /subtitle: event\.subtitle/);
  assert.match(eventsRoute, /error: 'invalid_title'/);
});

test('live word cloud uses a font-ready HiDPI backing canvas', () => {
  assert.match(display, /MAX_CANVAS_PIXEL_RATIO = 3/);
  assert.match(display, /window\.devicePixelRatio/);
  assert.match(display, /backingSide = Math\.max\(1, Math\.round\(side \* pixelRatio\)\)/);
  assert.match(display, /canvas\.style\.width = `\$\{side\}px`/);
  assert.match(display, /ctx\.setTransform\(drawingScale, 0, 0, drawingScale, 0, 0\)/);
  assert.match(display, /document\.fonts\?\.load/);
});

test('landing page reflows into bounded cards without hiding the opening menu', () => {
  assert.match(landing, /html \{ max-width: 100%;[\s\S]*?overflow-x: clip; \}/);
  assert.match(landing, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(landing, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(landing, /\.steps \{ grid-template-columns: minmax\(0, 1fr\); gap: 18px; \}/);
  assert.match(landing, /\.step \{ min-width: 0;[\s\S]*?border-radius: 18px;[\s\S]*?background: #fffefc/);
  assert.match(landing, /#mug-canvas \{ width: min\(360px, 100%\); height: auto/);
  assert.match(landing, /#site-header:not\(\.landing-menu-open\) \.landing-section-links/);
  assert.doesNotMatch(landing, /#intro-overlay:not\(\.fade-out\) ~ #site-header \.landing-menu-toggle/);
});

test('mobile naming dialog is visual-viewport aware and does not force the keyboard open', () => {
  assert.match(landing, /--start-dialog-visual-height/);
  assert.match(landing, /--start-dialog-keyboard-inset/);
  assert.match(landing, /window\.visualViewport/);
  assert.match(landing, /window\.matchMedia\('\(pointer: fine\)'\)\.matches/);
  assert.doesNotMatch(landing, /\sautofocus(?:\s|>)/);
  assert.match(landing, /border-radius: 24px 24px 0 0/);
});
