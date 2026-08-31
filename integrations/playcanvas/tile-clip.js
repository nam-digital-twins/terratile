// Per-fragment polygon clipping for 3D-Tiles GLBs rendered through terratile.
// Clones each tile's StandardMaterial and injects a fragment-shader discard
// test against a polygon: fragments outside the polygon are discarded, giving
// a smooth crop edge even on tiles that straddle the polygon boundary.
//
// Exposed as terratile.TileClipper.
//
// `pc` and `terratile` are provided as globals (see eslint.config.mjs); this
// file is loaded as a plain <script>, after the PlayCanvas engine and the
// terratile UMD bundle.
//
// PlayCanvas-version coupling: this relies on the `litUserDeclarationPS` /
// `litUserMainEndPS` shader-chunk hooks, which are specific to PlayCanvas
// 2.17.x. TileDisplacer uses the same hooks -- applying both to the same
// mesh-instance does not compose; whichever `apply()` runs last wins for that
// material. In practice a scene-boundary crop and interior cutouts rarely
// share a tile.
(function () {
    if (typeof pc === 'undefined') throw new Error('tile-clip: pc is not loaded');
    if (typeof terratile === 'undefined') throw new Error('tile-clip: terratile is not loaded');

    // Default upper bound on polygon vertices. The shader test is unrolled
    // (one inline edge test per vertex) because PlayCanvas 2.17.x does not
    // reliably bind `vec2 arr[N]` chunk-declared array uniforms; individual
    // vec2 uniforms bind fine. Raise via the constructor `maxVerts` option.
    const DEFAULT_MAX_VERTS = 8;

    // Build the unrolled crossing-number point-in-polygon test as a GLSL
    // string -- one inline edge test per vertex, written out because GLSL has
    // no first-class XOR-assign.
    function buildEdgeTests(n) {
        let out = '';
        for (let i = 0; i < n; i++) {
            const j = (i + n - 1) % n;
            out += `
            _vi = uPoly${i}; _vj = uPoly${j};
            if ((_vi.y > _pXZ.y) != (_vj.y > _pXZ.y) &&
                _pXZ.x < (_vj.x - _vi.x) * (_pXZ.y - _vi.y) / (_vj.y - _vi.y) + _vi.x)
                _inside = !_inside;
            `;
        }
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
     * Crops the visible 3D-tile area to a polygon by discarding out-of-polygon
     * fragments in a cloned, chunk-injected material. Unlike whole-tile region
     * culling, this produces a smooth edge on boundary tiles.
     *
     * Typical use: `setPolygon(polyXZ)` once (and whenever the polygon moves),
     * `apply(entity)` on every tile as it loads, `updateFrame(node)` once per
     * frame, and `remove(entity)` when clipping is turned off.
     *
     * Attached to the global as `terratile.TileClipper`.
     */
    class TileClipper {
        /**
         * @param {object} opts - Constructor options.
         * @param {object} opts.app - The PlayCanvas application (`pc.Application`).
         * @param {number} [opts.maxVerts] - Upper bound on polygon vertices
         * (default 8). The shader is unrolled to this many edge tests.
         */
        constructor({ app, maxVerts = DEFAULT_MAX_VERTS } = {}) {
            if (!app) throw new Error('TileClipper: app is required');
            this._app = app;
            this._maxVerts = maxVerts;
            this._matCache = new WeakMap();   // origMat -> cloned clipped material
            this._count = 0;                  // active polygon vertex count
            this._holeRadius = 0;             // 0 = no circular hole (donut off)
            this._scratch = new pc.Mat4();
            this._inv = new pc.Mat4();
            // Initialise the hole uniforms so materials read a definite value
            // even before setHole() is ever called.
            const scope = app.graphicsDevice.scope;
            scope.resolve('uTileClipHoleCenter').setValue([0, 0]);
            scope.resolve('uTileClipHoleRadius').setValue(0);
        }

        _makeMaterial(origMat) {
            const cm = origMat.clone();
            // Individual vec2 uniforms (uPoly0..uPolyN-1) rather than a
            // chunk-declared array, which does not bind reliably in PC 2.17.x.
            let decls = 'uniform mat4 uTileClipInvWorld;\nuniform int uPolyCount;\n' +
                'uniform vec2 uTileClipHoleCenter;\nuniform float uTileClipHoleRadius;\n';
            for (let i = 0; i < this._maxVerts; i++) decls += `uniform vec2 uPoly${i};\n`;
            cm.shaderChunks.glsl.set('litUserDeclarationPS', decls);
            // End-of-main discard: map the world-space fragment back into the
            // polygon's XZ space, then run the crossing-number test.
            cm.shaderChunks.glsl.set('litUserMainEndPS', `
        {
            vec4 _lp = uTileClipInvWorld * vec4(vPositionW, 1.0);
            vec2 _pXZ = _lp.xz;
            if (uPolyCount >= 3) {
                bool _inside = false;
                vec2 _vi, _vj;
                ${buildEdgeTests(this._maxVerts)}
                if (!_inside) discard;
            }
            // Optional circular hole: discard fragments inside it, turning the
            // polygon crop into a donut. Disabled when the radius is 0.
            if (uTileClipHoleRadius > 0.0) {
                vec2 _hd = _pXZ - uTileClipHoleCenter;
                if (dot(_hd, _hd) < uTileClipHoleRadius * uTileClipHoleRadius) discard;
            }
        }
            `);
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

        /**
         * Set (or replace) the clip polygon. Vertices are in the same XZ space
         * that `updateFrame(node)`'s node maps world fragments back into. Pass
         * fewer than 3 vertices to disable clipping.
         *
         * @param {{x: number, z: number}[]} polyXZ - Polygon vertices.
         */
        setPolygon(polyXZ) {
            const scope = this._app.graphicsDevice.scope;
            const n = Math.min(polyXZ.length, this._maxVerts);
            for (let i = 0; i < n; i++) {
                scope.resolve(`uPoly${i}`).setValue([polyXZ[i].x, polyXZ[i].z]);
            }
            // Pad unused slots with the first vertex so the extra edges are
            // degenerate and contribute zero ray-crossings.
            const pad = n > 0 ? polyXZ[0] : { x: 0, z: 0 };
            for (let i = n; i < this._maxVerts; i++) {
                scope.resolve(`uPoly${i}`).setValue([pad.x, pad.z]);
            }
            this._count = n;
            scope.resolve('uPolyCount').setValue(n);
        }

        /**
         * Punch a circular hole out of the crop, turning the polygon crop into
         * a donut: fragments inside this circle are discarded in addition to
         * those outside the polygon. The center is in the same XZ space as the
         * polygon. Pass a radius of 0 or less (or call `clearHole`) to remove it.
         *
         * @param {{x: number, z: number, radius: number}} hole - Hole center and radius.
         */
        setHole({ x, z, radius }) {
            const scope = this._app.graphicsDevice.scope;
            const r = Math.max(0, radius || 0);
            scope.resolve('uTileClipHoleCenter').setValue([x, z]);
            scope.resolve('uTileClipHoleRadius').setValue(r);
            this._holeRadius = r;
        }

        /** Remove the circular hole (revert the donut to a solid polygon crop). */
        clearHole() {
            this._app.graphicsDevice.scope.resolve('uTileClipHoleRadius').setValue(0);
            this._holeRadius = 0;
        }

        /**
         * Swap a tile entity's materials for clipped clones. Call on each tile
         * as it loads, and on all loaded tiles when clipping first turns on.
         *
         * @param {object} entity - The tile entity.
         */
        apply(entity) {
            if (!entity) return;
            for (const rc of collectRenderComponents(entity)) {
                if (!rc.meshInstances) continue;
                for (const mi of rc.meshInstances) {
                    if (mi._tileClipOriginal) continue;
                    mi._tileClipOriginal = mi.material;
                    if (mi.material && mi.material.clone) mi.material = this._getMaterial(mi.material);
                }
            }
        }

        /**
         * Restore a tile entity's original (unclipped) materials.
         *
         * @param {object} entity - The tile entity.
         */
        remove(entity) {
            if (!entity) return;
            for (const rc of collectRenderComponents(entity)) {
                if (!rc.meshInstances) continue;
                for (const mi of rc.meshInstances) {
                    const orig = mi._tileClipOriginal;
                    if (!orig) continue;
                    mi.material = orig;
                    delete mi._tileClipOriginal;
                }
            }
        }

        /**
         * Push the inverse world transform of `node` so the shader can map
         * world-space fragment positions back into the polygon's XZ space.
         * Call once per frame while clipping is active. For an AR "miniature"
         * scene pass the miniature root; for a plain scene pass the tiles root
         * (or any node whose local space the polygon lives in).
         *
         * @param {object} node - The node whose inverse world transform defines
         * the polygon coordinate space.
         */
        updateFrame(node) {
            this._scratch.copy(node.getWorldTransform());
            this._inv.copy(this._scratch).invert();
            this._app.graphicsDevice.scope.resolve('uTileClipInvWorld').setValue(this._inv.data);
        }

        /**
         * @returns {boolean} true if a polygon of 3 or more vertices is set.
         */
        isActive() {
            return this._count >= 3;
        }
    }

    terratile.TileClipper = TileClipper;
})();
