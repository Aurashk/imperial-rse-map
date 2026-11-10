#!/usr/bin/env node
/**
 * Validates data/departments.json, data/activities.json and data/software.json using the same
 * rules the map applies in the browser (js/data.js).
 *
 * Usage:   node scripts/validate-data.mjs [--strict]
 * Exit code is 1 when any error is found, or when --strict is given and any
 * warning is found. Intended for CI, so broken data is never deployed.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validateData } from '../js/data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');

async function readJson(relativePath) {
  const fullPath = path.join(root, relativePath);
  try {
    return JSON.parse(await readFile(fullPath, 'utf8'));
  } catch (error) {
    console.error(`✗ ${relativePath}: ${error.message}`);
    process.exit(1);
  }
}

const departments = await readJson('data/departments.json');
const activities = await readJson('data/activities.json');
const software = await readJson('data/software.json');
const { errors, warnings } = validateData(departments, activities, software);

for (const warning of warnings) console.warn(`! ${warning}`);
for (const error of errors) console.error(`✗ ${error}`);

const mock = activities.activities.filter((item) => (item.source?.kind ?? 'mock') === 'mock').length;
console.log(
  `\n${departments.departments.length} departments, ${activities.activities.length} activities ` +
    `(${mock} mock), ${software.software.length} research software entries · ` +
    `${errors.length} error(s), ${warnings.length} warning(s).`,
);

process.exit(errors.length > 0 || (strict && warnings.length > 0) ? 1 : 0);
