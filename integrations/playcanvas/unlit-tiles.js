// Force `useLighting = false` on all materials in a tile entity subtree. Tile
// imagery is already baked-lit (it's satellite photogrammetry); running PBR
// over it adds substantial fragment-shader cost with no visible gain. The
// usual win is several ms/frame off the tile draw pass on integrated GPUs.
//
// Mutates materials in place rather than cloning. Many mesh-instances share
// materials within and across tiles; mutating once propagates to all users.
// Idempotent: skips materials already flagged `useLighting = false`.
//
// Exposed as terratile.disableTileLighting.
//
// `pc` and `terratile` are provided as globals (see eslint.config.mjs); this
// file is loaded as a plain <script>, after the PlayCanvas engine and the
// terratile UMD bundle.
//
// Typical use: call it inside the tile load handler, on the entity returned by
// `pc.Asset.resource.instantiateRenderEntity()`, before adding it to the scene.

(function () {
    if (typeof terratile === 'undefined') throw new Error('unlit-tiles: terratile is not loaded');

    function collectRenderComponents(entity) {
        if (typeof entity.findComponents === 'function') return entity.findComponents('render');
        const out = [];
        const walk = (n) => {
            if (n.render) out.push(n.render);
            for (const c of n.children) walk(c);
        };
        walk(entity);
        return out;
    }

    /**
     * Flip `useLighting = false` on every StandardMaterial under `entity`.
     *
     * @param {object} entity - The tile root entity (or any subtree).
     */
    function disableTileLighting(entity) {
        if (!entity) return;
        for (const rc of collectRenderComponents(entity)) {
            const mis = rc.meshInstances;
            if (!mis) continue;
            for (const mi of mis) {
                const mat = mi.material;
                if (!mat) continue;
                if (mat.useLighting !== false) {
                    mat.useLighting = false;
                    mat.update();
                }
            }
        }
    }

    terratile.disableTileLighting = disableTileLighting;
})();
