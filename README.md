# WebGL streamline visualizer
A library for visualizing streamlines with moving particles, powered by WebGL.
The visualizer can be run with velocity fields from any source, but has a
MapLibre map layer that fetches WMS data from a FEWS WMS service.

This library uses WebGL to propagate particles along the streamlines of a
velocity field and visualize their tracks. Both the propagation and the
visualization is powered by the user's GPU, allowing the visualization to run
with thousands of particles at high FPS, even on mobile phones.

## Usage with MapLibre and FEWS WMS
This library has been primarily developed for use with
[MapLibre](https://maplibre.org/) and [FEWS Web Mapping
Service](https://publicwiki.deltares.nl/display/FEWSDOC/FEWS+Web+Mapping+Service+with+time+support%3A+WMS-T).

It can be added to an existing MapLibre map with:
```typescript
// Create new animated streamlines layer based on options.
const layer = new WMSStreamlineLayer('streamlines', options)

// Add the layer to the MapLibre map.
map.addLayer(layer)

// Initialise the streamlines by a.o. fetching a velocity field.
await layer.initialise()
```

Refer to [`examples/maplibre_basic.ts`](examples/maplibre_basic.ts) for the full
example.

## Standalone usage
The core of the WebGL streamline visualizer can also be used standalone, for
example for integrating with your map library or velocity field source of
choice.

Refer to [`examples/vortex.ts`](examples/vortex.ts) for a full example that uses
the visualizer without a map library and generates velocity data with
TypeScript function.

## For developers
Install dependencies and initialize Playwright:
```bash
npm install
npx playwright install
```

Run a development server for the demo pages, listening for changes in the
source:
```bash
npm run dev
```

Run the linter on the library and examples:
```bash
npm run lint
```

Run a production build of the library:
```bash
npm run build
```

Run all tests, listening for change in the source:
```bash
npm run test
```
