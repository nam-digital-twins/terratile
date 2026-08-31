// terratile - basic viewer
//
// Streams Google Photorealistic 3D Tiles over Patras, Greece and spawns a
// handful of "walker" entities that random-walk across the scene, each snapped
// to the rendered tile surface with terratile.GroundSampler.
//
// Tiles are driven by terratile.playcanvas.TileRenderer - the full streaming
// pipeline (worker decode, resident cache, atomic refinement, dither fade). It
// gives the smooth, hole-free transitions: a coarse tile keeps covering its
// area until the finer set is fully render-ready, then cross-fades in.
//
// GroundSampler reference (walkers ride the rendered surface):
//   * sample(lon, lat)                  -> place an entity on the ground
//   * trackActive(...)                  -> keep it corrected as tiles refine
//   * queuePending(...)                 -> resolve a miss once geometry loads
//   * tryResolvePending() / invalidateForUnload(e) are driven from the
//     renderer's onTileChanged callback.
//
// Camera controls (orbit + fly/WASD) come from ../shared/camera-controls.js.
// The HUD sliders tune the tile budget (softTileLimit), the LOD threshold
// (maximumScreenSpaceError) and the fly speed.
//
// Credentials come from the URL (?key= for Google, or
// ?provider=cesium-ion&token=&asset= for Cesium ion), from localStorage if
// previously saved, or from the on-page form.

(function () {
    'use strict';

    // ---- Scene constants -------------------------------------------------
    // Patras, Greece -- full Google Photorealistic 3D Tiles coverage.
    const ORIGIN = { lon: 21.7346, lat: 38.2466, alt: 0 };

    const WALKER_COUNT = 12;
    const WALKER_AREA_M = 80;     // walkers stay within this radius of the origin
    const WALKER_SPEED_M = 3;     // metres per second
    const WALKER_SIZE_M = 4;      // walker side length (a metre-cube scaled to this)
    const WALKER_LIFT_M = 2;      // raise walkers this far above the sampled ground
                                  // (= WALKER_SIZE_M / 2 so the box bottom sits on the ground)
    // Horizontal move that retriggers a ground sample. Between samples a walker
    // holds its last height, so this bounds how far it can clip into a building
    // edge before re-snapping. 1 m roughly matches GroundSampler's cache cell.
    const GROUND_RESAMPLE_M = 1;

    // Metres-per-degree at the origin latitude (small-area flat approximation).
    const M_PER_DEG_LAT = 111320;
    const M_PER_DEG_LON = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);

    // ---- DOM -------------------------------------------------------------
    const statusLabel = document.getElementById('status');
    const tileCountLabel = document.getElementById('tile-count');
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
        // terratile reference-frame transform: it maps the tiles' raw "tile-Y"
        // geometry into the local frame (metres, +X east, +Y up, -Z north,
        // origin at ORIGIN). Everything else -- camera, walkers -- lives in
        // that local frame directly, parented to app.root.
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

        // ---- Ground sampler ---------------------------------------------
        const groundSampler = new terratile.GroundSampler({
            tilesRoot,
            getFrame: () => frame
        });

        // ---- Tile streaming ---------------------------------------------
        // terratile.playcanvas.TileRenderer is the full pipeline: worker GLB
        // decode, a device-sized resident cache, atomic refinement and the
        // dither cross-fade. It owns load/show/hide/fade internally; we only
        // hook onTileChanged to keep the ground sampler and the HUD count in
        // sync. Lighting is disabled on tiles by default (imagery is baked-lit).
        const shownTiles = new Set();
        const tileRenderer = new terratile.playcanvas.TileRenderer({
            app,
            parent: tilesRoot,
            castShadows: false,
            workers: {
                draco: { jsUrl: 'draco.wasm.js', wasmUrl: 'draco.wasm.wasm' }
            },
            onTileChanged(change) {
                const { type, entity } = change;
                if (type === 'show') {
                    shownTiles.add(entity);
                    // New visible geometry: resolve walkers waiting on it.
                    groundSampler.tryResolvePending();
                } else if (type === 'hide' || type === 'unload') {
                    shownTiles.delete(entity);
                    // Drop heights tied to this tile before it leaves the view
                    // so walkers re-snap to fresh geometry.
                    if (entity) groundSampler.invalidateForUnload(entity);
                }
                setTileCount(shownTiles.size);
            }
        });

        // ---- Walkers -----------------------------------------------------
        // Each walker lives in geodetic space (lon/lat) and random-walks; its
        // local XZ comes from geodeticToLocal and its Y from the GroundSampler.
        // Walkers are parented to app.root -- i.e. the local frame directly --
        // NOT to tilesRoot, whose transform is for the tiles' tile-Y geometry.
        const walkerMaterial = new pc.StandardMaterial();
        walkerMaterial.diffuse = new pc.Color(1.0, 0.55, 0.1);
        walkerMaterial.emissive = new pc.Color(1.0, 0.55, 0.1);
        walkerMaterial.update();

        const walkers = [];
        for (let i = 0; i < WALKER_COUNT; i++) {
            const entity = new pc.Entity(`walker-${i}`);
            entity.addComponent('render', { type: 'box', material: walkerMaterial });
            entity.setLocalScale(WALKER_SIZE_M, WALKER_SIZE_M, WALKER_SIZE_M);
            app.root.addChild(entity);

            const angle = Math.random() * Math.PI * 2;
            const radius = Math.random() * WALKER_AREA_M;
            walkers.push({
                id: `walker-${i}`,
                entity,
                lon: ORIGIN.lon + (Math.cos(angle) * radius) / M_PER_DEG_LON,
                lat: ORIGIN.lat + (Math.sin(angle) * radius) / M_PER_DEG_LAT,
                heading: Math.random() * Math.PI * 2,
                groundY: WALKER_LIFT_M,        // last resolved local Y (+ lift)
                lastSampleLon: null,
                lastSampleLat: null
            });
        }

        const snapWalker = (w) => {
            const g = groundSampler.sample(w.lon, w.lat);
            if (g.method !== 'miss') {
                w.groundY = g.alt + WALKER_LIFT_M;
                groundSampler.trackActive(w.id, w.lon, w.lat, g.volume, g.inst, (newAlt) => {
                    w.groundY = newAlt + WALKER_LIFT_M;
                });
            } else {
                groundSampler.queuePending(w.id, w.lon, w.lat, (localY) => {
                    w.groundY = localY + WALKER_LIFT_M;
                });
            }
            w.lastSampleLon = w.lon;
            w.lastSampleLat = w.lat;
        };

        const updateWalkers = (dt) => {
            for (const w of walkers) {
                // Random-walk: nudge the heading, step forward.
                w.heading += (Math.random() - 0.5) * dt * 2;
                const stepLat = (Math.cos(w.heading) * WALKER_SPEED_M * dt) / M_PER_DEG_LAT;
                const stepLon = (Math.sin(w.heading) * WALKER_SPEED_M * dt) / M_PER_DEG_LON;
                w.lon += stepLon;
                w.lat += stepLat;

                // Turn back toward the origin if it wandered out of the area.
                const offE = (w.lon - ORIGIN.lon) * M_PER_DEG_LON;
                const offN = (w.lat - ORIGIN.lat) * M_PER_DEG_LAT;
                if (Math.hypot(offE, offN) > WALKER_AREA_M) {
                    w.heading = Math.atan2(-offE, -offN);
                }

                // Re-sample the ground only after a meaningful horizontal move.
                let resample = w.lastSampleLon === null;
                if (!resample) {
                    const dE = (w.lon - w.lastSampleLon) * M_PER_DEG_LON;
                    const dN = (w.lat - w.lastSampleLat) * M_PER_DEG_LAT;
                    if (Math.hypot(dE, dN) > GROUND_RESAMPLE_M) resample = true;
                }
                if (resample) snapWalker(w);

                const p = terratile.geodeticToLocal(frame, { lon: w.lon, lat: w.lat, alt: 0 });
                w.entity.setLocalPosition(p.x, w.groundY, p.z);
                w.entity.setLocalEulerAngles(0, -w.heading * 180 / Math.PI, 0);
            }
        };

        // ---- Run ---------------------------------------------------------
        setStatus('Resolving tileset...');
        const source = cfg.provider === 'cesium-ion'
            ? new terratile.CesiumIonTilesetSource(cfg.token, cfg.asset)
            : new terratile.GoogleTilesetSource(cfg.key);
        const tileManager = new terratile.TileManager(source, tileRenderer);
        tileManager.globeMode = false;
        tileManager.setLocalFrame({ origin: ORIGIN });

        // Stability tuning to match a production viewer: drive streaming every
        // frame, pin off the frame-time SSE bias (no LOD pulsing), and allow
        // the atomic same-frame switch (TileRenderer marks tiles render-ready
        // only after warm-up). refinementMode/transitionMode/maxFallbackSseFactor
        // now default to the smooth atomic + dither behaviour.
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

        // Streaming lock: when checked, terratile's selection pass is skipped,
        // so no new tiles load and none unload. In-flight fetches still land.
        tileManager.streamingPaused = streamPausedEl.checked;
        streamPausedEl.addEventListener('change', () => {
            tileManager.streamingPaused = streamPausedEl.checked;
        });

        tileManager.start().then(() => {
            setStatus('Viewer ready - walkers tracking the ground.');
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
            updateWalkers(dt);
        });
    }
})();
