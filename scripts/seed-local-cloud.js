'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const I18n = require('../src/i18n');
const { getBaseUrl } = require('../src/baseUrl');
const { isLocalDatabaseUrl } = require('../src/dbConfig');
const { MAX_EVENT_NAME_LENGTH, normalizeEventName } = require('../src/eventNames');
const { normalizeWordInput } = require('../src/words');
const {
  MAX_EVENT_CONTRIBUTIONS,
  MAX_EVENT_UNIQUE_WORDS,
} = require('../public/js/cloud-limits');

const USAGE = 'Verwendung: npm run local:seed-cloud -- <datei.json>';

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label} enthält unbekannte Felder: ${unexpected.join(', ')}.`);
}

function parseArgs(argv = process.argv.slice(2)) {
  let filename = null;
  let help = false;
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument.startsWith('-')) {
      fail(`Unbekannte Option: ${argument}. ${USAGE}`);
    } else if (filename) {
      fail(`Es darf nur eine Seed-Datei angegeben werden. ${USAGE}`);
    } else {
      filename = argument;
    }
  }
  if (!help && !filename) fail(`Die Seed-Datei fehlt. ${USAGE}`);
  return { filename, help };
}

function parseSeedJson(contents, label = 'Seed-Datei') {
  try {
    return JSON.parse(String(contents).replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`${label} enthält kein gültiges JSON: ${error.message}`);
  }
}

function normalizeSeedDocument(document) {
  if (!isObject(document)) fail('Die Seed-Datei muss ein JSON-Objekt enthalten.');
  assertExactKeys(document, ['version', 'event', 'words'], 'Die Seed-Datei');
  if (document.version !== 1) fail('Die Seed-Datei benötigt "version": 1.');

  if (!isObject(document.event)) fail('"event" muss ein JSON-Objekt sein.');
  assertExactKeys(document.event, ['title', 'locale', 'pin'], '"event"');
  const title = normalizeEventName(document.event.title);
  if (!title || title.length > MAX_EVENT_NAME_LENGTH) {
    fail(`"event.title" muss 1–${MAX_EVENT_NAME_LENGTH} Zeichen lang sein.`);
  }
  if (!I18n.isSupportedLocale(document.event.locale)) {
    fail(`"event.locale" muss ${I18n.SUPPORTED_LOCALES.join(', ')} sein.`);
  }
  const locale = I18n.normalizeLocale(document.event.locale);
  if (typeof document.event.pin !== 'string' || !/^\d{4,6}$/.test(document.event.pin)) {
    fail('"event.pin" muss eine Zeichenkette aus 4–6 Ziffern sein.');
  }

  if (!Array.isArray(document.words) || !document.words.length) {
    fail('"words" muss mindestens einen Eintrag enthalten.');
  }
  if (document.words.length > MAX_EVENT_UNIQUE_WORDS) {
    fail(`"words" darf höchstens ${MAX_EVENT_UNIQUE_WORDS} Einträge enthalten.`);
  }

  const merged = new Map();
  let contributionCount = 0;
  document.words.forEach((entry, index) => {
    const label = `words[${index}]`;
    if (!isObject(entry)) fail(`${label} muss ein JSON-Objekt sein.`);
    assertExactKeys(entry, ['word', 'count'], label);
    const normalized = normalizeWordInput(entry.word, locale);
    if (!normalized.word) {
      const reason = normalized.error === 'unsupported_emoji'
        ? 'enthält ein nicht unterstütztes Emoji'
        : 'ist kein gültiges Wort';
      fail(`${label}.word ${reason}.`);
    }
    if (!Number.isSafeInteger(entry.count) || entry.count < 1) {
      fail(`${label}.count muss eine positive ganze Zahl sein.`);
    }
    contributionCount += entry.count;
    if (contributionCount > MAX_EVENT_CONTRIBUTIONS) {
      fail(`Die Seed-Datei darf insgesamt höchstens ${MAX_EVENT_CONTRIBUTIONS} Beiträge enthalten.`);
    }
    merged.set(normalized.word, (merged.get(normalized.word) || 0) + entry.count);
  });

  return {
    title,
    locale,
    pin: document.event.pin,
    words: Array.from(merged.entries()),
    inputWordCount: document.words.length,
    contributionCount,
  };
}

function assertLocalSeedSafety(env) {
  const appEnvironment = String(env.APP_ENVIRONMENT || '').trim().toLowerCase();
  const nodeEnvironment = String(env.NODE_ENV || '').trim().toLowerCase();
  if (appEnvironment !== 'local' || nodeEnvironment === 'production') {
    fail('Lokale Marketing-Seeds sind nur mit APP_ENVIRONMENT=local und außerhalb von NODE_ENV=production erlaubt.');
  }
  const databaseUrl = String(env.DATABASE_URL || '').trim();
  if (!databaseUrl) fail('DATABASE_URL fehlt; die Seed-Datei wurde nicht importiert.');
  const localDatabase = isLocalDatabaseUrl(databaseUrl);
  const remoteSeedsAllowed = String(env.ALLOW_REMOTE_MARKETING_SEEDS || 'false')
    .trim().toLowerCase() === 'true';
  if (!localDatabase && !remoteSeedsAllowed) {
    fail(
      'DATABASE_URL zeigt nicht auf localhost. Setze ALLOW_REMOTE_MARKETING_SEEDS=true in der lokalen .env, ' +
      'wenn dies ausdrücklich die vorgesehene entfernte Entwicklungsdatenbank ist.'
    );
  }
  return { localDatabase };
}

async function run({
  argv = process.argv.slice(2),
  env = process.env,
  readFile = fs.readFileSync,
  database,
  output = console.log,
  warning = console.warn,
} = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    output(USAGE);
    return null;
  }
  const safety = assertLocalSeedSafety(env);
  const filename = path.resolve(options.filename);
  let contents;
  try {
    contents = readFile(filename, 'utf8');
  } catch (error) {
    fail(`Seed-Datei konnte nicht gelesen werden: ${error.message}`);
  }
  const seed = normalizeSeedDocument(parseSeedJson(contents, filename));

  const db = database || require('../src/db');
  await db.assertDatabaseReady();
  if (!safety.localDatabase) {
    warning('[local] Achtung: Die Marketing-Cloud wird in einer entfernten Entwicklungsdatenbank angelegt.');
  }
  const event = await db.createSeededEvent(seed);
  const port = Number(env.PORT || 3000);
  const baseUrl = getBaseUrl(null, port);
  const mergedCount = seed.inputWordCount - seed.words.length;

  output('');
  output('[local] Marketing-Wortwolke erstellt:');
  output(`  ${baseUrl}/e/${event.slug}`);
  output(`  PIN: ${seed.pin}`);
  output(`  ${seed.words.length} Wörter, ${seed.contributionCount} simulierte Beiträge`);
  if (mergedCount) output(`  ${mergedCount} normalisierte Dopplung(en) wurden zusammengeführt.`);
  output('');
  return { event, seed, url: `${baseUrl}/e/${event.slug}` };
}

async function main() {
  const dotenv = require('dotenv').config({ path: path.join(ROOT, '.env') });
  if (dotenv.error) fail(`.env konnte nicht gelesen werden: ${dotenv.error.message}`);
  const db = require('../src/db');
  try {
    await run({ database: db });
  } finally {
    await db.closePool();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n[local] Fehler: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  USAGE,
  assertLocalSeedSafety,
  normalizeSeedDocument,
  parseArgs,
  parseSeedJson,
  run,
};
