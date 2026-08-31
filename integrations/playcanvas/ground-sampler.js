// Ground-height sampler for 3D Tiles rendered through terratile + PlayCanvas.
// Exposed as terratile.GroundSampler on the global object.
// `pc` and `terratile` are provided as globals (see eslint.config.mjs); this
// file is loaded as a plain <script>, after the PlayCanvas engine and the
// terratile UMD bundle.
(function () {
    if (typeof pc === 'undefined') throw new Error('ground-sampler: pc is not loaded');
    if (typeof terratile === 'undefined') throw new Error('ground-sampler: terratile is not loaded');

    const PROBE_ALT_M = 2000;
    const CACHE_CELL_DEG = 1e-5;
    const PENDING_DEBOUNCE_MS = 250;
    // Reject hits whose meshInstance AABB is larger than this — coarse root
    // tiles cover ~1000 km (volume ~10^18) and give ground estimates hundreds
    // of metres off. Leaf tiles at city scale are 10–200 m (volume ~10^3–10^7).
    // 10^9 m^3 (cube of ~1 km) lets mid-LOD tiles through while excluding
    // regional/globe roots. Misses are queued and retried on each tile load.
    const MAX_HIT_AABB_VOLUME = 1e9;

    const _probe = new pc.Vec3();
    const _below = new pc.Vec3();
    const _down = new pc.Vec3();
    const _v0 = new pc.Vec3();
    const _v1 = new pc.Vec3();
    const _v2 = new pc.Vec3();
    const _edge1 = new pc.Vec3();
    const _edge2 = new pc.Vec3();
    const _pvec = new pc.Vec3();
    const _tvec = new pc.Vec3();
    const _qvec = new pc.Vec3();
    const _tmpMat = new pc.Mat4();
    const _localDir = new pc.Vec3();
    const _localRay = new pc.Ray();
    // Extracted triangle data per pc.Mesh. mesh.getPositions/getIndices copy
    // the full vertex/index buffers into fresh JS arrays on EVERY call;
    // caching the copy once makes repeat probes over the same mesh ~free.
    // Keyed weakly so entries die with their mesh when a tile unloads.
    const _meshDataCache = new WeakMap(); // pc.Mesh -> { positions, indices, triCount }

    function cacheKey(lon, lat) {
        const k = 1 / CACHE_CELL_DEG;
        return `${Math.round(lon * k)}_${Math.round(lat * k)}`;
    }

    // Möller–Trumbore ray-triangle intersection.
    // Returns distance t along ray.direction (>= 0) or -1 if no hit.
    function rayTriangle(ray, a, b, c) {
        _edge1.sub2(b, a);
        _edge2.sub2(c, a);
        _pvec.cross(ray.direction, _edge2);
        const det = _edge1.dot(_pvec);
        if (det > -1e-8 && det < 1e-8) return -1;
        const invDet = 1 / det;
        _tvec.sub2(ray.origin, a);
        const u = _tvec.dot(_pvec) * invDet;
        if (u < 0 || u > 1) return -1;
        _qvec.cross(_tvec, _edge1);
        const v = ray.direction.dot(_qvec) * invDet;
        if (v < 0 || u + v > 1) return -1;
        const t = _edge2.dot(_qvec) * invDet;
        return t >= 0 ? t : -1;
    }

    function transformPoint(m, src, dst) {
        const d = m.data;
        const x = src.x, y = src.y, z = src.z;
        dst.x = d[0] * x + d[4] * y + d[8] * z + d[12];
        dst.y = d[1] * x + d[5] * y + d[9] * z + d[13];
        dst.z = d[2] * x + d[6] * y + d[10] * z + d[14];
        return dst;
    }

    // True if the mesh-instance is still rendered in the current scene: its
    // visible flag is set AND every ancestor entity in the graph is enabled.
    // We avoid pc Entity#enabledInHierarchy because, per the comment on
    // collectVisibleTileRenderComponents below, it has been observed to lie
    // in some PC versions for descendants of a tile root whose enabled was
    // toggled. This walk mirrors that filter exactly.
    function instAlive(inst) {
        if (!inst || !inst.visible) return false;
        let n = inst.node;
        if (!n) return false;
        while (n) {
            if (!n.enabled) return false;
            n = n.parent;
        }
        return true;
    }

    function collectRenderComponents(entity, out) {
        if (!entity) return out;
        if (entity.render) out.push(entity.render);
        const children = entity.children;
        if (children) {
            for (let i = 0; i < children.length; i++) {
                collectRenderComponents(children[i], out);
            }
        }
        return out;
    }

    // Collect render components only from tile-entity roots (direct children
    // of tilesRoot) that are currently enabled. PlayCanvas' "hide" toggles
    // `entity.enabled` on the tile root; descendant render-component entities
    // keep `enabled=true` locally but report `enabledInHierarchy=false` —
    // which is unreliable in some PC versions, so we filter at the tile root
    // explicitly.
    function collectVisibleTileRenderComponents(tilesRoot, out) {
        const tileRoots = tilesRoot.children;
        if (!tileRoots) return out;
        for (let i = 0; i < tileRoots.length; i++) {
            const tr = tileRoots[i];
            if (!tr || !tr.enabled) continue;
            collectRenderComponents(tr, out);
        }
        return out;
    }

    /**
     * Samples ground height under a geodetic point by raycasting the loaded
     * 3D-Tiles meshes, with a lifetime-aware cache so results follow LOD
     * changes instead of going stale.
     *
     * Typical use: call `sample(lon, lat)` to place an entity on the ground,
     * `trackActive(...)` to keep it corrected as tiles refine or evict, and
     * wire `tryResolvePending()` into tile-load and `invalidateForUnload(entity)`
     * into tile-unload events.
     *
     * Attached to the global as `terratile.GroundSampler`.
     */
    class GroundSampler {
        /**
         * @param {object} opts - Constructor options.
         * @param {object} opts.tilesRoot - The entity whose children are the
         * loaded tile roots (the meshes to raycast against).
         * @param {Function} opts.getFrame - Returns the current terratile local
         * frame (from `createLocalFrame`), or a falsy value if not ready yet.
         */
        constructor({ tilesRoot, getFrame }) {
            if (!tilesRoot) throw new Error('GroundSampler: tilesRoot is required');
            if (typeof getFrame !== 'function') throw new Error('GroundSampler: getFrame must be a function');
            this._tilesRoot = tilesRoot;
            this._getFrame = getFrame;
            this._cache = new Map();   // key -> { alt, volume, inst }
            this._pending = new Map(); // id -> { lon, lat, onResolve }
            this._active = new Map();  // id -> { lon, lat, volume, inst, onResolve }
            this._lastResolveMs = 0;
        }

        /**
         * Number of sample requests still waiting for geometry to stream in.
         *
         * @returns {number} The pending request count.
         */
        get pendingCount() {
            return this._pending.size;
        }

        /**
         * Drop every cached ground height. Subsequent `sample()` calls re-probe.
         */
        clearCache() {
            this._cache.clear();
        }

        /**
         * Stop tracking an entity -- call on despawn so its pending and active
         * entries are released.
         *
         * @param {*} id - The caller's entity id used with `trackActive` / `queuePending`.
         */
        forget(id) {
            this._pending.delete(id);
            this._active.delete(id);
        }

        /**
         * Queue a sample whose geometry has not streamed in yet. `onResolve` is
         * called with the local-space Y once a later `tryResolvePending()` call
         * finds a hit at this location.
         *
         * @param {*} id - The caller's entity id.
         * @param {number} lon - Longitude in degrees.
         * @param {number} lat - Latitude in degrees.
         * @param {Function} onResolve - Called with the resolved local Y (number).
         */
        queuePending(id, lon, lat, onResolve) {
            this._pending.set(id, { lon, lat, onResolve });
        }

        /**
         * Record a successful sample so `tryResolvePending()` can detect when
         * the mesh that produced it leaves the scene (LRU eviction, LOD
         * coarsening) and re-probe against the current geometry. Without this,
         * an entity stays glued to a stale altitude after its tile unloads,
         * producing the float/sink drift this sampler is designed to avoid.
         *
         * @param {*} id - The caller's entity id.
         * @param {number} lon - Longitude in degrees.
         * @param {number} lat - Latitude in degrees.
         * @param {number} volume - World-AABB volume of the mesh the hit came from.
         * @param {object} inst - The mesh instance the hit came from.
         * @param {Function} onResolve - Called with the corrected local Y (number)
         * when the tracked mesh is replaced by fresher geometry.
         */
        trackActive(id, lon, lat, volume, inst, onResolve) {
            this._active.set(id, { lon, lat, volume, inst, onResolve });
        }

        /**
         * Drop cached and active entries whose hit came from a mesh-instance
         * inside `entity`. Call from the tile unload/hide handlers so stale
         * altitudes do not survive the tile that produced them; schedules a
         * debounced re-resolve so affected entities snap to current geometry.
         *
         * @param {object} entity - The tile entity being unloaded or hidden.
         */
        invalidateForUnload(entity) {
            if (!entity) return;
            const comps = [];
            collectRenderComponents(entity, comps);
            if (comps.length === 0) return;
            const instSet = new Set();
            for (let i = 0; i < comps.length; i++) {
                const mis = comps[i].meshInstances;
                if (!mis) continue;
                for (let mi = 0; mi < mis.length; mi++) {
                    if (mis[mi]) instSet.add(mis[mi]);
                }
            }
            if (instSet.size === 0) return;

            let evicted = 0;
            for (const [key, entry] of this._cache) {
                if (instSet.has(entry.inst)) {
                    this._cache.delete(key);
                    evicted++;
                }
            }
            let marked = 0;
            for (const entry of this._active.values()) {
                if (instSet.has(entry.inst)) {
                    entry.inst = null;
                    marked++;
                }
            }
            if (evicted || marked) {
                // Fire a debounced resolve so the next frame's vehicle
                // updates pick up corrected altitudes without waiting for
                // an unrelated tile load.
                this.tryResolvePending();
            }
        }

        /**
         * Sample the ground height under a geodetic point. Returns a cached hit
         * when one is available and its source mesh is still rendered; otherwise
         * raycasts the loaded tiles and caches the result.
         *
         * @param {number} lon - Longitude in degrees.
         * @param {number} lat - Latitude in degrees.
         * @returns {{alt: (number|null), method: string, volume?: number, inst?: object}}
         * `alt` is the local-space Y of the ground (null on a miss); `method`
         * is `'cache'`, `'mesh'`, or `'miss'`; on a hit, `volume` and `inst`
         * describe the mesh the hit came from.
         */
        sample(lon, lat) {
            const key = cacheKey(lon, lat);
            const cached = this._cache.get(key);
            if (cached !== undefined) {
                // Belt-and-braces: if the inst that produced this cached alt
                // is no longer rendered, evict and re-probe. Catches edge
                // cases where invalidateForUnload was not plumbed (manual
                // entity destruction, hidden-LRU paths, etc.).
                if (instAlive(cached.inst)) {
                    return { alt: cached.alt, method: 'cache', volume: cached.volume, inst: cached.inst };
                }
                this._cache.delete(key);
            }
            const r = this._rawSample(lon, lat);
            if (r.method === 'mesh') {
                this._cache.set(key, { alt: r.alt, volume: r.volume, inst: r.inst });
            }
            return r;
        }

        // Raycast against currently-loaded 3D-Tiles meshes without touching
        // the cache. Used by sample() (which then caches the result) and by
        // the active-resolve pass, which needs a fresh probe to compare LOD
        // against the cached value -- bypassing the cache short-circuit.
        _rawSample(lon, lat) {
            const frame = this._getFrame();
            if (!frame) return { alt: null, method: 'miss' };

            const probeG = terratile.geodeticToLocal(frame, { lon, lat, alt: PROBE_ALT_M });
            const belowG = terratile.geodeticToLocal(frame, { lon, lat, alt: 0 });
            _probe.set(probeG.x, probeG.y, probeG.z);
            _below.set(belowG.x, belowG.y, belowG.z);
            _down.sub2(_below, _probe).normalize();

            const ray = new pc.Ray(_probe, _down);

            const comps = [];
            collectVisibleTileRenderComponents(this._tilesRoot, comps);

            // Collect per-mesh best hits. Among all hitting meshes we later
            // pick the one with the smallest world AABB -- that corresponds
            // to the finest LOD still loaded at this location, which is the
            // best ground estimate.
            const hits = [];
            for (let ci = 0; ci < comps.length; ci++) {
                const rc = comps[ci];
                if (!rc.enabled) continue;
                const mis = rc.meshInstances;
                if (!mis) continue;
                for (let mi = 0; mi < mis.length; mi++) {
                    const inst = mis[mi];
                    if (!inst || !inst.visible) continue;
                    const aabb = inst.aabb;
                    if (!aabb || !aabb.intersectsRay(ray)) continue;

                    // Cheap coarse-tile reject before the expensive per-triangle
                    // scan below: a hit on a large/root-tile AABB would be
                    // discarded by the volume filter anyway, so skip
                    // extracting/testing its mesh entirely.
                    const he = aabb.halfExtents;
                    const volume = he.x * he.y * he.z;
                    if (volume > MAX_HIT_AABB_VOLUME) continue;

                    const mesh = inst.mesh;
                    if (!mesh) continue;
                    let data = _meshDataCache.get(mesh);
                    if (!data) {
                        const positions = [];
                        const vcount = mesh.getPositions(positions);
                        if (!vcount) continue;
                        const indices = [];
                        mesh.getIndices(indices);
                        data = {
                            positions: Float32Array.from(positions),
                            indices: indices.length ? Uint32Array.from(indices) : null,
                            triCount: indices.length ? (indices.length / 3) | 0 : (vcount / 3) | 0
                        };
                        _meshDataCache.set(mesh, data);
                    }

                    // Cast in mesh-local space: one matrix inverse per mesh
                    // instead of three point transforms per triangle. The
                    // direction is deliberately NOT renormalized -- an affine
                    // map preserves the ray parameter t, so the hitY math
                    // below can keep using t against the world-space ray.
                    _tmpMat.copy(inst.node.getWorldTransform()).invert();
                    transformPoint(_tmpMat, _probe, _localRay.origin);
                    const md = _tmpMat.data;
                    _localDir.set(
                        md[0] * _down.x + md[4] * _down.y + md[8] * _down.z,
                        md[1] * _down.x + md[5] * _down.y + md[9] * _down.z,
                        md[2] * _down.x + md[6] * _down.y + md[10] * _down.z
                    );
                    _localRay.direction.copy(_localDir);

                    const pos = data.positions;
                    const idx = data.indices;
                    let localTMin = Infinity;
                    for (let t = 0; t < data.triCount; t++) {
                        let ia, ib, ic;
                        if (idx) {
                            ia = idx[t * 3];
                            ib = idx[t * 3 + 1];
                            ic = idx[t * 3 + 2];
                        } else {
                            ia = t * 3;
                            ib = t * 3 + 1;
                            ic = t * 3 + 2;
                        }
                        _v0.set(pos[ia * 3], pos[ia * 3 + 1], pos[ia * 3 + 2]);
                        _v1.set(pos[ib * 3], pos[ib * 3 + 1], pos[ib * 3 + 2]);
                        _v2.set(pos[ic * 3], pos[ic * 3 + 1], pos[ic * 3 + 2]);

                        const tt = rayTriangle(_localRay, _v0, _v1, _v2);
                        if (tt >= 0 && tt < localTMin) localTMin = tt;
                    }
                    if (localTMin !== Infinity) {
                        hits.push({ inst, t: localTMin, volume });
                    }
                }
            }

            if (hits.length === 0) return { alt: null, method: 'miss' };

            // Prefer finest LOD (smallest AABB volume).
            hits.sort((a, b) => a.volume - b.volume);
            const chosen = hits[0];

            const hitY = _probe.y + _down.y * chosen.t;
            return { alt: hitY, method: 'mesh', volume: chosen.volume, inst: chosen.inst };
        }

        /**
         * Resolve queued and tracked samples against the currently-loaded
         * geometry: re-probes pending misses, and re-probes active entries
         * whose tracked mesh-instance has left the scene. Internally debounced
         * (250 ms), so it is cheap to call on every tile load/unload.
         */
        tryResolvePending() {
            const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            if (now - this._lastResolveMs < PENDING_DEBOUNCE_MS) return;
            this._lastResolveMs = now;

            // 1. Resolve outright misses by re-sampling. sample() will cache
            // any new hit and we promote the entry to _active so subsequent
            // mesh churn re-probes it.
            if (this._pending.size > 0) {
                const resolved = [];
                for (const [id, entry] of this._pending) {
                    const r = this.sample(entry.lon, entry.lat);
                    if (r.method !== 'miss') {
                        try {
                            entry.onResolve(r.alt);
                        } catch (e) { /* swallow */ }
                        this.trackActive(id, entry.lon, entry.lat, r.volume, r.inst, entry.onResolve);
                        resolved.push(id);
                    }
                }
                for (let i = 0; i < resolved.length; i++) {
                    this._pending.delete(resolved[i]);
                }
            }

            // 2. Re-probe active entries whose tracked mesh-instance has
            // left the scene (tile unload, LOD coarsening, LRU eviction).
            // If the inst is still rendered, the ground under that vehicle
            // has not moved -- skip the raycast entirely. This keeps
            // stationary vehicles ~free in steady state; only LOD churn
            // pays for raycasts.
            if (this._active.size > 0) {
                for (const [id, entry] of this._active) {
                    if (instAlive(entry.inst)) continue;
                    const r = this._rawSample(entry.lon, entry.lat);
                    if (r.method !== 'mesh') {
                        // Old mesh gone, no replacement loaded yet. Move
                        // the entry back into _pending so the next tile
                        // load re-tries.
                        this._pending.set(id, { lon: entry.lon, lat: entry.lat, onResolve: entry.onResolve });
                        this._active.delete(id);
                        continue;
                    }
                    const key = cacheKey(entry.lon, entry.lat);
                    this._cache.set(key, { alt: r.alt, volume: r.volume, inst: r.inst });
                    entry.volume = r.volume;
                    entry.inst = r.inst;
                    try {
                        entry.onResolve(r.alt);
                    } catch (e) { /* swallow */ }
                }
            }
        }

        // --- Re-probe API used by the viewer's per-frame scheduler ----------
        // Per-id / budgeted entry points over the same single-ray logic
        // tryResolvePending() runs on tile events, so a quiet (rarely-updated,
        // camera-still) vehicle re-snaps over time instead of staying glued to
        // a stale altitude.

        /**
         * True when id's height is stale and a re-sample would help: it is
         * queued pending, or its tracked mesh-instance has left the scene. A
         * vehicle still sitting on a live tile returns false and costs nothing,
         * so the scheduler skips it in steady state.
         *
         * @param {*} id - The caller's entity id.
         * @returns {boolean} Whether a re-sample of this id is worthwhile.
         */
        needsResample(id) {
            if (this._pending.has(id)) return true;
            const e = this._active.get(id);
            if (!e) return false;
            return !instAlive(e.inst);
        }

        /**
         * Single-entry re-probe (tryResolvePending step 2 for one id). On a
         * miss the entry is demoted to _pending and the caller keeps its
         * last-good Y -- we never reset to the published altitude. On a hit the
         * cache + entry are updated and `onResolve` is called.
         *
         * @param {*} id - The caller's entity id.
         * @param {boolean} [force] - When true (default false), raycast even if the
         * tracked mesh is still rendered. Used by the viewer's periodic
         * time-based re-sample so a stationary asset that snapped to early or
         * coarse geometry re-checks against whatever is loaded now. A transient
         * forced miss while the tracked mesh is still alive keeps the last-good
         * Y instead of demoting to pending.
         * @returns {boolean} True if a raycast was spent (so the caller can
         * budget it); false when the tracked mesh is still rendered and `force`
         * is not set (the cheap steady-state path), or the id is not active.
         */
        reprobeActive(id, force = false) {
            const entry = this._active.get(id);
            if (!entry) return false;
            const alive = instAlive(entry.inst);
            if (!force && alive) return false;
            const r = this._rawSample(entry.lon, entry.lat);
            if (r.method !== 'mesh') {
                if (alive) return true;
                this._pending.set(id, { lon: entry.lon, lat: entry.lat, onResolve: entry.onResolve });
                this._active.delete(id);
                return true;
            }
            const key = cacheKey(entry.lon, entry.lat);
            this._cache.set(key, { alt: r.alt, volume: r.volume, inst: r.inst });
            entry.volume = r.volume;
            entry.inst = r.inst;
            try {
                entry.onResolve(r.alt);
            } catch (e) { /* swallow */ }
            return true;
        }

        /**
         * Drain up to `maxRays` pending misses by re-sampling (tryResolvePending
         * step 1, budgeted). Promotes hits to _active. Optional `shouldSkip(id)`
         * lets the caller defer off-screen ids so on-screen spawn-misses resolve
         * first.
         *
         * @param {number} maxRays - Max raycasts to spend this call.
         * @param {Function} [shouldSkip] - Returns true to defer an id.
         * @returns {number} The number of raycasts used.
         */
        drainPending(maxRays, shouldSkip) {
            if (maxRays <= 0 || this._pending.size === 0) return 0;
            let used = 0;
            const resolved = [];
            for (const [id, entry] of this._pending) {
                if (used >= maxRays) break;
                if (shouldSkip && shouldSkip(id)) continue;
                const r = this.sample(entry.lon, entry.lat);
                used++;
                if (r.method !== 'miss') {
                    try {
                        entry.onResolve(r.alt);
                    } catch (e) { /* swallow */ }
                    this.trackActive(id, entry.lon, entry.lat, r.volume, r.inst, entry.onResolve);
                    resolved.push(id);
                }
            }
            for (let i = 0; i < resolved.length; i++) this._pending.delete(resolved[i]);
            return used;
        }
    }

    terratile.GroundSampler = GroundSampler;
})();
