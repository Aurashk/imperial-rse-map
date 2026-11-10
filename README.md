# Imperial RSE Map

An interactive network map of every Imperial College London department,
showing where the central Research Software Engineering (RSE) team is active
and what research software each department produces.

- **Faculties** are drawn as containers holding their **departments**.
- In **RSE team offerings** mode, each department is a pie chart of the
  team's engagements with it (collaborative projects, code surgeries,
  training, sprints, community events, experience programme placements and
  open-source boosters). Node size reflects the number of engagements; grey
  nodes have none. The central team sits in the middle, linked to every
  department it has worked with.
- In **Research software** mode, departments are shaded by the number of
  packages listed in the
  [Imperial Research Software Directory](https://github.com/ImperialCollegeLondon/research-software-directory),
  whether or not the RSE team was involved.
- Filters for offering, academic year, status and mock data; free-text search;
  optional activity/software nodes to expose cross-department work; an
  accessible table view; light and dark themes; and shareable deep links such
  as `#department=physics`.

## Data status

| Data | Source | Status |
|---|---|---|
| Faculties and departments | Imperial's published structure | Needs a check against the live A–Z; uncertain entries are flagged |
| RSE services | RSE team pages on imperial.ac.uk and GitHub Pages | Public |
| RSE engagements | 4 from public sources, the rest **mock** | Placeholder – to be replaced with team records |
| Research software (140 packages) | Imperial Research Software Directory + GitHub | Public; department attribution inferred and needs verifying |

Every record carries its provenance, which the map shows as a badge. See
[`data/README.md`](data/README.md) for the formats and how to update them.

## Running locally

Browsers block data loading from `file://` pages, so serve the folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

Validate the data (Node.js 18 or later, no dependencies):

```bash
node scripts/validate-data.mjs
```

## Hosting

The site is static HTML, CSS, JavaScript and JSON with its libraries vendored,
so **GitHub Pages hosts it as is**. The included workflow
(`.github/workflows/pages.yml`) validates the data on every pull request and
deploys on every push to `main`. To enable it, set *Settings → Pages → Source*
to **GitHub Actions**.

A GitHub Pages site is public. If the real engagement data should only be
visible to Imperial staff, publish from an organisation on GitHub Enterprise
Cloud with private Pages enabled, or host the same files behind Imperial
single sign-on (for example Azure Static Web Apps with Microsoft Entra ID).
No code changes are needed either way.

## Project layout

```
index.html                 Page shell
css/styles.css             Styles and colour tokens (light and dark)
js/app.js                  Graph, filters, panels and table view
js/data.js                 Loading, validation and date helpers (shared with Node)
data/                      Map data – see data/README.md
scripts/validate-data.mjs  Data validation used in CI
scripts/import_research_software.py  Regenerates data/software.json
vendor/                    Cytoscape.js and the fCoSE layout (see vendor/README.md)
```

## Libraries

Rendering uses [Cytoscape.js](https://js.cytoscape.org/) with the
[fCoSE](https://github.com/iVis-at-Bilkent/cytoscape.js-fcose) force-directed
layout, which handles nested (compound) nodes well – a good fit for
faculties containing departments. Both are MIT-licensed.
