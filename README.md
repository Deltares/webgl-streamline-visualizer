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

### Velocity TIFF encoding

The TIFF loader accepts FEWS `GetMap` responses with `convertVectortoRG=true`,
not arbitrary spatial GeoTIFFs. It requires unsigned 8-bit RGB bands with U in
red and V in green, optionally followed by an unassociated alpha band
(`ExtraSamples=2`). Premultiplied alpha and other band layouts are rejected.

FEWS stores `[uOffset, vOffset, 0, 0, 0, 0]` in `ModelTiepoint` and
`[uIncrement, vIncrement, 0]` in `ModelPixelScale`. Components are decoded as
`byte * increment + offset`. These are velocity metadata, not standard spatial
tiepoints or pixel sizes. Non-finite metadata, spatial tiepoints, transformation
matrices, and non-empty spatial GeoKey directories are rejected.

Pixels with both R and G equal to 255 are missing. Fully transparent pixels
and pixels where either velocity band matches an explicitly declared
`GDAL_NODATA` byte value are also treated as missing. Without that declaration,
a single velocity band equal to 255 remains valid.

## Examples

A hosted version of some of the examples can be found on the [GitHub Pages](https://deltares.github.io/webgl-streamline-visualizer/).

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

To build and view the examples run (note you may have to adapt base to '/' in [the examples config](vite-examples.config.ts) )

```bash
npm run build:examples
npm run preview
```

Run all tests, listening for change in the source:

```bash
npm run test
```
