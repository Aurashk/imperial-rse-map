/**
 * Data loading, validation and date helpers for the Imperial RSE Map.
 *
 * This module has no DOM dependencies so that the same validation rules can
 * be run in the browser (to surface problems to whoever is viewing the map)
 * and in Node.js (scripts/validate-data.mjs, used in CI before deployment).
 */

/** Activity statuses understood by the map. Missing statuses become "unknown". */
export const STATUSES = Object.freeze(['active', 'planned', 'completed', 'unknown']);

/** Recognised values for an activity's source.kind. */
export const SOURCE_KINDS = Object.freeze(['public', 'mock', 'internal']);

/** Recognised values for an activity's optional source.confidence. */
export const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low']);

/** Month in which an Imperial academic year begins (1 = January). */
const ACADEMIC_YEAR_START_MONTH = 8;

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

/**
 * Fetches and parses the data files. departments.json and activities.json are
 * required; software.json is optional and yields an empty list when absent.
 *
 * @param {string} baseUrl Directory containing the data files.
 * @returns {Promise<{departments: object, activities: object, software: object}>}
 * @throws {Error} If a required file cannot be fetched, or any file is not valid JSON.
 */
export async function loadData(baseUrl = 'data/') {
  const fetchJson = async (name, { optional = false } = {}) => {
    const url = new URL(name, new URL(baseUrl, document.baseURI));
    const response = await fetch(url, { cache: 'no-cache' });
    if (optional && response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Could not load ${name} (HTTP ${response.status}).`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new Error(`${name} is not valid JSON: ${error.message}`);
    }
  };

  const [departments, activities, software] = await Promise.all([
    fetchJson('departments.json'),
    fetchJson('activities.json'),
    fetchJson('software.json', { optional: true }),
  ]);
  return { departments, activities, software: software ?? { software: [] } };
}

/**
 * Parses a "YYYY-MM" string.
 *
 * @param {string|undefined} value
 * @returns {{year: number, month: number}|null} Null when absent or malformed.
 */
export function parseMonth(value) {
  if (typeof value !== 'string') return null;
  const match = MONTH_PATTERN.exec(value);
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}

/**
 * Returns the calendar year in which the academic year containing the given
 * month began; for example August 2025 and July 2026 both give 2025.
 *
 * @param {{year: number, month: number}} parsed
 * @returns {number}
 */
export function academicYearOf(parsed) {
  return parsed.month >= ACADEMIC_YEAR_START_MONTH ? parsed.year : parsed.year - 1;
}

/**
 * Formats an academic start year in the conventional UK style, e.g. 2025 → "2025/26".
 *
 * @param {number} startYear
 * @returns {string}
 */
export function formatAcademicYear(startYear) {
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Lists every academic year an activity touches. Ongoing activities (no end
 * date) are treated as running up to the academic year containing `now`.
 * Undated activities return an empty list and so only appear under "All years".
 *
 * @param {object} activity
 * @param {Date} [now]
 * @returns {number[]} Academic start years, ascending.
 */
export function activityAcademicYears(activity, now = new Date()) {
  const start = parseMonth(activity.start);
  if (!start) return [];
  const end = parseMonth(activity.end) ?? { year: now.getFullYear(), month: now.getMonth() + 1 };
  const first = academicYearOf(start);
  // Planned work may start after "now"; never let the range run backwards.
  const last = Math.max(first, academicYearOf(end));
  const years = [];
  for (let year = first; year <= last; year += 1) years.push(year);
  return years;
}

/**
 * Formats an activity's date range for display, e.g. "Aug 2025 – Jul 2026".
 *
 * @param {object} activity
 * @returns {string|null} Null when the activity is undated.
 */
export function formatDateRange(activity) {
  const fmt = (value) => {
    const parsed = parseMonth(value);
    if (!parsed) return null;
    return new Date(Date.UTC(parsed.year, parsed.month - 1, 1)).toLocaleDateString('en-GB', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  };
  const start = fmt(activity.start);
  if (!start) return null;
  const end = fmt(activity.end);
  if (!end) return `${start} – ongoing`;
  return start === end ? start : `${start} – ${end}`;
}

/**
 * Returns a shallow copy of an activity with defaults applied, so the rest of
 * the application can rely on `status` and `source.kind` being present.
 *
 * @param {object} activity
 * @returns {object}
 */
export function normaliseActivity(activity) {
  return {
    ...activity,
    status: STATUSES.includes(activity.status) ? activity.status : 'unknown',
    source: { kind: 'mock', ...(activity.source ?? {}) },
  };
}

/**
 * Checks the data files for structural problems and broken cross-references.
 * Errors make the data unusable; warnings are shown but do not block rendering.
 *
 * @param {object} departmentsDoc Parsed departments.json.
 * @param {object} activitiesDoc Parsed activities.json.
 * @param {object} [softwareDoc] Parsed software.json (optional).
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateData(departmentsDoc, activitiesDoc, softwareDoc = { software: [] }) {
  const errors = [];
  const warnings = [];

  const requireArray = (doc, key, file) => {
    if (!Array.isArray(doc?.[key])) {
      errors.push(`${file}: "${key}" must be an array.`);
      return [];
    }
    return doc[key];
  };

  const checkIds = (items, label) => {
    const seen = new Set();
    for (const item of items) {
      if (typeof item?.id !== 'string' || !ID_PATTERN.test(item.id)) {
        errors.push(`${label}: invalid id ${JSON.stringify(item?.id)} (use lower-case letters, digits, "-" or "_").`);
        continue;
      }
      if (seen.has(item.id)) errors.push(`${label}: duplicate id "${item.id}".`);
      seen.add(item.id);
    }
    return seen;
  };

  const groups = requireArray(departmentsDoc, 'groups', 'departments.json');
  const departments = requireArray(departmentsDoc, 'departments', 'departments.json');
  const types = requireArray(activitiesDoc, 'offeringTypes', 'activities.json');
  const activities = requireArray(activitiesDoc, 'activities', 'activities.json');
  const services = Array.isArray(activitiesDoc?.services) ? activitiesDoc.services : [];

  const groupIds = checkIds(groups, 'groups');
  const departmentIds = checkIds(departments, 'departments');
  const typeIds = checkIds(types, 'offeringTypes');
  checkIds(activities, 'activities');
  checkIds(services, 'services');

  if (types.length > 16) {
    errors.push('offeringTypes: at most 16 types are supported by the pie-chart nodes.');
  }

  for (const dept of departments) {
    if (!dept?.name) errors.push(`department "${dept?.id}": missing "name".`);
    if (!groupIds.has(dept?.group)) {
      errors.push(`department "${dept?.id}": unknown group "${dept?.group}".`);
    }
    if (dept?.verify) warnings.push(`department "${dept.id}" is flagged for verification.`);
  }

  for (const service of services) {
    if (!typeIds.has(service?.type)) errors.push(`service "${service?.id}": unknown type "${service?.type}".`);
  }

  for (const activity of activities) {
    const where = `activity "${activity?.id}"`;
    if (!activity?.title) errors.push(`${where}: missing "title".`);
    if (!typeIds.has(activity?.type)) errors.push(`${where}: unknown type "${activity?.type}".`);

    if (!Array.isArray(activity?.departments) || activity.departments.length === 0) {
      errors.push(`${where}: "departments" must list at least one department id.`);
    } else {
      for (const deptId of activity.departments) {
        if (!departmentIds.has(deptId)) errors.push(`${where}: unknown department "${deptId}".`);
      }
    }

    for (const key of ['start', 'end']) {
      if (activity?.[key] !== undefined && !parseMonth(activity[key])) {
        errors.push(`${where}: "${key}" must be in YYYY-MM format.`);
      }
    }
    const start = parseMonth(activity?.start);
    const end = parseMonth(activity?.end);
    if (start && end && end.year * 12 + end.month < start.year * 12 + start.month) {
      errors.push(`${where}: "end" is before "start".`);
    }
    if (activity?.end && !activity?.start) warnings.push(`${where}: has an end date but no start date.`);

    if (activity?.status !== undefined && !STATUSES.includes(activity.status)) {
      errors.push(`${where}: unknown status "${activity.status}".`);
    }
    if (activity?.sessions !== undefined && !(Number.isInteger(activity.sessions) && activity.sessions >= 0)) {
      errors.push(`${where}: "sessions" must be a non-negative integer.`);
    }

    const source = activity?.source;
    if (!source) {
      warnings.push(`${where}: no "source" recorded; treated as mock data.`);
    } else {
      if (!SOURCE_KINDS.includes(source.kind)) errors.push(`${where}: unknown source.kind "${source.kind}".`);
      if (source.confidence !== undefined && !CONFIDENCE_LEVELS.includes(source.confidence)) {
        errors.push(`${where}: unknown source.confidence "${source.confidence}".`);
      }
      if (source.kind === 'public' && !source.ref) warnings.push(`${where}: public record has no "ref" link.`);
      if (source.confidence === 'low') warnings.push(`${where}: attribution is low-confidence and needs checking.`);
    }
  }

  const software = requireArray(softwareDoc, 'software', 'software.json');
  checkIds(software, 'software');
  let unattributed = 0;
  for (const item of software) {
    const where = `software "${item?.id}"`;
    if (!item?.name) errors.push(`${where}: missing "name".`);
    if (typeof item?.repo !== 'string' || !/^https?:\/\//.test(item.repo)) errors.push(`${where}: "repo" must be an http(s) URL.`);
    if (!Array.isArray(item?.departments)) {
      errors.push(`${where}: "departments" must be an array.`);
      continue;
    }
    for (const deptId of item.departments) {
      if (!departmentIds.has(deptId)) errors.push(`${where}: unknown department "${deptId}".`);
    }
    if (item.departments.length === 0 && !item.central) unattributed += 1;
  }
  if (unattributed > 0) {
    warnings.push(`${unattributed} research software ${unattributed === 1 ? 'entry is' : 'entries are'} not attributed to a department.`);
  }

  return { errors, warnings };
}
