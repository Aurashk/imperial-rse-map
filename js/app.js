/**
 * Imperial RSE Map – interactive network of College departments showing, in
 * one picture, what the central Research Software Engineering (RSE) team does
 * with each department and what research software the department produces
 * without RSE involvement.
 *
 * Encoding
 * --------
 * - Faculties are Cytoscape compound (parent) nodes; departments sit inside.
 * - Each department's fill is a pie chart of its engagements with the RSE
 *   team, one categorical colour per offering type; node size grows with the
 *   number of engagements. A hollow node has no engagement.
 * - Each department's ring is shaded on a separate neutral (graphite)
 *   gradient by the number of research software packages listed in the
 *   Imperial Research Software Directory that had no RSE involvement. No ring
 *   means none are listed.
 * - A hub node represents the RSE team, linked to every department it has
 *   engaged with; edge width reflects the number of engagements.
 * - Optionally, activities and software packages can be drawn as their own
 *   nodes linked to their departments, exposing cross-department work.
 *
 * The full graph is built once. Filters only update node data and CSS
 * classes, so the layout stays stable while the viewer explores; the layout
 * is re-run only when the set of drawn nodes changes (activity nodes toggled)
 * or when "Re-arrange" is pressed.
 */

import {
  activityAcademicYears,
  formatAcademicYear,
  formatDateRange,
  loadData,
  normaliseActivity,
  validateData,
} from './data.js';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

const HUB_ID = 'rse-hub';
// The hub sits in its own invisible container: fCoSE keeps compound nodes
// apart, which stops the hub landing inside a faculty.
const HUB_GROUP_ID = 'group:central';
const ACTIVITY_PREFIX = 'activity:';
const HUB_EDGE_PREFIX = 'hub-edge:';
const SOFTWARE_PREFIX = 'software:';
/** Number of steps on the research-software ring gradient. */
const RING_STEPS = 5;
const RING_WIDTH = 8;
const MIN_NODE_SIZE = 34;
const MAX_NODE_SIZE = 74;

const STATUS_LABELS = Object.freeze({
  active: 'Active',
  planned: 'Planned',
  completed: 'Completed',
  unknown: 'Status not recorded',
});

const SOURCE_LABELS = Object.freeze({
  public: 'Public source',
  mock: 'Mock data',
  internal: 'Internal record',
});

const THEME_STORAGE_KEY = 'imperial-rse-map:theme';

/* ------------------------------------------------------------------------ */
/* Application state                                                         */
/* ------------------------------------------------------------------------ */

/** Mutable view state. Data collections are filled once at start-up. */
const state = {
  groups: [],
  groupsById: new Map(),
  departments: [],
  departmentsById: new Map(),
  types: [],
  typesById: new Map(),
  services: [],
  activities: [],
  activitiesById: new Map(),
  software: [],
  softwareById: new Map(),
  softwareMeta: {},
  meta: {},
  validation: { errors: [], warnings: [] },

  filters: {
    types: new Set(),
    status: 'all',
    year: 'all',
    includeMock: true,
    query: '',
  },
  showActivities: false, // draw activities as their own nodes
  showSoftware: false, // draw research software packages as their own nodes
  view: 'graph',
  selection: null, // { kind: 'department' | 'activity' | 'software', id } or null
};

/** @type {import('cytoscape').Core | null} */
let cy = null;

const $ = (selector) => document.querySelector(selector);

/* ------------------------------------------------------------------------ */
/* Utilities                                                                 */
/* ------------------------------------------------------------------------ */

/** Escapes a value for safe interpolation into HTML. */
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Returns the URL only if it uses http(s); otherwise null. Guards against javascript: links in data. */
function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Reads a CSS custom property from the root element. */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Colour for an offering type, taken from the stylesheet so themes stay in one place. */
function typeColour(typeId) {
  return cssVar(`--type-${typeId}`) || cssVar('--ink-muted');
}

function pluralise(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Storage can be unavailable (private browsing, blocked cookies); the preference is simply not kept. */
  }
}

/* ------------------------------------------------------------------------ */
/* Filtering and aggregation                                                 */
/* ------------------------------------------------------------------------ */

/** Activities that pass every filter except the free-text search (which only dims, never hides). */
function filteredActivities() {
  const { types, status, year, includeMock } = state.filters;
  return state.activities.filter((activity) => {
    if (!types.has(activity.type)) return false;
    if (!includeMock && activity.source.kind === 'mock') return false;
    if (status !== 'all' && activity.status !== status) return false;
    if (year !== 'all' && !activity.academicYears.includes(Number(year))) return false;
    return true;
  });
}

/**
 * Aggregates visible activities per department.
 *
 * @param {object[]} activities
 * @returns {Map<string, {total: number, byType: Map<string, number>, activities: object[]}>}
 */
function aggregateByDepartment(activities) {
  const result = new Map(
    state.departments.map((dept) => [dept.id, { total: 0, byType: new Map(), activities: [] }]),
  );
  for (const activity of activities) {
    for (const deptId of activity.departments) {
      const entry = result.get(deptId);
      if (!entry) continue;
      entry.total += 1;
      entry.byType.set(activity.type, (entry.byType.get(activity.type) ?? 0) + 1);
      entry.activities.push(activity);
    }
  }
  return result;
}

/** True when the RSE team is recorded as having worked on the package. */
function hasRseInvolvement(item) {
  return item.rseInvolved === true;
}

/**
 * Research software attributed to each department.
 *
 * @returns {Map<string, {all: object[], independent: object[]}>} `independent`
 *   holds the packages with no recorded RSE involvement (the ring encoding).
 */
function softwareByDepartment() {
  const result = new Map(state.departments.map((dept) => [dept.id, { all: [], independent: [] }]));
  for (const item of state.software) {
    for (const deptId of item.departments) {
      const entry = result.get(deptId);
      if (!entry) continue;
      entry.all.push(item);
      if (!hasRseInvolvement(item)) entry.independent.push(item);
    }
  }
  return result;
}

/** Maps a package count onto a ring step (1 = fewest); 0 means no ring. */
function ringStep(count, max) {
  return count > 0 ? Math.max(1, Math.ceil((count / max) * RING_STEPS)) : 0;
}

function softwareMatchesQuery(item, query) {
  return matchesQuery(item.name, query)
    || matchesQuery(item.description, query)
    || matchesQuery(item.language, query)
    || matchesQuery(item.attribution?.group, query)
    || (item.topics ?? []).some((topic) => matchesQuery(topic, query));
}

function matchesQuery(text, query) {
  return String(text ?? '').toLowerCase().includes(query);
}

function activityMatchesQuery(activity, query) {
  return matchesQuery(activity.title, query) || matchesQuery(activity.summary, query);
}

function departmentMatchesQuery(dept, query, visibleActivities, software = []) {
  if (matchesQuery(dept.name, query) || matchesQuery(dept.shortName, query)) return true;
  if (matchesQuery(state.groupsById.get(dept.group)?.name, query)) return true;
  return visibleActivities.some((activity) => activityMatchesQuery(activity, query))
    || software.some((item) => softwareMatchesQuery(item, query));
}

/* ------------------------------------------------------------------------ */
/* Graph construction                                                        */
/* ------------------------------------------------------------------------ */

function buildElements() {
  const elements = [];

  elements.push({ group: 'nodes', data: { id: HUB_GROUP_ID, kind: 'hub-group' } });
  elements.push({
    group: 'nodes',
    data: { id: HUB_ID, parent: HUB_GROUP_ID, label: 'Central RSE team', kind: 'hub' },
  });

  for (const group of state.groups) {
    elements.push({
      group: 'nodes',
      data: { id: `group:${group.id}`, label: group.name, kind: 'group', groupId: group.id },
    });
  }

  for (const dept of state.departments) {
    const data = {
      id: dept.id,
      parent: `group:${dept.group}`,
      label: dept.shortName || dept.name,
      kind: 'department',
      total: 0,
      size: MIN_NODE_SIZE,
    };
    state.types.forEach((_, index) => {
      data[`pie${index + 1}`] = 0;
    });
    elements.push({ group: 'nodes', data });
    elements.push({
      group: 'edges',
      data: { id: `${HUB_EDGE_PREFIX}${dept.id}`, source: HUB_ID, target: dept.id, kind: 'hub-edge', weight: 0 },
    });
  }

  for (const activity of state.activities) {
    const nodeId = `${ACTIVITY_PREFIX}${activity.id}`;
    elements.push({
      group: 'nodes',
      data: { id: nodeId, label: activity.title, kind: 'activity', type: activity.type, activityId: activity.id },
      classes: 'activity hidden',
    });
    for (const deptId of activity.departments) {
      elements.push({
        group: 'edges',
        data: { id: `${nodeId}->${deptId}`, source: nodeId, target: deptId, kind: 'activity-edge', type: activity.type },
        classes: 'hidden',
      });
    }
  }

  for (const item of state.software) {
    const nodeId = `${SOFTWARE_PREFIX}${item.id}`;
    elements.push({
      group: 'nodes',
      data: { id: nodeId, label: item.name, kind: 'software', softwareId: item.id },
      classes: 'software hidden',
    });
    const targets = item.central ? [HUB_ID] : item.departments;
    for (const target of targets) {
      elements.push({
        group: 'edges',
        data: { id: `${nodeId}->${target}`, source: nodeId, target, kind: 'software-edge' },
        classes: 'hidden',
      });
    }
  }

  return elements;
}

/** Builds the Cytoscape stylesheet from the current theme's CSS tokens. */
function buildStyle() {
  const label = cssVar('--graph-label');
  const halo = cssVar('--graph-label-halo');
  const style = [
    {
      selector: 'node',
      style: {
        'font-family': cssVar('--font') || 'system-ui, sans-serif',
        'font-size': 12,
        color: label,
        'text-outline-color': halo,
        'text-outline-width': 2,
        'min-zoomed-font-size': 6,
      },
    },
    {
      selector: 'node[kind = "group"]',
      style: {
        shape: 'round-rectangle',
        label: 'data(label)',
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -4,
        'font-size': 15,
        'font-weight': 600,
        'background-color': cssVar('--graph-group-fill'),
        'background-opacity': 1,
        'border-color': cssVar('--graph-group-border'),
        'border-width': 1,
        padding: 18,
      },
    },
    {
      selector: 'node[kind = "hub-group"]',
      style: {
        'background-opacity': 0,
        'border-width': 0,
        padding: 24,
        events: 'no',
      },
    },
    {
      selector: 'node[kind = "department"]',
      style: {
        shape: 'ellipse',
        width: 'data(size)',
        height: 'data(size)',
        label: 'data(label)',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-wrap': 'wrap',
        'text-max-width': 96,
        'background-color': cssVar('--surface'),
        'border-color': cssVar('--graph-node-idle-border'),
        'border-width': 1,
        'border-style': 'dashed',
        'pie-size': '100%',
        // Only opacity animates: size changes must be immediate so the layout
        // measures the final node sizes when it fits the view.
        'transition-property': 'opacity',
        'transition-duration': 200,
      },
    },
    {
      // No RSE engagement: hollow node with a muted label.
      selector: 'node[kind = "department"].idle',
      style: { color: cssVar('--ink-muted') },
    },
    {
      // Engaged departments get a solid hairline so the pie reads as a disc.
      selector: 'node[kind = "department"].engaged',
      style: { 'border-style': 'solid', 'border-color': halo, 'border-width': 2 },
    },
    {
      selector: 'node[kind = "hub"]',
      style: {
        shape: 'round-hexagon',
        width: 84,
        height: 84,
        label: 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': 70,
        'font-size': 11,
        'font-weight': 700,
        color: cssVar('--surface'),
        'text-outline-width': 0,
        'background-color': cssVar('--graph-hub'),
        'border-color': halo,
        'border-width': 3,
      },
    },
    {
      selector: 'node.activity',
      style: {
        shape: 'round-diamond',
        width: 16,
        height: 16,
        label: 'data(label)',
        'font-size': 8,
        'text-valign': 'bottom',
        'text-margin-y': 2,
        'text-wrap': 'wrap',
        'text-max-width': 90,
        'border-color': halo,
        'border-width': 2,
      },
    },
    {
      selector: 'node.software',
      style: {
        shape: 'round-rectangle',
        width: 12,
        height: 12,
        label: 'data(label)',
        'font-size': 8,
        'text-valign': 'bottom',
        'text-margin-y': 2,
        'background-color': cssVar('--sw-3'),
        'border-color': halo,
        'border-width': 1.5,
      },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'line-color': cssVar('--graph-edge'),
        opacity: 0.7,
        width: 1,
      },
    },
    {
      selector: 'edge[kind = "hub-edge"]',
      style: {
        width: 'mapData(weight, 1, 8, 1, 6)',
        opacity: 0.55,
      },
    },
    {
      selector: 'edge[kind = "activity-edge"]',
      style: { width: 1.5, opacity: 0.8 },
    },
    {
      selector: 'edge[kind = "software-edge"]',
      style: { width: 1, opacity: 0.6, 'line-color': cssVar('--sw-2') },
    },
    {
      selector: '.hidden',
      style: { display: 'none' },
    },
    {
      selector: 'edge.ghost',
      style: { opacity: 0, events: 'no' },
    },
    {
      selector: '.dim',
      style: { opacity: 0.18 },
    },
    {
      selector: 'edge.highlight',
      style: { opacity: 1, 'line-color': cssVar('--focus'), 'z-index': 15 },
    },
  ];

  // One pie slice per offering type, in the fixed categorical order.
  const pieStyle = {};
  state.types.forEach((type, index) => {
    pieStyle[`pie-${index + 1}-background-color`] = typeColour(type.id);
    pieStyle[`pie-${index + 1}-background-size`] = `mapData(pie${index + 1}, 0, 100, 0, 100)`;
  });
  style.push({ selector: 'node[kind = "department"]', style: pieStyle });

  // Research-software ring: a neutral gradient kept apart from the offering hues.
  for (let step = 1; step <= RING_STEPS; step += 1) {
    style.push({
      selector: `node[kind = "department"].ring-${step}`,
      style: {
        'border-style': 'solid',
        'border-width': RING_WIDTH,
        'border-color': cssVar(`--sw-${step}`),
      },
    });
  }

  for (const type of state.types) {
    const colour = typeColour(type.id);
    style.push({ selector: `node.activity[type = "${type.id}"]`, style: { 'background-color': colour } });
    style.push({ selector: `edge[kind = "activity-edge"][type = "${type.id}"]`, style: { 'line-color': colour } });
  }

  // Selection is drawn as an outline beyond the ring so the ring stays readable.
  style.push({
    selector: 'node.selected',
    style: {
      'outline-color': cssVar('--focus'),
      'outline-width': 3,
      'outline-offset': 2,
      'z-index': 20,
    },
  });

  return style;
}

function createGraph() {
  /* global cytoscape, cytoscapeFcose */
  if (typeof window.cytoscapeFcose === 'function') {
    cytoscape.use(window.cytoscapeFcose);
  }

  cy = cytoscape({
    container: $('#graph'),
    elements: buildElements(),
    style: buildStyle(),
    minZoom: 0.2,
    maxZoom: 3,
    boxSelectionEnabled: false,
    autoungrabify: false,
  });

  bindGraphEvents();
}

/** Maximum extra layout attempts made when containers end up overlapping. */
const MAX_LAYOUT_RETRIES = 4;

/** True when any two faculty (or hub) containers overlap. */
function containersOverlap() {
  const boxes = cy.nodes('[kind = "group"], [kind = "hub-group"]').not('.hidden').map((node) => node.boundingBox());
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) return true;
    }
  }
  return false;
}

/**
 * Runs the force-directed layout on the nodes currently drawn. fCoSE is
 * stochastic and occasionally leaves containers overlapping, so the result
 * is checked and the layout re-run from a fresh random start if needed.
 */
function runLayout({ randomise = false, attempt = 0 } = {}) {
  if (!cy) return;
  const drawn = cy.elements().not('.hidden');
  const hasFcose = typeof window.cytoscapeFcose === 'function';
  const options = hasFcose
    ? {
        name: 'fcose',
        quality: 'proof',
        randomize: randomise,
        animate: !randomise,
        animationDuration: 600,
        fit: true,
        padding: 30,
        nodeDimensionsIncludeLabels: true,
        packComponents: true,
        nodeRepulsion: () => 9000,
        idealEdgeLength: (edge) => (edge.data('kind') === 'hub-edge' ? 160 : 70),
        edgeElasticity: (edge) => (edge.data('kind') === 'hub-edge' ? 0.08 : 0.3),
        nestingFactor: 0.15,
        gravity: 0.3,
        gravityCompound: 1.2,
        gravityRangeCompound: 1.4,
        numIter: 3000,
        tile: true,
        tilingPaddingVertical: 14,
        tilingPaddingHorizontal: 14,
      }
    : { name: 'cose', animate: false, fit: true, padding: 30, nodeDimensionsIncludeLabels: true };

  const layout = drawn.layout(options);
  layout.one('layoutstop', () => {
    if (attempt < MAX_LAYOUT_RETRIES && containersOverlap()) {
      runLayout({ randomise: true, attempt: attempt + 1 });
      return;
    }
    // Fit again from the settled positions: the layout's own fit can be computed
    // before compound containers have grown to their final size.
    cy.animate({ fit: { eles: cy.elements().not('.hidden'), padding: 40 }, duration: 250 });
  });
  layout.run();
}

/* ------------------------------------------------------------------------ */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------ */

/** Recomputes everything that depends on the filters and redraws it. */
function refresh({ relayout = false } = {}) {
  const visible = filteredActivities();
  const byDept = aggregateByDepartment(visible);
  const softwareByDept = softwareByDepartment();
  const query = state.filters.query.trim().toLowerCase();

  updateGraph(visible, byDept, softwareByDept, query, relayout);
  updateChipCounts();
  renderTable(byDept, softwareByDept, query);
  renderPanel(visible, byDept, softwareByDept);
  $('#provenance-summary').textContent = provenanceSummary();
}

/** Identifies which item nodes are drawn, so the layout re-runs only when that changes. */
function drawnItemsSignature() {
  return cy.nodes('.activity, .software').not('.hidden').map((node) => node.id()).join('|');
}

function nodeSize(count, max) {
  return count === 0 ? MIN_NODE_SIZE : MIN_NODE_SIZE + (MAX_NODE_SIZE - MIN_NODE_SIZE) * Math.sqrt(count / max);
}

/** Largest independent-software count of any department (at least 1). */
function maxIndependentSoftware(softwareByDept) {
  return Math.max(1, ...[...softwareByDept.values()].map((entry) => entry.independent.length));
}

function updateGraph(visible, byDept, softwareByDept, query, relayout) {
  if (!cy) return;
  const maxTotal = Math.max(1, ...[...byDept.values()].map((entry) => entry.total));
  const maxSoftware = maxIndependentSoftware(softwareByDept);
  const visibleIds = new Set(visible.map((activity) => activity.id));
  const before = drawnItemsSignature();

  cy.batch(() => {
    for (const dept of state.departments) {
      const entry = byDept.get(dept.id);
      const software = softwareByDept.get(dept.id);
      const node = cy.getElementById(dept.id);

      const data = { total: entry.total, size: nodeSize(entry.total, maxTotal) };
      state.types.forEach((type, index) => {
        const typeCount = entry.byType.get(type.id) ?? 0;
        data[`pie${index + 1}`] = entry.total === 0 ? 0 : (typeCount / entry.total) * 100;
      });
      node.data(data);
      node.toggleClass('idle', entry.total === 0);
      node.toggleClass('engaged', entry.total > 0);

      const step = ringStep(software.independent.length, maxSoftware);
      for (let i = 1; i <= RING_STEPS; i += 1) node.toggleClass(`ring-${i}`, step === i);

      const hubEdge = cy.getElementById(`${HUB_EDGE_PREFIX}${dept.id}`);
      hubEdge.data('weight', entry.total);
      // Hub edges always take part in the layout (keeping it stable as filters
      // change) but are only visible when they represent current RSE engagement.
      hubEdge.toggleClass('ghost', state.showActivities || entry.total === 0);

      const dim = query !== '' && !departmentMatchesQuery(dept, query, entry.activities, software.all);
      node.toggleClass('dim', dim);
    }

    cy.nodes('.activity').forEach((node) => {
      const activity = state.activitiesById.get(node.data('activityId'));
      const show = state.showActivities && visibleIds.has(activity.id);
      node.toggleClass('hidden', !show);
      node.connectedEdges().toggleClass('hidden', !show);
      node.toggleClass('dim', show && query !== '' && !activityMatchesQuery(activity, query));
    });

    cy.nodes('.software').forEach((node) => {
      const item = state.softwareById.get(node.data('softwareId'));
      const show = state.showSoftware && (item.central || item.departments.length > 0);
      node.toggleClass('hidden', !show);
      node.connectedEdges().toggleClass('hidden', !show);
      node.toggleClass('dim', show && query !== '' && !softwareMatchesQuery(item, query));
    });

    applySelectionClasses();
  });

  // Item nodes change what is drawn, so the layout must adapt to them.
  if (relayout || before !== drawnItemsSignature()) runLayout();
}

function applySelectionClasses() {
  cy.elements().removeClass('selected highlight');
  const node = selectedNode();
  if (!node || node.empty()) return;
  node.addClass('selected');
  node.connectedEdges().not('.hidden, .ghost').addClass('highlight');
}

function selectedNode() {
  if (!cy || !state.selection) return null;
  const { kind, id } = state.selection;
  if (kind === 'activity') return cy.getElementById(`${ACTIVITY_PREFIX}${id}`);
  if (kind === 'software') return cy.getElementById(`${SOFTWARE_PREFIX}${id}`);
  return cy.getElementById(id);
}

function updateChipCounts() {
  // Counts ignore the type filter itself so a switched-off chip still shows what it would add.
  const { types } = state.filters;
  state.filters.types = new Set(state.types.map((type) => type.id));
  const unfiltered = filteredActivities();
  state.filters.types = types;

  for (const type of state.types) {
    const chip = document.querySelector(`.chip[data-type="${type.id}"]`);
    if (!chip) continue;
    const count = unfiltered.filter((activity) => activity.type === type.id).length;
    chip.querySelector('.count').textContent = count;
    chip.querySelector('.swatch').style.background = typeColour(type.id);
  }

  // Ring legend swatches follow the theme too.
  document.querySelectorAll('#ring-legend [data-step]').forEach((swatch) => {
    swatch.style.borderColor = cssVar(`--sw-${swatch.dataset.step}`);
  });
}

function provenanceSummary() {
  const counts = { public: 0, mock: 0, internal: 0 };
  for (const activity of state.activities) counts[activity.source.kind] = (counts[activity.source.kind] ?? 0) + 1;
  const parts = [`${counts.public} from public sources`, `${counts.mock} mock`];
  if (counts.internal) parts.push(`${counts.internal} internal`);
  const reviewed = state.meta.lastReviewed ? ` · data last reviewed ${state.meta.lastReviewed}` : '';
  const software = state.software.length ? ` · ${state.software.length} research software entries from the Imperial Research Software Directory` : '';
  return `${state.activities.length} activities: ${parts.join(', ')}${software}${reviewed}.`;
}

/* ----- Side panel ----- */

function renderPanel(visible, byDept, softwareByDept) {
  const panel = $('#panel');
  const selection = state.selection;
  if (selection?.kind === 'department' && state.departmentsById.has(selection.id)) {
    panel.innerHTML = departmentPanel(state.departmentsById.get(selection.id), byDept.get(selection.id), softwareByDept.get(selection.id));
  } else if (selection?.kind === 'activity' && state.activitiesById.has(selection.id)) {
    panel.innerHTML = activityPanel(state.activitiesById.get(selection.id), visible);
  } else if (selection?.kind === 'software' && state.softwareById.has(selection.id)) {
    panel.innerHTML = softwarePanel(state.softwareById.get(selection.id));
  } else {
    panel.innerHTML = overviewPanel(visible, byDept, softwareByDept);
  }
}

function softwareTags(item) {
  const tags = [];
  if (item.language) tags.push(`<span class="tag">${esc(item.language)}</span>`);
  if (Number.isInteger(item.stars)) tags.push(`<span class="tag">★ ${item.stars}</span>`);
  if (item.archived) tags.push('<span class="tag">Archived</span>');
  else if (item.inactive) tags.push('<span class="tag">No commits in 12 months</span>');
  if (item.featuredMonth) tags.push(`<span class="tag public">Software of the month ${esc(item.featuredMonth)}</span>`);
  if (hasRseInvolvement(item)) tags.push('<span class="tag public">RSE team involved</span>');
  if (item.attribution?.confidence) tags.push(`<span class="tag">${esc(item.attribution.confidence)}-confidence attribution</span>`);
  return tags.join('');
}

function softwareListItem(item) {
  return `
    <li class="item">
      <div class="item-title">
        <span class="swatch" style="background:${esc(cssVar('--sw-3'))};border-radius:2px" aria-hidden="true"></span>
        <button type="button" data-select-software="${esc(item.id)}">${esc(item.name)}</button>
      </div>
      ${item.description ? `<p class="item-body">${esc(item.description)}</p>` : ''}
      <div class="tags">${softwareTags(item)}</div>
    </li>`;
}

/** Counts items per key and returns the most common, largest first. */
function topCounts(values, limit) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);
}

function departmentLinkRow(dept, detail) {
  return `<li class="item"><button type="button" class="dept-link" data-select-department="${esc(dept.id)}">${esc(dept.name)}</button> <span class="meta">· ${detail}</span></li>`;
}

/** Overview section summarising research software alongside RSE engagement. */
function softwareOverviewSection(byDept, softwareByDept) {
  if (state.software.length === 0) return '';
  const attributed = state.software.filter((item) => item.departments.length > 0);
  const central = state.software.filter((item) => item.central);
  const unattributed = state.software.filter((item) => item.departments.length === 0 && !item.central);
  const independent = state.software.filter((item) => !hasRseInvolvement(item)).length;
  const active = state.software.filter((item) => item.inactive === false && !item.archived).length;
  const source = safeUrl(state.softwareMeta.source);

  // Departments producing software the RSE team has not engaged with yet:
  // the most direct outreach opportunities.
  const opportunities = state.departments
    .map((dept) => ({ dept, count: softwareByDept.get(dept.id).independent.length, rse: byDept.get(dept.id).total }))
    .filter((row) => row.count > 0 && row.rse === 0)
    .sort((a, b) => b.count - a.count || a.dept.name.localeCompare(b.dept.name));

  const top = state.departments
    .map((dept) => ({ dept, count: softwareByDept.get(dept.id).independent.length }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.dept.name.localeCompare(b.dept.name))
    .slice(0, 6);

  const languages = topCounts(state.software.map((item) => item.language), 8);

  return `
    <h3>Research software without RSE involvement</h3>
    <p class="meta">Shown as the grey ring around each department. From the ${source ? `<a href="${esc(source)}" target="_blank" rel="noopener">Imperial Research Software Directory</a>` : 'Imperial Research Software Directory'}${state.softwareMeta.generated ? `, imported ${esc(state.softwareMeta.generated)}` : ''}; departments are inferred from the owning GitHub account or group.</p>
    <div class="stats">
      <div class="stat"><span class="value">${independent}</span><span class="label">Packages</span></div>
      <div class="stat"><span class="value">${active}</span><span class="label">Active in last year</span></div>
      <div class="stat"><span class="value">${opportunities.length}</span><span class="label">Depts with no RSE link</span></div>
    </div>
    ${opportunities.length ? `<h3>Software but no RSE engagement</h3><ul class="item-list">${opportunities.map((row) => departmentLinkRow(row.dept, pluralise(row.count, 'package'))).join('')}</ul>` : ''}
    <h3>Most software</h3>
    <ul class="item-list">${top.map((row) => departmentLinkRow(row.dept, pluralise(row.count, 'package'))).join('')}</ul>
    <h3>Languages</h3>
    <div class="tags" style="margin-left:0">${languages.map(([language, count]) => `<span class="tag">${esc(language)} · ${count}</span>`).join('')}</div>
    ${central.length ? `<h3>Owned by Research Computing</h3><ul class="item-list">${central.map(softwareListItem).join('')}</ul>` : ''}
    ${unattributed.length ? `<h3>Not yet attributed</h3><ul class="item-list">${unattributed.map(softwareListItem).join('')}</ul>` : ''}
    <p class="meta">${attributed.length} of ${state.software.length} entries are attributed to a department.</p>`;
}

function softwarePanel(item) {
  const repo = safeUrl(item.repo);
  const homepage = safeUrl(item.homepage);
  const doi = item.doi ? safeUrl(`https://doi.org/${item.doi}`) : null;
  const departments = item.departments
    .map((id) => state.departmentsById.get(id))
    .filter(Boolean)
    .map((dept) => `<li class="item"><button type="button" class="dept-link" data-select-department="${esc(dept.id)}">${esc(dept.name)}</button></li>`)
    .join('');

  return `
    <button type="button" class="btn back" data-clear-selection>← Overview</button>
    <h2>${esc(item.name)}</h2>
    <p class="meta">${esc(item.owner)}${item.lastPush ? ` · last commit ${esc(item.lastPush)}` : ''}</p>
    <div class="tags" style="margin-left:0">${softwareTags(item)}</div>
    ${item.description ? `<p>${esc(item.description)}</p>` : ''}
    ${item.metadataAvailable ? '' : '<p class="notice">GitHub metadata was unavailable; the repository may have been renamed or moved.</p>'}
    ${(item.topics ?? []).length ? `<div class="tags" style="margin-left:0">${item.topics.map((topic) => `<span class="tag">${esc(topic)}</span>`).join('')}</div>` : ''}
    <p>
      ${repo ? `<a href="${esc(repo)}" target="_blank" rel="noopener">Repository</a>` : ''}
      ${homepage ? ` · <a href="${esc(homepage)}" target="_blank" rel="noopener">Website</a>` : ''}
      ${doi ? ` · <a href="${esc(doi)}" target="_blank" rel="noopener">DOI</a>` : ''}
    </p>
    <h3>Attribution</h3>
    ${item.central ? '<p>Owned by the central Research Computing Service / RSE team.</p>' : ''}
    ${departments ? `<ul class="item-list">${departments}</ul>` : ''}
    ${!item.central && !departments ? '<p class="meta">Not yet attributed to a department.</p>' : ''}
    ${item.attribution?.group ? `<p class="meta">Based on: ${esc(item.attribution.group)}${item.attribution.confidence ? ` (${esc(item.attribution.confidence)} confidence)` : ''}</p>` : ''}
    <div class="tags" style="margin-left:0"><span class="tag public">Public source</span></div>`;
}

function typeSwatch(typeId) {
  return `<span class="swatch" style="background:${esc(typeColour(typeId))}" aria-hidden="true"></span>`;
}

function sourceTag(source) {
  const kind = source?.kind ?? 'mock';
  const confidence = source?.confidence ? ` · ${esc(source.confidence)} confidence` : '';
  return `<span class="tag ${esc(kind)}">${esc(SOURCE_LABELS[kind] ?? kind)}${confidence}</span>`;
}

function activityListItem(activity) {
  const type = state.typesById.get(activity.type);
  const dates = formatDateRange(activity);
  const sessions = Number.isInteger(activity.sessions) ? `<span class="tag">${pluralise(activity.sessions, 'session')}</span>` : '';
  return `
    <li class="item">
      <div class="item-title">
        ${typeSwatch(activity.type)}
        <button type="button" data-select-activity="${esc(activity.id)}">${esc(activity.title)}</button>
      </div>
      ${activity.summary ? `<p class="item-body">${esc(activity.summary)}</p>` : ''}
      <div class="tags">
        <span class="tag">${esc(type?.label ?? activity.type)}</span>
        <span class="tag">${esc(STATUS_LABELS[activity.status])}</span>
        ${dates ? `<span class="tag">${esc(dates)}</span>` : ''}
        ${sessions}
        ${sourceTag(activity.source)}
      </div>
    </li>`;
}

function overviewPanel(visible, byDept, softwareByDept) {
  const engaged = [...byDept.values()].filter((entry) => entry.total > 0).length;
  const sessions = visible
    .filter((activity) => activity.type === 'code_surgery' && Number.isInteger(activity.sessions))
    .reduce((sum, activity) => sum + activity.sessions, 0);

  const top = state.departments
    .map((dept) => ({ dept, total: byDept.get(dept.id).total }))
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total || a.dept.name.localeCompare(b.dept.name))
    .slice(0, 6);

  const services = state.services
    .map((service) => {
      const url = safeUrl(service.url);
      const name = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(service.name)}</a>` : esc(service.name);
      return `
        <li class="item">
          <div class="item-title">${typeSwatch(service.type)}<span>${name}</span></div>
          <p class="item-body">${esc(service.description)}</p>
          <div class="tags">${sourceTag(service.source)}</div>
        </li>`;
    })
    .join('');

  const team = state.meta.team ?? {};
  const teamUrl = safeUrl(team.url);
  const mockCount = state.activities.filter((activity) => activity.source.kind === 'mock').length;
  const { errors, warnings } = state.validation;

  return `
    <h2>${esc(team.name ?? 'Central RSE team')}</h2>
    <p class="meta">${esc(team.parent ?? '')}${teamUrl ? ` · <a href="${esc(teamUrl)}" target="_blank" rel="noopener">Team page</a>` : ''}</p>
    ${mockCount ? `<p class="notice">${pluralise(mockCount, 'activity is', 'activities are')} placeholder mock data, shown with a <span class="tag mock">Mock data</span> badge. Untick “Include mock data” to see only sourced records.</p>` : ''}
    <div class="stats">
      <div class="stat"><span class="value">${visible.length}</span><span class="label">Activities shown</span></div>
      <div class="stat"><span class="value">${engaged}<small>/${state.departments.length}</small></span><span class="label">Departments engaged</span></div>
      <div class="stat"><span class="value">${sessions}</span><span class="label">Surgery sessions</span></div>
    </div>
    <h3>Most engaged</h3>
    ${top.length
      ? `<ul class="item-list">${top
          .map((row) => departmentLinkRow(row.dept, pluralise(row.total, 'activity', 'activities')))
          .join('')}</ul>`
      : '<p class="meta">No activities match the current filters.</p>'}
    ${softwareOverviewSection(byDept, softwareByDept)}
    <h3>Services offered</h3>
    <ul class="item-list">${services}</ul>
    ${errors.length || warnings.length
      ? `<h3>Data checks</h3><ul class="item-list">${[...errors.map((e) => `<li class="item">Error: ${esc(e)}</li>`), ...warnings.map((w) => `<li class="item meta">${esc(w)}</li>`)].join('')}</ul>`
      : ''}
    <p class="meta">Select a department, activity or package on the map for details.</p>`;
}

function departmentPanel(dept, entry, software = { all: [], independent: [] }) {
  const group = state.groupsById.get(dept.group);
  const url = safeUrl(dept.url);
  const all = state.activities.filter((activity) => activity.departments.includes(dept.id));
  const hidden = all.length - entry.total;

  const breakdown = state.types
    .map((type) => ({ type, count: entry.byType.get(type.id) ?? 0 }))
    .filter((row) => row.count > 0)
    .map((row) => `<li class="item"><div class="item-title">${typeSwatch(row.type.id)}<span>${esc(row.type.label)}: ${row.count}</span></div></li>`)
    .join('');

  const items = [...entry.activities]
    .sort((a, b) => String(b.start ?? '').localeCompare(String(a.start ?? '')))
    .map(activityListItem)
    .join('');

  const involved = software.all.length - software.independent.length;
  const softwareSection = `
    <h3>Research software (${software.all.length})</h3>
    ${software.all.length
      ? `<p class="meta">From the Imperial Research Software Directory. ${pluralise(software.independent.length, 'package has', 'packages have')} no recorded RSE involvement${involved ? `; ${involved} involved the RSE team` : ''}.</p><ul class="item-list">${[...software.all]
          .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name))
          .map(softwareListItem)
          .join('')}</ul>`
      : '<p class="meta">No software from this department is listed in the Imperial Research Software Directory yet.</p>'}`;

  return `
    <button type="button" class="btn back" data-clear-selection>← Overview</button>
    <h2>${esc(dept.name)}</h2>
    <p class="meta">${esc(group?.name ?? '')}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">Department website</a>` : ''}</p>
    ${dept.verify ? '<p class="notice">This department’s name or placement is flagged for verification.</p>' : ''}
    <h3>RSE team engagement</h3>
    <div class="stats">
      <div class="stat"><span class="value">${entry.total}</span><span class="label">Shown</span></div>
      <div class="stat"><span class="value">${all.length}</span><span class="label">All time</span></div>
      <div class="stat"><span class="value">${entry.byType.size}</span><span class="label">Offering types</span></div>
    </div>
    ${breakdown ? `<h3>By offering</h3><ul class="item-list">${breakdown}</ul>` : ''}
    <h3>Activities</h3>
    ${items ? `<ul class="item-list">${items}</ul>` : '<p class="meta">No RSE activity recorded for the current filters.</p>'}
    ${hidden > 0 ? `<p class="meta">${pluralise(hidden, 'further activity is', 'further activities are')} hidden by the current filters.</p>` : ''}
    ${softwareSection}`;
}

function activityPanel(activity, visible) {
  const type = state.typesById.get(activity.type);
  const dates = formatDateRange(activity);
  const url = safeUrl(activity.url);
  const ref = safeUrl(activity.source.ref);
  const isVisible = visible.some((item) => item.id === activity.id);

  const departments = activity.departments
    .map((id) => state.departmentsById.get(id))
    .filter(Boolean)
    .map((dept) => `<li class="item"><button type="button" class="dept-link" data-select-department="${esc(dept.id)}">${esc(dept.name)}</button> <span class="meta">· ${esc(state.groupsById.get(dept.group)?.shortName ?? '')}</span></li>`)
    .join('');

  return `
    <button type="button" class="btn back" data-clear-selection>← Overview</button>
    <h2>${esc(activity.title)}</h2>
    <div class="tags" style="margin-left:0">
      <span class="tag">${typeSwatch(activity.type)} ${esc(type?.label ?? activity.type)}</span>
      <span class="tag">${esc(STATUS_LABELS[activity.status])}</span>
      ${dates ? `<span class="tag">${esc(dates)}</span>` : ''}
      ${Number.isInteger(activity.sessions) ? `<span class="tag">${pluralise(activity.sessions, 'session')}</span>` : ''}
    </div>
    ${isVisible ? '' : '<p class="notice">This activity is hidden by the current filters.</p>'}
    ${activity.summary ? `<p>${esc(activity.summary)}</p>` : ''}
    ${url ? `<p><a href="${esc(url)}" target="_blank" rel="noopener">Project link</a></p>` : ''}
    <h3>Departments</h3>
    <ul class="item-list">${departments}</ul>
    <h3>Provenance</h3>
    <div class="tags" style="margin-left:0">${sourceTag(activity.source)}</div>
    ${activity.source.note ? `<p class="meta">${esc(activity.source.note)}</p>` : ''}
    ${ref ? `<p class="meta"><a href="${esc(ref)}" target="_blank" rel="noopener">Source</a></p>` : ''}`;
}

/* ----- Table view (accessible alternative to the graph) ----- */

function renderTable(byDept, softwareByDept, query) {
  const container = $('#table-view');
  if (state.view !== 'table') return;

  const header = state.types.map((type) => `<th scope="col">${typeSwatch(type.id)} ${esc(type.label)}</th>`).join('');
  const totals = new Map(state.types.map((type) => [type.id, 0]));
  let grandTotal = 0;
  let softwareTotal = 0;

  const rows = state.groups
    .flatMap((group) => state.departments.filter((dept) => dept.group === group.id))
    .filter((dept) => query === '' || departmentMatchesQuery(dept, query, byDept.get(dept.id).activities, softwareByDept.get(dept.id).all))
    .map((dept) => {
      const entry = byDept.get(dept.id);
      const softwareCount = softwareByDept.get(dept.id).independent.length;
      grandTotal += entry.total;
      softwareTotal += softwareCount;
      const cells = state.types
        .map((type) => {
          const count = entry.byType.get(type.id) ?? 0;
          totals.set(type.id, totals.get(type.id) + count);
          return `<td class="${count === 0 ? 'zero' : ''}">${count}</td>`;
        })
        .join('');
      return `<tr data-select-department="${esc(dept.id)}" tabindex="0">
        <td>${esc(dept.name)}</td>
        <td>${esc(state.groupsById.get(dept.group)?.shortName ?? '')}</td>
        ${cells}
        <td class="${entry.total === 0 ? 'zero' : ''}"><strong>${entry.total}</strong></td>
        <td class="${softwareCount === 0 ? 'zero' : ''}">${softwareCount}</td>
      </tr>`;
    })
    .join('');

  const footer = state.types.map((type) => `<td><strong>${totals.get(type.id)}</strong></td>`).join('');

  container.innerHTML = `
    <table>
      <caption class="meta" style="text-align:left;padding-bottom:6px">RSE activities per department for the current filters (an activity involving several departments is counted once for each), and research software listed in the Imperial Research Software Directory with no recorded RSE involvement.</caption>
      <thead><tr><th scope="col">Department</th><th scope="col">Faculty</th>${header}<th scope="col">RSE total</th><th scope="col">Software without RSE</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td><strong>Total</strong></td><td></td>${footer}<td><strong>${grandTotal}</strong></td><td><strong>${softwareTotal}</strong></td></tr></tfoot>
    </table>`;
}

/* ------------------------------------------------------------------------ */
/* Interaction                                                               */
/* ------------------------------------------------------------------------ */

function select(selection, { updateHash = true, focusGraph = true } = {}) {
  state.selection = selection;
  if (updateHash) {
    const hash = selection ? `#${selection.kind}=${encodeURIComponent(selection.id)}` : '';
    if (window.location.hash !== hash) {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
  }
  refresh();
  if (focusGraph && cy && state.view === 'graph') {
    const node = selectedNode();
    if (node && node.nonempty() && !node.hasClass('hidden')) {
      cy.animate({ center: { eles: node }, duration: 300 });
    }
  }
}

function selectionFromHash() {
  const match = /^#(department|activity|software)=(.+)$/.exec(window.location.hash);
  if (!match) return null;
  const id = decodeURIComponent(match[2]);
  const lookup = { department: state.departmentsById, activity: state.activitiesById, software: state.softwareById }[match[1]];
  return lookup.has(id) ? { kind: match[1], id } : null;
}

function bindGraphEvents() {
  const tooltip = $('#tooltip');

  cy.on('tap', 'node', (event) => {
    const data = event.target.data();
    if (data.kind === 'department') select({ kind: 'department', id: data.id });
    else if (data.kind === 'activity') select({ kind: 'activity', id: data.activityId });
    else if (data.kind === 'software') select({ kind: 'software', id: data.softwareId });
    else if (data.kind === 'hub') select(null);
  });

  cy.on('tap', (event) => {
    if (event.target === cy) select(null, { focusGraph: false });
  });

  cy.on('mouseover', 'node', (event) => {
    const html = tooltipHtml(event.target.data());
    if (!html) return;
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    positionTooltip(event.renderedPosition);
  });
  cy.on('mousemove', 'node', (event) => positionTooltip(event.renderedPosition));
  cy.on('mouseout', 'node', () => {
    tooltip.hidden = true;
  });
  cy.on('viewport', () => {
    tooltip.hidden = true;
  });
}

function positionTooltip(position) {
  const tooltip = $('#tooltip');
  if (tooltip.hidden || !position) return;
  const stage = $('.stage').getBoundingClientRect();
  const offset = 14;
  let left = position.x + offset;
  let top = position.y + offset;
  // Keep the tooltip inside the stage.
  if (left + tooltip.offsetWidth > stage.width - 8) left = position.x - tooltip.offsetWidth - offset;
  if (top + tooltip.offsetHeight > stage.height - 8) top = position.y - tooltip.offsetHeight - offset;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function tooltipHtml(data) {
  if (data.kind === 'software') {
    const item = state.softwareById.get(data.softwareId);
    return `<strong>${esc(item.name)}</strong>${item.description ? esc(item.description.slice(0, 140)) : ''}`;
  }
  if (data.kind === 'department') {
    const dept = state.departmentsById.get(data.id);
    const entry = aggregateByDepartment(filteredActivities()).get(data.id);
    const rows = state.types
      .map((type) => ({ type, count: entry.byType.get(type.id) ?? 0 }))
      .filter((row) => row.count > 0)
      .map((row) => `<li>${typeSwatch(row.type.id)}${esc(row.type.label)}: <strong>${row.count}</strong></li>`)
      .join('');
    const software = softwareByDepartment().get(data.id).independent;
    const softwareRow = `<li><span class="swatch ring" style="border-color:${esc(cssVar('--sw-3'))}" aria-hidden="true"></span>Software without RSE: <strong>${software.length}</strong></li>`;
    return `<strong>${esc(dept.name)}</strong><ul>${rows || '<li class="meta">No RSE activity for current filters</li>'}${softwareRow}</ul>`;
  }
  if (data.kind === 'activity') {
    const activity = state.activitiesById.get(data.activityId);
    const type = state.typesById.get(activity.type);
    return `<strong>${esc(activity.title)}</strong><ul><li>${typeSwatch(activity.type)}${esc(type?.label ?? '')} · ${esc(STATUS_LABELS[activity.status])}</li></ul>`;
  }
  if (data.kind === 'hub') {
    return `<strong>${esc(state.meta.team?.name ?? 'Central RSE team')}</strong><span class="meta">Select to show the overview</span>`;
  }
  return '';
}

function buildControls() {
  // Offering chips: legend and filter in one.
  const typeFieldset = $('#type-filters');
  for (const type of state.types) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.type = type.id;
    chip.setAttribute('aria-pressed', 'true');
    chip.title = type.description ?? '';
    chip.innerHTML = `<span class="swatch" aria-hidden="true"></span><span>${esc(type.label)}</span><span class="count"></span>`;
    chip.addEventListener('click', () => {
      const { types } = state.filters;
      if (types.has(type.id)) types.delete(type.id);
      else types.add(type.id);
      chip.setAttribute('aria-pressed', String(types.has(type.id)));
      refresh();
    });
    typeFieldset.append(chip);
  }

  // Academic years present in the data, newest first.
  const years = [...new Set(state.activities.flatMap((activity) => activity.academicYears))].sort((a, b) => b - a);
  const yearSelect = $('#year-filter');
  yearSelect.innerHTML = ['<option value="all">All years</option>', ...years.map((year) => `<option value="${year}">${formatAcademicYear(year)}</option>`)].join('');
  yearSelect.addEventListener('change', () => {
    state.filters.year = yearSelect.value;
    refresh();
  });

  $('#status-filter').addEventListener('change', (event) => {
    state.filters.status = event.target.value;
    refresh();
  });

  const search = $('#search');
  search.addEventListener('input', () => {
    state.filters.query = search.value;
    refresh();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const query = search.value.trim().toLowerCase();
    if (!query) return;
    const dept = state.departments.find((item) => matchesQuery(item.name, query) || matchesQuery(item.shortName, query));
    if (dept) select({ kind: 'department', id: dept.id });
  });

  $('#show-activities').addEventListener('change', (event) => {
    state.showActivities = event.target.checked;
    refresh();
  });

  const showSoftware = $('#show-software');
  showSoftware.disabled = state.software.length === 0;
  showSoftware.addEventListener('change', () => {
    state.showSoftware = showSoftware.checked;
    refresh();
  });
  $('#ring-legend').hidden = state.software.length === 0;

  $('#include-mock').addEventListener('change', (event) => {
    state.filters.includeMock = event.target.checked;
    refresh();
  });

  $('#reset-layout').addEventListener('click', () => runLayout({ randomise: true }));

  const viewToggle = $('#view-toggle');
  viewToggle.addEventListener('click', () => {
    state.view = state.view === 'graph' ? 'table' : 'graph';
    const isTable = state.view === 'table';
    viewToggle.setAttribute('aria-pressed', String(isTable));
    viewToggle.textContent = isTable ? 'Map view' : 'Table view';
    $('#table-view').hidden = !isTable;
    $('#graph').style.visibility = isTable ? 'hidden' : 'visible';
    $('#reset-layout').disabled = isTable;
    refresh();
    if (!isTable && cy) cy.resize();
  });

  $('#theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
      ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(current === 'dark' ? 'light' : 'dark', { persist: true });
  });

  // Delegated handlers for links rendered inside the panel and table.
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-select-department], [data-select-activity], [data-select-software], [data-clear-selection]');
    if (!target) return;
    if (target.hasAttribute('data-clear-selection')) select(null);
    else if (target.dataset.selectDepartment) select({ kind: 'department', id: target.dataset.selectDepartment });
    else if (target.dataset.selectActivity) select({ kind: 'activity', id: target.dataset.selectActivity });
    else if (target.dataset.selectSoftware) select({ kind: 'software', id: target.dataset.selectSoftware });
  });
  $('#table-view').addEventListener('keydown', (event) => {
    const row = event.target.closest('tr[data-select-department]');
    if (row && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      select({ kind: 'department', id: row.dataset.selectDepartment });
    }
  });

  window.addEventListener('hashchange', () => select(selectionFromHash(), { updateHash: false }));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', restyleGraph);
}

/* ------------------------------------------------------------------------ */
/* Theme                                                                     */
/* ------------------------------------------------------------------------ */

function applyTheme(theme, { persist = false } = {}) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  if (persist) storageSet(THEME_STORAGE_KEY, theme);
  restyleGraph();
}

function restyleGraph() {
  if (cy) cy.style(buildStyle());
  if (state.types.length) refresh();
}

/* ------------------------------------------------------------------------ */
/* Start-up                                                                  */
/* ------------------------------------------------------------------------ */

function showStatus(message) {
  const element = $('#status-message');
  element.innerHTML = message;
  element.hidden = false;
}

function indexData(departmentsDoc, activitiesDoc, softwareDoc) {
  state.groups = departmentsDoc.groups;
  state.departments = departmentsDoc.departments;
  state.types = activitiesDoc.offeringTypes;
  state.services = activitiesDoc.services ?? [];
  state.meta = { ...(departmentsDoc.meta ?? {}), ...(activitiesDoc.meta ?? {}) };

  const now = new Date();
  state.activities = activitiesDoc.activities.map((raw) => {
    const activity = normaliseActivity(raw);
    activity.academicYears = activityAcademicYears(activity, now);
    return activity;
  });

  state.groupsById = new Map(state.groups.map((group) => [group.id, group]));
  state.departmentsById = new Map(state.departments.map((dept) => [dept.id, dept]));
  state.typesById = new Map(state.types.map((type) => [type.id, type]));
  state.activitiesById = new Map(state.activities.map((activity) => [activity.id, activity]));
  state.software = softwareDoc.software ?? [];
  state.softwareMeta = softwareDoc.meta ?? {};
  state.softwareById = new Map(state.software.map((item) => [item.id, item]));
  state.filters.types = new Set(state.types.map((type) => type.id));
}

async function main() {
  const savedTheme = storageGet(THEME_STORAGE_KEY);
  if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;

  if (typeof window.cytoscape !== 'function') {
    showStatus('The graph library failed to load. Check that the <code>vendor/</code> folder was deployed.');
    return;
  }

  let docs;
  try {
    docs = await loadData();
  } catch (error) {
    const hint = window.location.protocol === 'file:'
      ? '<br>Browsers block data loading from <code>file://</code> pages; serve the folder over HTTP instead (see README).'
      : '';
    showStatus(`Could not load the map data. ${esc(error.message)}${hint}`);
    return;
  }

  state.validation = validateData(docs.departments, docs.activities, docs.software);
  for (const warning of state.validation.warnings) console.warn(`[data] ${warning}`);
  if (state.validation.errors.length) {
    for (const error of state.validation.errors) console.error(`[data] ${error}`);
    showStatus(`The map data has ${pluralise(state.validation.errors.length, 'error')}:<br>${state.validation.errors.slice(0, 8).map(esc).join('<br>')}`);
    return;
  }

  indexData(docs.departments, docs.activities, docs.software);
  buildControls();
  createGraph();
  state.selection = selectionFromHash();
  refresh();
  runLayout({ randomise: true });
}

main();
