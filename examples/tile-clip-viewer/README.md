# tile-clip-viewer

Streams Google Photorealistic 3D Tiles over Patras, Greece, and demonstrates
the two tile-shaping integrations:

- **`terratile.TileClipper`** - crops the visible tile area to a polygon, with
  a smooth shader edge on the tiles that straddle the polygon boundary (unlike
  whole-tile region culling, which can only hide or fade a tile wholesale). The
  crop mode also punches a circular hole at the polygon centroid
  (`clipper.setHole`), so it renders as a donut: kept inside the polygon,
  discarded inside the central circle.
- **`terratile.TileDisplacer`** - punches holes in the tiles, circular or
  polygonal, e.g. to drop a higher-fidelity scan into the gap.

The **Mode** button cycles `none -> polygon crop -> circular cutouts`. The two
effects share the same PlayCanvas shader-chunk hook, so they do not compose on
a single mesh-instance - the viewer applies one at a time. See [app.js](app.js)
for how `setPolygon` / `addZone`, `apply` / `remove`, and `updateFrame` are
wired into the tile load handler and the per-frame update.

Loading the *replacement scan* for a cutout is ordinary PlayCanvas asset code
and is deliberately left out: the library ships the hole, the application fills
it.

## Get a credential

The viewer needs a credential from one of two providers - pick whichever is
easier for you:

**Google Maps API key.** For Google's
[Photorealistic 3D Tiles API](https://developers.google.com/maps/documentation/tile/3d-tiles):
create a Google Cloud project with a billing account, enable the **Map Tiles
API**, and create an API key
([Setup in Cloud Console](https://developers.google.com/maps/documentation/tile/get-api-key)).

**Cesium ion access token (free account).** Create a free
[Cesium ion](https://cesium.com/ion/) account and copy your default access
token. Cesium ion hosts Google Photorealistic 3D Tiles as asset ID `2275207`
(the viewer's default), so you can stream the same tiles without a Google Cloud
billing project. Cesium ion's usage limits apply.

After you start the viewer, the credential is saved to the browser's
`localStorage` so reloads (and the sibling `basic-viewer` at the same origin)
auto-start without re-prompting. The credential is only ever sent to the
provider you pick; click **Forget credential** in the HUD to clear it.

## Run

From the repository root:

```
npm run build          # produces dist/terratile.js
python -m http.server 8000
```

Then open <http://localhost:8000/examples/tile-clip-viewer/>, pick a provider
and paste your credential into the form, or pass it in the URL:

```
# Google Maps API key
http://localhost:8000/examples/tile-clip-viewer/?key=YOUR_GOOGLE_KEY

# Cesium ion access token (asset 2275207 = Google Photorealistic 3D Tiles)
http://localhost:8000/examples/tile-clip-viewer/?provider=cesium-ion&token=YOUR_ION_TOKEN&asset=2275207
```

## Controls

Two camera modes, switched with the **controller dropdown** in the HUD:

- **Orbit** - left-drag pan, right-drag orbit, scroll zoom (two-finger
  pinch/twist on touch).
- **Fly (WASD)** - click the canvas to capture the mouse for looking; WASD to
  move, Space/Ctrl for up/down, Shift to sprint.

The HUD also has the **Mode button** (cycles none / polygon crop / circular
cutouts), sliders for **Tile limit** (`softTileLimit`), **Max SSE**
(`maximumScreenSpaceError`) and **Fly speed**, and a **Lock streaming**
checkbox (`streamingPaused`) that freezes the streaming pipeline -- no new
tiles load and none unload while on. In-flight fetches still land.

The cutout demo shows both `TileDisplacer` zone shapes: one circular hole and
one polygonal hole.

Tile bytes are cached through `terratile.TileCache` (in-memory + IndexedDB),
so revisits to the same area skip the network and reloads stay warm. Loads
also flow through `terratile.TileInstantiationQueue` (frame-budgeted parse +
GPU upload), `terratile.HiddenEntityLRU` (park-and-revive unloaded tiles
instead of reparsing on revisit), and `terratile.disableTileLighting` (PBR
off on baked-lit satellite imagery is a free fragment-shader win).
TileManager skips its selection walk on idle frames via the default
`idleTraversalSkipFrames`.

## Custom crop polygon

The default crop polygon is an irregular pentagon around the Patras origin,
deliberately not axis-aligned with north. The HUD's **Import crop polygon
(GeoJSON)** file input replaces it at runtime: pick a `.geojson` / `.json` file
containing a `Polygon` - as a bare geometry, a `Feature`, or a
`FeatureCollection` (the first polygon found is used). Its exterior ring's
lon/lat vertices are projected into the local frame and pushed to
`TileClipper`, and the viewer switches to crop mode.

The polygon must lie near the viewer's location (Patras) to overlap the
streamed tiles, and is capped at 64 vertices (the clipper's `maxVerts`).

## PlayCanvas version

`TileClipper` and `TileDisplacer` inject shaders via the `litUserDeclarationPS`
/ `litUserMainEndPS` chunk hooks, which are specific to PlayCanvas 2.17.x (the
version this example loads from the CDN).
