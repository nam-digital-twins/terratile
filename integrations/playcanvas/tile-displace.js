// Per-fragment cutouts ("hole punching") for 3D-Tiles GLBs rendered through
// terratile. Tile fragments inside any registered zone are discarded, leaving
// a clean hole -- typically so a co-located higher-fidelity scan (a gsplat or
// GLB landmark) can show through. Zones come in two shapes:
//
//   * circular zones  - an infinite-Y cylinder: centre XZ + radius in metres.
//   * polygon zones   - an infinite-Y prism: a list of XZ vertices.
//
// Exposed as terratile.TileDisplacer.
//
// `pc` and `terratile` are provided as globals (see eslint.config.mjs); this
// file is loaded as a plain <script>, after the PlayCanvas engine and the
// terratile UMD bundle.
//
// This module ships the hole only -- loading and placing the replacement scan
// is ordinary PlayCanvas asset code and is left to the application.
//
// PlayCanvas-version coupling: this relies on the `litUserDeclarationPS` /
// `litUserMainEndPS` shader-chunk hooks, which are specific to PlayCanvas
// 2.17.x. TileClipper uses the same hooks -- applying both to the same
// mesh-instance does not compose; whichever `apply()` runs last wins for that
// material.
(function () {
    if (typeof pc === 'undefined') throw new Error('tile-displace: pc is not loaded');
    if (typeof terratile === 'undefined') throw new Error('tile-displace: terratile is not loaded');

    // Default caps. The shader test is unrolled (one inline test per circle
    // slot, and per polygon-zone edge) because PlayCanvas 2.17.x does not
    // reliably bind chunk-declared array uniforms; individual uniforms bind
    // fine. Raise via the constructor options.
    const DEFAULT_MAX_ZONES = 8;        // circular zones
    const DEFAULT_MAX_POLY_ZONES = 4;   // polygon zones
    const DEFAULT_MAX_POLY_VERTS = 8;   // vertices per polygon zone

    // Build the unrolled cutout test as a GLSL string: discard the fragment if
    // it falls inside any circular zone OR any polygon zone.
    function buildBody(maxZones, maxPolyZones, maxPolyVerts) {
        let out = `
        {
            vec4 _lp = uTileDispInvWorld * vec4(vPositionW, 1.0);
            vec2 _pXZ = _lp.xz;
`;
        // Circular zones.
        out += `
            if (uDispCount > 0) {
                vec4 _z;
`;
        for (let i = 0; i < maxZones; i++) {
            out += `
                if (${i} < uDispCount) {
                    _z = uDisp${i};
                    if (length(_pXZ - _z.xy) < _z.z) discard;
                }
`;
        }
        out += `
            }
`;
        // Polygon zones -- crossing-number point-in-polygon, discard if inside.
        for (let p = 0; p < maxPolyZones; p++) {
            out += `
            if (uDispPolyCount${p} >= 3) {
                bool _inP${p} = false;
                vec2 _vi, _vj;
`;
            for (let v = 0; v < maxPolyVerts; v++) {
                const j = (v + maxPolyVerts - 1) % maxPolyVerts;
                out += `
                _vi = uDispPoly${p}_${v}; _vj = uDispPoly${p}_${j};
                if ((_vi.y > _pXZ.y) != (_vj.y > _pXZ.y) &&
                    _pXZ.x < (_vj.x - _vi.x) * (_pXZ.y - _vi.y) / (_vj.y - _vi.y) + _vi.x)
                    _inP${p} = !_inP${p};
`;
            }
            out += `
                if (_inP${p}) discard;
            }
`;
        }
        out += `
        }
`;
        return out;
    }

    function collectRenderComponents(entity) {
        if (typeof entity.findComponents === 'function') return entity.findComponents('render');
        const out = [];
        const walk = (node) => {
            if (node.render) out.push(node.render);
            for (const child of node.children) walk(child);
        };
        walk(entity);
        return out;
    }

    /**
     * Punches holes in the visible 3D tiles by discarding fragments inside
     * registered cutout zones -- circular and/or polygonal -- in a cloned,
     * chunk-injected material.
     *
     * Typical use: `addZone(...)` / `addPolygonZone(...)` / `removeZone(...)`
     * to manage zones, `apply(entity)` on every tile as it loads,
     * `updateFrame(node)` once per frame, and `remove(entity)` when cutouts
     * are turned off.
     *
     * Attached to the global as `terratile.TileDisplacer`.
     */
    class TileDisplacer {
        /**
         * @param {object} opts - Constructor options.
         * @param {object} opts.app - The PlayCanvas application (`pc.Application`).
         * @param {number} [opts.maxZones] - Upper bound on circular zones
         * (default 8). The shader is unrolled to this many circle tests.
         * @param {number} [opts.maxPolyZones] - Upper bound on polygon zones
         * (default 4).
         * @param {number} [opts.maxPolyVerts] - Upper bound on vertices per
         * polygon zone (default 8).
         */
        constructor({
            app,
            maxZones = DEFAULT_MAX_ZONES,
            maxPolyZones = DEFAULT_MAX_POLY_ZONES,
            maxPolyVerts = DEFAULT_MAX_POLY_VERTS
        } = {}) {
            if (!app) throw new Error('TileDisplacer: app is required');
            this._app = app;
            this._maxZones = maxZones;
            this._maxPolyZones = maxPolyZones;
            this._maxPolyVerts = maxPolyVerts;
            this._matCache = new WeakMap();   // origMat -> cloned displaced material
            this._circleZones = new Map();    // id -> { x, z, radius, feather }
            this._polyZones = new Map();      // id -> [{ x, z }, ...]
            this._scratch = new pc.Mat4();
            this._inv = new pc.Mat4();
        }

        _makeMaterial(origMat) {
            const cm = origMat.clone();
            // Individual uniforms rather than chunk-declared arrays, which do
            // not bind reliably in PC 2.17.x.
            let decls = 'uniform mat4 uTileDispInvWorld;\nuniform int uDispCount;\n';
            for (let i = 0; i < this._maxZones; i++) decls += `uniform vec4 uDisp${i};\n`;
            for (let p = 0; p < this._maxPolyZones; p++) {
                decls += `uniform int uDispPolyCount${p};\n`;
                for (let v = 0; v < this._maxPolyVerts; v++) {
                    decls += `uniform vec2 uDispPoly${p}_${v};\n`;
                }
            }
            cm.shaderChunks.glsl.set('litUserDeclarationPS', decls);
            cm.shaderChunks.glsl.set('litUserMainEndPS',
                buildBody(this._maxZones, this._maxPolyZones, this._maxPolyVerts));
            cm.update();
            return cm;
        }

        _getMaterial(origMat) {
            let cm = this._matCache.get(origMat);
            if (!cm) {
                cm = this._makeMaterial(origMat);
                this._matCache.set(origMat, cm);
            }
            return cm;
        }

        _pushUniforms() {
            const scope = this._app.graphicsDevice.scope;

            // Circular zones.
            const circles = [...this._circleZones.values()];
            const cn = Math.min(circles.length, this._maxZones);
            for (let i = 0; i < cn; i++) {
                const z = circles[i];
                // .xy = centre XZ, .z = radiusM, .w = featherM (reserved).
                scope.resolve(`uDisp${i}`).setValue([z.x, z.z, z.radius, z.feather]);
            }
            for (let i = cn; i < this._maxZones; i++) {
                scope.resolve(`uDisp${i}`).setValue([0, 0, 0, 0]);
            }
            scope.resolve('uDispCount').setValue(cn);

            // Polygon zones. Unused vertex slots are padded with the first
            // vertex so the extra edges are degenerate and never cross.
            const polys = [...this._polyZones.values()];
            const pn = Math.min(polys.length, this._maxPolyZones);
            for (let p = 0; p < this._maxPolyZones; p++) {
                const verts = p < pn ? polys[p] : null;
                const vn = verts ? Math.min(verts.length, this._maxPolyVerts) : 0;
                const pad = vn > 0 ? verts[0] : { x: 0, z: 0 };
                for (let v = 0; v < this._maxPolyVerts; v++) {
                    const src = v < vn ? verts[v] : pad;
                    scope.resolve(`uDispPoly${p}_${v}`).setValue([src.x, src.z]);
                }
                scope.resolve(`uDispPolyCount${p}`).setValue(vn);
            }
        }

        /**
         * Register (or replace) a circular cutout zone, given a centre already
         * projected into the displacer's XZ space.
         *
         * @param {*} id - The caller's zone id (used to remove it later).
         * @param {{x: number, z: number}} centerXZ - Zone centre in the XZ space
         * that `updateFrame(node)`'s node maps world fragments back into.
         * @param {number} radiusM - Zone radius in metres.
         * @param {number} [featherM] - Reserved soft-edge width in metres.
         */
        addZone(id, centerXZ, radiusM, featherM = 0) {
            if (!Number.isFinite(radiusM) || radiusM <= 0) {
                console.warn('TileDisplacer.addZone: bad radiusM', radiusM, 'for', id);
                return;
            }
            this._circleZones.set(id, {
                x: centerXZ.x,
                z: centerXZ.z,
                radius: radiusM,
                feather: Number.isFinite(featherM) ? featherM : 0
            });
            if (this._circleZones.size > this._maxZones) {
                console.warn(`TileDisplacer: ${this._circleZones.size} circular zones registered, only the first ${this._maxZones} are bound`);
            }
            this._pushUniforms();
        }

        /**
         * Register a circular cutout zone from a geodetic centre, projecting it
         * into the given terratile local frame. Convenience wrapper over
         * `addZone`.
         *
         * @param {*} id - The caller's zone id.
         * @param {object} frame - A terratile local frame (from `createLocalFrame`).
         * @param {{lon: number, lat: number}} lonLat - Zone centre, WGS84 degrees.
         * @param {number} radiusM - Zone radius in metres.
         * @param {number} [featherM] - Reserved soft-edge width in metres.
         */
        addZoneGeodetic(id, frame, lonLat, radiusM, featherM = 0) {
            const local = terratile.geodeticToLocal(frame, { lon: lonLat.lon, lat: lonLat.lat, alt: 0 });
            this.addZone(id, { x: local.x, z: local.z }, radiusM, featherM);
        }

        /**
         * Register (or replace) a polygonal cutout zone. The polygon is an
         * infinite-Y prism: fragments whose XZ falls inside the polygon are
         * discarded. The ring need not be closed (no repeated final vertex).
         *
         * @param {*} id - The caller's zone id (used to remove it later).
         * @param {{x: number, z: number}[]} polyXZ - Polygon vertices in the XZ
         * space that `updateFrame(node)`'s node maps world fragments back
         * into. Needs at least 3; capped at the constructor's `maxPolyVerts`.
         */
        addPolygonZone(id, polyXZ) {
            if (!Array.isArray(polyXZ) || polyXZ.length < 3) {
                console.warn('TileDisplacer.addPolygonZone: need at least 3 vertices for', id);
                return;
            }
            let verts = polyXZ;
            if (verts.length > this._maxPolyVerts) {
                console.warn(`TileDisplacer: polygon zone '${id}' has ${verts.length} vertices, only the first ${this._maxPolyVerts} are used`);
                verts = verts.slice(0, this._maxPolyVerts);
            }
            this._polyZones.set(id, verts.map(v => ({ x: v.x, z: v.z })));
            if (this._polyZones.size > this._maxPolyZones) {
                console.warn(`TileDisplacer: ${this._polyZones.size} polygon zones registered, only the first ${this._maxPolyZones} are bound`);
            }
            this._pushUniforms();
        }

        /**
         * Remove a previously registered zone -- circular or polygonal.
         *
         * @param {*} id - The zone id passed to `addZone` / `addZoneGeodetic` /
         * `addPolygonZone`.
         */
        removeZone(id) {
            let changed = false;
            if (this._circleZones.delete(id)) changed = true;
            if (this._polyZones.delete(id)) changed = true;
            if (changed) this._pushUniforms();
        }

        /**
         * Swap a tile entity's materials for cutout clones. Call on each tile
         * as it loads, and on all loaded tiles when the first zone is added.
         *
         * @param {object} entity - The tile entity.
         */
        apply(entity) {
            if (!entity) return;
            for (const rc of collectRenderComponents(entity)) {
                if (!rc.meshInstances) continue;
                for (const mi of rc.meshInstances) {
                    if (mi._tileDispOriginal) continue;
                    mi._tileDispOriginal = mi.material;
                    if (mi.material && mi.material.clone) mi.material = this._getMaterial(mi.material);
                }
            }
        }

        /**
         * Restore a tile entity's original (uncut) materials.
         *
         * @param {object} entity - The tile entity.
         */
        remove(entity) {
            if (!entity) return;
            for (const rc of collectRenderComponents(entity)) {
                if (!rc.meshInstances) continue;
                for (const mi of rc.meshInstances) {
                    const orig = mi._tileDispOriginal;
                    if (!orig) continue;
                    mi.material = orig;
                    delete mi._tileDispOriginal;
                }
            }
        }

        /**
         * Push the inverse world transform of `node` so the shader can map
         * world-space fragment positions back into the zones' XZ space. Call
         * once per frame while any zone is active. For an AR "miniature" scene
         * pass the miniature root; for a plain scene pass the tiles root (or
         * any node whose local space the zones live in).
         *
         * @param {object} node - The node whose inverse world transform defines
         * the zone coordinate space.
         */
        updateFrame(node) {
            this._scratch.copy(node.getWorldTransform());
            this._inv.copy(this._scratch).invert();
            this._app.graphicsDevice.scope.resolve('uTileDispInvWorld').setValue(this._inv.data);
        }

        /**
         * @returns {boolean} true if at least one cutout zone is registered.
         */
        isActive() {
            return this._circleZones.size > 0 || this._polyZones.size > 0;
        }

        /**
         * @returns {number} The total number of registered cutout zones
         * (circular + polygonal).
         */
        zoneCount() {
            return this._circleZones.size + this._polyZones.size;
        }
    }

    terratile.TileDisplacer = TileDisplacer;
})();
