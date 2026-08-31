# basic-viewer

Streams Google Photorealistic 3D Tiles over Patras, Greece, and spawns a dozen
"walker" entities that random-walk across the scene, each snapped to the
rendered tile surface with `terratile.GroundSampler`.

It is the reference for wiring the ground sampler: see [app.js](app.js) for how
`sample` / `trackActive` / `queuePending` are used, and how `tryResolvePending`
and `invalidateForUnload` are driven from the tile load/unload handlers.

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
`localStorage` so reloads (and the sibling `tile-clip-viewer` at the same
origin) auto-start without re-prompting. The credential is only ever sent to
the provider you pick; click **Forget credential** in the HUD to clear it.

## Run

From the repository root:

```
npm run build          # produces dist/terratile.js
python -m http.server 8000
```

Then open <http://localhost:8000/examples/basic-viewer/>, pick a provider and
paste your credential into the form, or pass it in the URL:

```
# Google Maps API key
http://localhost:8000/examples/basic-viewer/?key=YOUR_GOOGLE_KEY

# Cesium ion access token (asset 2275207 = Google Photorealistic 3D Tiles)
http://localhost:8000/examples/basic-viewer/?provider=cesium-ion&token=YOUR_ION_TOKEN&asset=2275207
```

## Controls

Two camera modes, switched with the **controller dropdown** in the HUD:

- **Orbit** - left-drag pan, right-drag orbit, scroll zoom (two-finger
  pinch/twist on touch).
- **Fly (WASD)** - click the canvas to capture the mouse for looking; WASD to
  move, Space/Ctrl for up/down, Shift to sprint.

The HUD also has sliders for **Tile limit** (`softTileLimit` - the tile budget),
**Max SSE** (`maximumScreenSpaceError` - the LOD threshold, lower = sharper +
more tiles) and **Fly speed**, plus a **Lock streaming** checkbox
(`streamingPaused`) that freezes the streaming pipeline -- no new tiles load
and none unload while it's on. In-flight fetches still land.

Tile bytes are cached through `terratile.TileCache` (in-memory + IndexedDB),
so revisits to the same area skip the network and reloads stay warm. Clearing
your origin's site data also clears the persistent cache.

The viewer also threads tile loads through `terratile.TileInstantiationQueue`
(frame-budgeted GLB parse + GPU upload, so bursts don't stall the frame),
parks unloaded tiles in `terratile.HiddenEntityLRU` (revive instead of
reparse on revisit), runs every tile material through `terratile.disableTileLighting`
(PBR off on satellite imagery is a free fragment-shader win), and lets
TileManager skip its selection walk on idle frames via the default
`idleTraversalSkipFrames`.

The orange boxes wander the scene and stay glued to the ground as tiles stream
in and refine. They never float or sink, because `GroundSampler` re-probes them
whenever the tile under them changes.
