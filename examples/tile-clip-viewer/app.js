// terratile - tile clip viewer
//
// Streams Google Photorealistic 3D Tiles over Patras, Greece and demonstrates
// the two tile-shaping integrations:
//
//   * terratile.TileClipper   - crops the visible area to a polygon with a
//                               smooth shader edge, plus a circular hole at the
//                               polygon centroid so the crop reads as a donut.
//   * terratile.TileDisplacer - punches circular AND polygonal holes in the
//                               tiles (e.g. to drop a higher-fidelity scan
//                               into the gap).
//
// Tiles stream through terratile.playcanvas.TileRenderer (worker decode,
// resident cache, atomic refinement, dither fade) for smooth, hole-free
// transitions. The clip / cutout effect is applied to each tile in the
// renderer's onEntityPrepared hook, so the dither fade composes on top of it.
//
// The "Mode" button cycles: none -> polygon crop -> circular cutouts. The two
// effects use the same PlayCanvas shader-chunk hook, so they do not compose on
// a single mesh-instance -- the viewer applies one at a time.
//
// The HUD file input imports a GeoJSON polygon to replace the default crop
// polygon at runtime; its lon/lat ring is projected into the local frame.
//
// Credentials come from the URL (?key= for Google, or
// ?provider=cesium-ion&token=&asset= for Cesium ion), from localStorage if
// previously saved, or from the on-page form.

(function () {
    'use strict';

    // ---- Scene constants -------------------------------------------------
    // Patras, Greece -- full Google Photorealistic 3D Tiles coverage.
    const ORIGIN = { lon: 21.7346, lat: 38.2466, alt: 0 };

    // Demo clip polygon and cutout zones, in the terratile local frame: metres,
    // +X east, -Z north, origin at ORIGIN. The clip polygon is an irregular
    // pentagon; inside it sit one circular and one polygonal cutout zone.
    const CLIP_POLYGON = [
        { x: -135, z: -45 },
        { x: -25, z: -150 },
        { x: 150, z: -60 },
        { x: 95, z: 130 },
        { x: -110, z: 100 }
    ];
    const CUTOUT_ZONES = [
        { id: 'circle-a', x: -55, z: -20, radius: 30 }
    ];
    const CUTOUT_POLY_ZONES = [
        {
            id: 'poly-a',
            verts: [
                { x: 35, z: 15 },
                { x: 105, z: 5 },
                { x: 120, z: 70 },
                { x: 65, z: 95 },
                { x: 30, z: 60 }
            ]
        }
    ];

    // Upper bound on clip-polygon vertices: the default polygon plus headroom
    // for an imported GeoJSON polygon. TileClipper unrolls one shader edge
    // test per vertex, so this is fixed at construction.
    const CLIP_MAX_VERTS = 64;

    const MODES = ['none', 'crop', 'cutouts'];
    const MODE_LABELS = { none: 'off', crop: 'polygon crop (donut)', cutouts: 'circular cutouts' };

    // Extract the first Polygon's exterior ring ([[lon, lat], ...]) from a
    // parsed GeoJSON value -- a FeatureCollection, a Feature, or a bare
    // geometry. Returns null if there is no usable Polygon.
    function firstPolygonRing(geojson) {
        const ringOf = (g) => {
            if (!g || typeof g !== 'object') return null;
            if (g.type === 'FeatureCollection') {
                for (const f of g.features || []) {
                    const r = ringOf(f);
                    if (r) return r;
                }
                return null;
            }
            if (g.type === 'Feature') return ringOf(g.geometry);
            if (g.type === 'Polygon') return g.coordinates && g.coordinates[0];
            if (g.type === 'MultiPolygon') {
                return g.coordinates && g.coordinates[0] && g.coordinates[0][0];
            }
            return null;
        };
        return ringOf(geojson);
    }

    // ---- DOM -------------------------------------------------------------
    const statusLabel = document.getElementById('status');
    const tileCountLabel = document.getElementById('tile-count');
    const modeButton = document.getElementById('mode-button');
    const keyForm = document.getElementById('key-form');
    const providerSelect = document.getElementById('provider-select');
    const googleKey = document.getElementById('google-key');
    const cesiumToken = document.getElementById('cesium-token');
    const cesiumAsset = document.getElementById('cesium-asset');
    const forgetCredBtn = document.getElementById('forget-cred');
    const tileLimitEl = document.getElementById('tile-limit');
    const tileLimitValueEl = document.getElementById('tile-limit-value');
    const maxSseEl = document.getElementById('max-sse');
    const maxSseValueEl = document.getElementById('max-sse-value');
    const flySpeedEl = document.getElementById('fly-speed');
    const flySpeedValueEl = document.getElementById('fly-speed-value');
    const controllerSelect = document.getElementById('controller-select');
    const controlsHint = document.getElementById('controls-hint');
    const streamPausedEl = document.getElementById('stream-paused');
    const geojsonInput = document.getElementById('geojson-input');

    const setStatus = (msg) => { statusLabel.textContent = msg; };
    const setTileCount = (n) => { tileCountLabel.textContent = String(n); };

    // ---- Credential resolution ------------------------------------------
    // Cesium ion asset 2275207 is Google Photorealistic 3D Tiles.
    terratileExamples.resolveCredentials({
        form: keyForm,
        providerSelect,
        googleKey,
        cesiumToken,
        cesiumAsset,
        forgetButton: forgetCredBtn,
        onResolved: start
    });

    // ---- Main ------------------------------------------------------------
    function start(cfg) {
        setStatus('Starting...');

        const canvas = document.getElementById('application');
        const app = new pc.Application(canvas);
        app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
        app.setCanvasResolution(pc.RESOLUTION_AUTO);
        app.start();
        canvas.style.touchAction = 'none';
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        window.addEventListener('resize', () => app.resizeCanvas());

        app.scene.ambientLight = new pc.Color(0.4, 0.4, 0.45);

        const light = new pc.Entity('Light');
        light.addComponent('light', { type: 'directional', intensity: 1 });
        light.setLocalEulerAngles(60, 30, 0);
        app.root.addChild(light);

        const camera = new pc.Entity('Camera');
        camera.addComponent('camera', {
            // Sky blue clear colour.
            clearColor: new pc.Color(0.53, 0.81, 0.92),
            farClip: 20000000,
            nearClip: 0.1
        });
        app.root.addChild(camera);

        // `tilesRoot` parents every loaded tile entity and carries the
        // terratile reference-frame transform, which maps the tiles' raw
        // "tile-Y" geometry into the local frame (metres, +X east, +Y up,
        // -Z north, origin at ORIGIN). Tile fragments therefore render at
        // local-frame coordinates -- the space CLIP_POLYGON and CUTOUT_ZONES
        // are defined in, and the space app.root sits in. So updateFrame() is
        // given app.root (identity), not tilesRoot.
        const tilesRoot = new pc.Entity('TilesRoot');
        app.root.addChild(tilesRoot);

        const frame = terratile.createLocalFrame({ origin: ORIGIN });
        tilesRoot.setLocalPosition(
            frame.rootPosition[0], frame.rootPosition[1], frame.rootPosition[2]);
        tilesRoot.setLocalRotation(
            frame.rootRotation[0], frame.rootRotation[1],
            frame.rootRotation[2], frame.rootRotation[3]);

        // ---- Camera controls (orbit + fly) ------------------------------
        const controls = terratileExamples.createCameraControls({ camera, canvas });
        const HINTS = {
            orbit: 'Left-drag pan, right-drag orbit, scroll zoom',
            fly: 'Click to look, WASD move, Space/Ctrl up/down, Shift sprint'
        };
        controls.switchTo('orbit');
        controlsHint.textContent = HINTS.orbit;
        controllerSelect.addEventListener('change', () => {
            controls.switchTo(controllerSelect.value);
            controlsHint.textContent = HINTS[controllerSelect.value];
        });
        controls.all.fly.setSpeed(+flySpeedEl.value || 25);
        flySpeedEl.addEventListener('input', () => {
            const v = +flySpeedEl.value;
            flySpeedValueEl.textContent = String(v);
            controls.all.fly.setSpeed(v);
        });

        // ---- Clip + displace --------------------------------------------
        // Live tile entities (prepared, not yet destroyed). Mode switches
        // re-apply the effect across this set; the renderer's onEntityPrepared
        // / onEntityRestored hooks keep it current for streamed/revived tiles.
        const liveEntities = new Set();

        const clipper = new terratile.TileClipper({ app, maxVerts: CLIP_MAX_VERTS });

        // Crop to the polygon AND punch a circular hole at its centroid, so the
        // 'crop' mode renders a donut: keep inside the polygon, discard the
        // central circle. The hole radius scales with the polygon, so an
        // imported GeoJSON outline gets a proportional hole too.
        const setCropPolygon = (polyXZ) => {
            clipper.setPolygon(polyXZ);
            let cx = 0, cz = 0;
            for (const p of polyXZ) { cx += p.x; cz += p.z; }
            cx /= polyXZ.length;
            cz /= polyXZ.length;
            let meanR = 0;
            for (const p of polyXZ) meanR += Math.hypot(p.x - cx, p.z - cz);
            meanR /= polyXZ.length;
            clipper.setHole({ x: cx, z: cz, radius: meanR * 0.4 });
        };
        setCropPolygon(CLIP_POLYGON);

        const displacer = new terratile.TileDisplacer({ app });
        for (const z of CUTOUT_ZONES) {
            displacer.addZone(z.id, { x: z.x, z: z.z }, z.radius);
        }
        for (const z of CUTOUT_POLY_ZONES) {
            displacer.addPolygonZone(z.id, z.verts);
        }

        let mode = 'crop';

        // Apply the current mode's effect to a single tile entity.
        const applyMode = (entity) => {
            if (mode === 'crop') clipper.apply(entity);
            else if (mode === 'cutouts') displacer.apply(entity);
        };

        // Switch mode: strip both effects from every live tile, then apply the
        // new mode. New / revived tiles pick it up via the renderer hooks.
        const setMode = (next) => {
            mode = next;
            for (const entity of liveEntities) {
                clipper.remove(entity);
                displacer.remove(entity);
                applyMode(entity);
            }
            modeButton.textContent = `Mode: ${MODE_LABELS[mode]}`;
        };

        modeButton.addEventListener('click', () => {
            const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
            setMode(next);
        });

        // Import a custom crop polygon from a GeoJSON file. The polygon's
        // lon/lat ring is projected into the terratile local frame and pushed
        // to the clipper; the viewer switches to crop mode to show it. The
        // polygon must lie near ORIGIN to overlap the streamed tiles.
        geojsonInput.addEventListener('change', () => {
            const file = geojsonInput.files && geojsonInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                let ring;
                try {
                    ring = firstPolygonRing(JSON.parse(reader.result));
                } catch (err) {
                    setStatus(`Could not parse GeoJSON: ${err.message}`);
                    return;
                }
                if (!ring || ring.length < 3) {
                    setStatus('GeoJSON has no usable Polygon.');
                    return;
                }
                // GeoJSON rings repeat the first vertex at the end -- drop it.
                let coords = ring;
                const a = coords[0];
                const b = coords[coords.length - 1];
                if (a[0] === b[0] && a[1] === b[1]) coords = coords.slice(0, -1);
                if (coords.length > CLIP_MAX_VERTS) {
                    setStatus(`Polygon has ${coords.length} vertices; using the first ${CLIP_MAX_VERTS}.`);
                    coords = coords.slice(0, CLIP_MAX_VERTS);
                }
                // Project each [lon, lat] vertex into the local frame's XZ plane.
                const polyXZ = coords.map((c) => {
                    const p = terratile.geodeticToLocal(frame, { lon: c[0], lat: c[1], alt: 0 });
                    return { x: p.x, z: p.z };
                });
                setCropPolygon(polyXZ);
                setMode('crop');
                setStatus(`Custom crop polygon loaded (${polyXZ.length} vertices).`);
            };
            reader.onerror = () => setStatus('Could not read the file.');
            reader.readAsText(file);
        });

        // ---- Tile streaming ---------------------------------------------
        // TileRenderer owns load/show/hide/fade/atomic coverage. We apply the
        // current clip / cutout effect to each tile as it is prepared or
        // revived, so the dither fade composes on top of the effect materials.
        const shownTiles = new Set();
        const tileRenderer = new terratile.playcanvas.TileRenderer({
            app,
            parent: tilesRoot,
            castShadows: false,
            workers: {
                draco: { jsUrl: 'draco.wasm.js', wasmUrl: 'draco.wasm.wasm' }
            },
            onEntityPrepared(entity) {
                liveEntities.add(entity);
                applyMode(entity);
            },
            onEntityRestored(entity) {
                // A revived tile may carry a stale effect from a previous mode.
                liveEntities.add(entity);
                clipper.remove(entity);
                displacer.remove(entity);
                applyMode(entity);
            },
            onEntityDestroyed(entity) {
                liveEntities.delete(entity);
            },
            onTileChanged(change) {
                const { type, entity } = change;
                if (type === 'show') shownTiles.add(entity);
                else if (type === 'hide' || type === 'unload') shownTiles.delete(entity);
                setTileCount(shownTiles.size);
            }
        });

        // ---- Run ---------------------------------------------------------
        setStatus('Resolving tileset...');
        modeButton.textContent = `Mode: ${MODE_LABELS[mode]}`;

        const source = cfg.provider === 'cesium-ion'
            ? new terratile.CesiumIonTilesetSource(cfg.token, cfg.asset)
            : new terratile.GoogleTilesetSource(cfg.key);
        const tileManager = new terratile.TileManager(source, tileRenderer);
        tileManager.globeMode = false;
        tileManager.setLocalFrame({ origin: ORIGIN });

        // Match a production viewer: drive streaming every frame, pin off the
        // frame-time SSE bias (no LOD pulsing), and allow the atomic same-frame
        // switch. refinementMode/transitionMode/maxFallbackSseFactor default to
        // the smooth atomic + dither behaviour.
        tileManager.idleTraversalSkipFrames = 0;
        tileManager.adaptiveSseBiasMax = 1;
        tileManager.deferredHideFrames = 0;

        // HUD sliders: tile budget + LOD threshold.
        tileManager.softTileLimit = +tileLimitEl.value || 2000;
        tileLimitEl.addEventListener('input', () => {
            const v = +tileLimitEl.value;
            tileLimitValueEl.textContent = String(v);
            tileManager.softTileLimit = v;
        });
        tileManager.maximumScreenSpaceError = +maxSseEl.value || 24;
        maxSseEl.addEventListener('input', () => {
            const v = +maxSseEl.value;
            maxSseValueEl.textContent = String(v);
            tileManager.maximumScreenSpaceError = v;
        });

        // Streaming lock: when checked, terratile's selection pass is skipped
        // so no new tiles load and none unload. In-flight fetches still land.
        tileManager.streamingPaused = streamPausedEl.checked;
        streamPausedEl.addEventListener('change', () => {
            tileManager.streamingPaused = streamPausedEl.checked;
        });

        tileManager.start().then(() => {
            setStatus('Viewer ready - use the Mode button to switch effect.');
        }).catch((err) => {
            console.error(err);
            setStatus(`Failed to start: ${err.message}`);
        });

        app.on('update', (dt) => {
            controls.tick(dt);
            const pos = camera.getPosition();
            const fovRad = camera.camera.fov * Math.PI / 180;
            const planes = camera.camera.frustum?.planes ?? null;
            tileManager.updateLocal(
                [pos.x, pos.y, pos.z], fovRad, app.graphicsDevice.height, planes);

            // Push the inverse world transform of the node whose local space
            // the polygon / zones live in -- the terratile local frame, which
            // is app.root's space (identity). Only the active effect needs the
            // per-frame uniform.
            if (mode === 'crop') clipper.updateFrame(app.root);
            else if (mode === 'cutouts') displacer.updateFrame(app.root);
        });
    }
})();
