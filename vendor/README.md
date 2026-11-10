# Vendored libraries

These files are committed so the site works without a CDN and so versions
only change deliberately.

| File | Package | Version | Licence |
|---|---|---|---|
| `cytoscape.min.js` | [cytoscape](https://js.cytoscape.org/) | 3.30.4 | MIT |
| `layout-base.js` | [layout-base](https://github.com/iVis-at-Bilkent/layout-base) | 2.0.1 | MIT |
| `cose-base.js` | [cose-base](https://github.com/iVis-at-Bilkent/cose-base) | 2.2.0 | MIT |
| `cytoscape-fcose.js` | [cytoscape-fcose](https://github.com/iVis-at-Bilkent/cytoscape.js-fcose) | 2.2.0 | MIT |

Licence texts are in `licences/`.

## Updating

```bash
npm pack cytoscape@<version> cytoscape-fcose@<version> cose-base@<version> layout-base@<version>
```

Extract each tarball and copy the files named above (from `package/dist/` for
Cytoscape, the package root for the others) over the existing ones, then
update the table. Load order in `index.html` must stay
`cytoscape → layout-base → cose-base → cytoscape-fcose`.
