/**
 * Imperial RSE Map – interactive network of College departments, each drawn
 * as a pie chart showing the mix of engagements it has had with the central
 * Research Software Engineering (RSE) team.
 *
 * Structure
 * ---------
 * - Faculties are Cytoscape compound (parent) nodes; departments sit inside.
 * - A single hub node represents the central RSE team. In the default view it
 *   is linked to every department with at least one visible engagement, and
 *   edge width reflects the number of engagements.
 * - Optionally, each activity can be drawn as its own node linked to the
 *   departments it involved, which exposes cross-department work.
 * - A second colouring mode shows research software from the Imperial
 *   Research Software Directory (which may have no RSE involvement), with
 *   departments shaded on a single-hue scale by the number of packages.
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
const SEQUENTIAL_STEPS = 5;
const MIN_NODE_SIZE = 30;
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
  colourBy: 'rse', // 'rse' (offering pie charts) or 'software' (research software counts)
  showItems: false, // draw activities (or software, in software mode) as their own nodes
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

/** Research software attributed to each department, plus the centrally owned set. */
function softwareByDepartment() {
  const result = new Map(state.departments.map((dept) => [dept.id, []]));
  for (const item of state.software) {
    for (const deptId of item.departments) result.get(deptId)?.push(item);
  }
  return result;
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
  if (state.colourBy === 'software') return software.some((item) => softwareMatchesQuery(item, query));
  return visibleActivities.some((activity) => activityMatchesQuery(activity, query));
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
        'border-color': halo,
        'border-width': 2,
        'pie-size': '100%',
        'transition-property': 'width, height, opacity',
        'transition-duration': 200,
      },
    },
    {
      selector: 'node[kind = "department"].idle',
      style: {
        'background-color': cssVar('--graph-node-idle'),
        'border-color': cssVar('--graph-node-idle-border'),
        'border-width': 1,
        color: cssVar('--ink-muted'),
      },
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
        'background-color': cssVar('--seq-3'),
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
      style: { width: 1, opacity: 0.6, 'line-color': cssVar('--seq-2') },
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
      selector: 'node.selected',
      style: {
        'border-color': cssVar('--focus'),
        'border-width': 4,
        'z-index': 20,
      },
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

  // Single-hue scale used when departments are coloured by research software count.
  for (let step = 1; step <= SEQUENTIAL_STEPS; step += 1) {
    style.push({
      selector: `node[kind = "department"].seq-${step}`,
      style: { 'background-color': cssVar(`--seq-${step}`) },
    });
  }

  for (const type of state.types) {
    const colour = typeColour(type.id);
    style.push({ selector: `node.activity[type = "${type.id}"]`, style: { 'background-color': colour } });
    style.push({ selector: `edge[kind = "activity-edge"][type = "${type.id}"]`, style: { 'line-color': colour } });
  }

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

/** Runs the force-directed layout on the nodes currently drawn. */
function runLayout({ randomise = false } = {}) {
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

  drawn.layout(options).run();
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

  updateModeControls();
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

function updateGraph(visible, byDept, softwareByDept, query, relayout) {
  if (!cy) return;
  const softwareMode = state.colourBy === 'software';
  const maxTotal = Math.max(1, ...[...byDept.values()].map((entry) => entry.total));
  const maxSoftware = Math.max(1, ...[...softwareByDept.values()].map((items) => items.length));
  const visibleIds = new Set(visible.map((activity) => activity.id));
  const before = drawnItemsSignature();

  cy.batch(() => {
    for (const dept of state.departments) {
      const entry = byDept.get(dept.id);
      const software = softwareByDept.get(dept.id);
      const node = cy.getElementById(dept.id);
      const count = softwareMode ? software.length : entry.total;

      const data = { total: count, size: nodeSize(count, softwareMode ? maxSoftware : maxTotal) };
      state.types.forEach((type, index) => {
        const typeCount = entry.byType.get(type.id) ?? 0;
        data[`pie${index + 1}`] = softwareMode || entry.total === 0 ? 0 : (typeCount / entry.total) * 100;
      });
      node.data(data);
      node.toggleClass('idle', count === 0);

      // Quantise software counts onto the sequential scale (step 1 = fewest).
      const step = softwareMode && count > 0 ? Math.max(1, Math.ceil((count / maxSoftware) * SEQUENTIAL_STEPS)) : 0;
      for (let i = 1; i <= SEQUENTIAL_STEPS; i += 1) node.toggleClass(`seq-${i}`, step === i);

      const hubEdge = cy.getElementById(`${HUB_EDGE_PREFIX}${dept.id}`);
      hubEdge.data('weight', entry.total);
      // Hub edges always take part in the layout (keeping it stable between modes and
      // filters) but are only visible when they represent current RSE engagement.
      hubEdge.toggleClass('ghost', softwareMode || state.showItems || entry.total === 0);

      const dim = query !== '' && !departmentMatchesQuery(dept, query, entry.activities, software);
      node.toggleClass('dim', dim);
    }

    cy.nodes('.activity').forEach((node) => {
      const activity = state.activitiesById.get(node.data('activityId'));
      const show = !softwareMode && state.showItems && visibleIds.has(activity.id);
      node.toggleClass('hidden', !show);
      node.connectedEdges().toggleClass('hidden', !show);
      node.toggleClass('dim', show && query !== '' && !activityMatchesQuery(activity, query));
    });

    cy.nodes('.software').forEach((node) => {
      const item = state.softwareById.get(node.data('softwareId'));
      const show = softwareMode && state.showItems && (item.central || item.departments.length > 0);
      node.toggleClass('hidden', !show);
      node.connectedEdges().toggleClass('hidden', !show);
      node.toggleClass('dim', show && query !== '' && !softwareMatchesQuery(item, query));
    });

    applySelectionClasses();
  });

  // Item nodes change what is drawn, so the layout must adapt to them.
  if (relayout || before !== drawnItemsSignature()) runLayout();
}

/** Shows the controls relevant to the current colouring mode. */
function updateModeControls() {
  const softwareMode = state.colourBy === 'software';
  $('#type-filters').hidden = softwareMode;
  $('#software-legend').hidden = !softwareMode;
  for (const id of ['#year-filter', '#status-filter', '#include-mock']) $(id).disabled = softwareMode;
  $('#show-items-label').textContent = softwareMode ? 'Show software as nodes' : 'Show activities as nodes';
  $('.subtitle').textContent = softwareMode
    ? 'Departments shaded by research software listed in the Imperial Research Software Directory'
    : 'Departments coloured by engagement with the central Research Software Engineering team';
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

  // Sequential legend swatches follow the theme too.
  document.querySelectorAll('#software-legend [data-step]').forEach((swatch) => {
    swatch.style.background = cssVar(`--seq-${swatch.dataset.step}`);
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
  } else if (state.colourBy === 'software') {
    panel.innerHTML = softwareOverviewPanel(softwareByDept);
  } else {
    panel.innerHTML = overviewPanel(visible, byDept);
  }
}

function softwareTags(item) {
  const tags = [];
  if (item.language) tags.push(`<span class="tag">${esc(item.language)}</span>`);
  if (Number.isInteger(item.stars)) tags.push(`<span class="tag">★ ${item.stars}</span>`);
  if (item.archived) tags.push('<span class="tag">Archived</span>');
  else if (item.inactive) tags.push('<span class="tag">No commits in 12 months</span>');
  if (item.featuredMonth) tags.push(`<span class="tag public">Software of the month ${esc(item.featuredMonth)}</span>`);
  if (item.attribution?.confidence) tags.push(`<span class="tag">${esc(item.attribution.confidence)}-confidence attribution</span>`);
  return tags.join('');
}

function softwareListItem(item) {
  return `
    <li class="item">
      <div class="item-title">
        <span class="swatch" style="background:${esc(cssVar('--seq-3'))};border-radius:2px" aria-hidden="true"></span>
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

function softwareOverviewPanel(softwareByDept) {
  const attributed = state.software.filter((item) => item.departments.length > 0);
  const central = state.software.filter((item) => item.central);
  const unattributed = state.software.filter((item) => item.departments.length === 0 && !item.central);
  const engaged = [...softwareByDept.values()].filter((items) => items.length > 0).length;
  const active = state.software.filter((item) => item.inactive === false && !item.archived).length;
  const source = safeUrl(state.softwareMeta.source);

  const top = state.departments
    .map((dept) => ({ dept, count: softwareByDept.get(dept.id).length }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.dept.name.localeCompare(b.dept.name))
    .slice(0, 8);

  const languages = topCounts(state.software.map((item) => item.language), 8);

  return `
    <h2>Research software</h2>
    <p class="meta">From the ${source ? `<a href="${esc(source)}" target="_blank" rel="noopener">Imperial Research Software Directory</a>` : 'Imperial Research Software Directory'}${state.softwareMeta.generated ? ` · imported ${esc(state.softwareMeta.generated)}` : ''}</p>
    <p class="notice">Listed software may have had no central RSE involvement. Departments are inferred from the owning GitHub account or group and need verifying.</p>
    <div class="stats">
      <div class="stat"><span class="value">${state.software.length}</span><span class="label">Packages</span></div>
      <div class="stat"><span class="value">${engaged}<small>/${state.departments.length}</small></span><span class="label">Departments</span></div>
      <div class="stat"><span class="value">${active}</span><span class="label">Active in last year</span></div>
    </div>
    <h3>Most software</h3>
    <ul class="item-list">${top
      .map((row) => `<li class="item"><button type="button" class="dept-link" data-select-department="${esc(row.dept.id)}">${esc(row.dept.name)}</button> <span class="meta">· ${pluralise(row.count, 'package')}</span></li>`)
      .join('')}</ul>
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

function overviewPanel(visible, byDept) {
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
          .map((row) => `<li class="item"><button type="button" class="dept-link" data-select-department="${esc(row.dept.id)}">${esc(row.dept.name)}</button> <span class="meta">· ${pluralise(row.total, 'activity', 'activities')}</span></li>`)
          .join('')}</ul>`
      : '<p class="meta">No activities match the current filters.</p>'}
    <h3>Services offered</h3>
    <ul class="item-list">${services}</ul>
    ${errors.length || warnings.length
      ? `<h3>Data checks</h3><ul class="item-list">${[...errors.map((e) => `<li class="item">Error: ${esc(e)}</li>`), ...warnings.map((w) => `<li class="item meta">${esc(w)}</li>`)].join('')}</ul>`
      : ''}
    <p class="meta">Select a department or activity on the map for details.</p>`;
}

function departmentPanel(dept, entry, software = []) {
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

  const softwareSection = `
    <h3>Research software (${software.length})</h3>
    ${software.length
      ? `<p class="meta">From the Imperial Research Software Directory; may not involve the RSE team.</p><ul class="item-list">${[...software]
          .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name))
          .map(softwareListItem)
          .join('')}</ul>`
      : '<p class="meta">No software from this department is listed in the Imperial Research Software Directory yet.</p>'}`;
  const softwareFirst = state.colourBy === 'software';

  return `
    <button type="button" class="btn back" data-clear-selection>← Overview</button>
    <h2>${esc(dept.name)}</h2>
    <p class="meta">${esc(group?.name ?? '')}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">Department website</a>` : ''}</p>
    ${dept.verify ? '<p class="notice">This department’s name or placement is flagged for verification.</p>' : ''}
    ${softwareFirst ? softwareSection : ''}
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
    ${softwareFirst ? '' : softwareSection}`;
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
    .filter((dept) => query === '' || departmentMatchesQuery(dept, query, byDept.get(dept.id).activities, softwareByDept.get(dept.id)))
    .map((dept) => {
      const entry = byDept.get(dept.id);
      const softwareCount = softwareByDept.get(dept.id).length;
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
      <caption class="meta" style="text-align:left;padding-bottom:6px">RSE activities per department for the current filters (an activity involving several departments is counted once for each), and research software listed in the Imperial Research Software Directory.</caption>
      <thead><tr><th scope="col">Department</th><th scope="col">Faculty</th>${header}<th scope="col">RSE total</th><th scope="col">Research software</th></tr></thead>
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
  if (data.kind === 'department' && state.colourBy === 'software') {
    const dept = state.departmentsById.get(data.id);
    const items = softwareByDepartment().get(data.id);
    const languages = topCounts(items.map((item) => item.language), 3).map(([language]) => language).join(', ');
    return `<strong>${esc(dept.name)}</strong>${pluralise(items.length, 'research software package')}${languages ? `<br><span class="meta">${esc(languages)}</span>` : ''}`;
  }
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
    return `<strong>${esc(dept.name)}</strong>${rows ? `<ul>${rows}</ul>` : '<span class="meta">No activity for current filters</span>'}`;
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

  $('#show-items').addEventListener('change', (event) => {
    state.showItems = event.target.checked;
    refresh();
  });

  const colourBy = $('#colour-by');
  colourBy.querySelector('option[value="software"]').disabled = state.software.length === 0;
  colourBy.addEventListener('change', () => {
    state.colourBy = colourBy.value === 'software' ? 'software' : 'rse';
    if (state.selection?.kind === 'activity' || state.selection?.kind === 'software') state.selection = null;
    refresh();
  });

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
  // A software deep link only makes sense in software mode.
  if (state.selection?.kind === 'software') {
    state.colourBy = 'software';
    $('#colour-by').value = 'software';
  }
  refresh();
  runLayout({ randomise: true });
}

main();
