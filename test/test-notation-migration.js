const assert = require('node:assert/strict');
const migration = require('../src/notation-migration.js');

const lyric = migration.convertLegacyScoreText('[C] C4 - - - | 너 / 나', 4);
assert.equal(lyric.errors.length, 0);
assert.equal(lyric.text, '[C] C4 - - - | "너 / 나"');

const urlLyric = migration.convertLegacyScoreText('[C] C4 - - - | https://example.com/a | x // y', 4);
assert.equal(urlLyric.errors.length, 0);
assert.equal(require('../src/notation.js').decodeMeasureLine(urlLyric.text).lyric, 'https://example.com/a | x // y');

const bars = migration.convertLegacyScoreText('[C] C4 - - - / [G] G3 - - -', 4);
assert.equal(bars.errors.length, 0);
assert.equal(bars.text, '[C] C4 - - - | ""\n[G] G3 - - - | ""');

const metadata = migration.convertLegacyScoreText('Song\t4\t90\tBadge\t[C] C4 - - - / [G] G3 - - -', 4);
assert.equal(metadata.title, 'Song');
assert.equal(metadata.tsv.split('\t').length, 5);
assert.equal(metadata.tsv.split('\t')[3], 'Badge');
assert.equal(metadata.tsv.split('\t')[4].includes('\n'), false);
assert.equal(metadata.tsv.split('\t')[4].includes(' // '), true);
assert.ok(migration.convertLegacyScoreText('Song\t5\tNaN\tBadge\t[C] C4 - - -', 4).errors.some(item => item.code === 'INVALID_METADATA_BEATS'));
assert.ok(migration.convertLegacyScoreText('Song\t4\tInfinity\tBadge\t[C] C4 - - -', 4).errors.some(item => item.code === 'INVALID_METADATA_BPM'));

const ambiguous = migration.convertLegacyScoreText('[C] C4 - - - | 너 / 나 / [G] G3 - - -', 4);
assert.ok(ambiguous.warnings.some(item => item.code === 'AMBIGUOUS_LEGACY_SLASH'));
assert.equal(ambiguous.text, '[C] C4 - - - | "너 / 나"\n[G] G3 - - - | ""');

process.stdout.write('notation migration checks passed\n');
