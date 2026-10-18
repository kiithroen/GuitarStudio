'use strict';

const fs = require('node:fs');
const path = require('node:path');
const TabEngine = require('../src/tab-engine.js');
const LegacyMigration = require('../src/legacy-migration.js');

const args = process.argv.slice(2);
if (args.length !== 2) {
    process.stderr.write('Usage: node tools/convert-builtin-songs.js <legacy-structured.json> <notation-v3.json>\n');
  process.exitCode = 2;
} else {
  try {
    const inputPath = path.resolve(args[0]);
    const outputPath = path.resolve(args[1]);
    const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const isList = Array.isArray(source);
    const records = isList ? source : [source];
    const converted = records.map(function(record){ return LegacyMigration.convertSong(record, TabEngine); });
    fs.writeFileSync(outputPath, JSON.stringify(isList ? converted : converted[0], null, 2) + '\n', 'utf8');
    process.stdout.write('Converted ' + converted.length + ' structured record(s).\n');
  } catch (error){
    process.stderr.write('Conversion failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
