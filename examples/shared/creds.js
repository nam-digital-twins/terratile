// Shared credential resolution for the terratile examples.
//
// Resolves a tile-provider config from (in order):
//
//   1. URL params -- `?key=...` for Google, or
//      `?provider=cesium-ion&token=...&asset=...` for Cesium ion.
//   2. localStorage key `terratile.cred` -- auto-start with the saved config.
//   3. The on-page form.
//
// Whichever source resolves, the credential is written back to localStorage
// so the next page load (and the sibling example at the same origin) picks
// it up. A "Forget credential" button (optional) clears the stored value and
// reloads.
//
// All localStorage reads/writes are guarded so the form still works in
// private-mode browsers where access throws.
//
// Exposes `window.terratileExamples.resolveCredentials(opts)`.
//
//   terratileExamples.resolveCredentials({
//       form, providerSelect, googleKey, cesiumToken, cesiumAsset,
//       forgetButton,                   // optional
//       onResolved: (cfg) => start(cfg) // called once credentials are available
//   });
//
// `cfg` shape:
//   { provider: 'google',     key: string }
//   { provider: 'cesium-ion', token: string, asset: number }

(function () {
    const STORAGE_KEY = 'terratile.cred';
    const DEFAULT_ASSET = 2275207; // Cesium ion's Google Photorealistic 3D Tiles

    function safeRead() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (e) { /* localStorage may be disabled or storage full */ }
        return null;
    }

    function safeWrite(cfg) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
    }

    function safeClear() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    }

    function fromURLParams() {
        const p = new URLSearchParams(location.search);
        if (p.get('provider') === 'cesium-ion' && p.get('token')) {
            return {
                provider: 'cesium-ion',
                token: p.get('token'),
                asset: Number(p.get('asset')) || DEFAULT_ASSET
            };
        }
        if (p.get('key')) {
            return { provider: 'google', key: p.get('key') };
        }
        return null;
    }

    function fromForm({ providerSelect, googleKey, cesiumToken, cesiumAsset }) {
        if (providerSelect.value === 'cesium-ion') {
            const token = cesiumToken.value.trim();
            if (!token) return null;
            return {
                provider: 'cesium-ion',
                token,
                asset: Number(cesiumAsset.value) || DEFAULT_ASSET
            };
        }
        const key = googleKey.value.trim();
        if (!key) return null;
        return { provider: 'google', key };
    }

    function isValid(cfg) {
        if (!cfg || typeof cfg !== 'object') return false;
        if (cfg.provider === 'google') return typeof cfg.key === 'string' && cfg.key.length > 0;
        if (cfg.provider === 'cesium-ion') return typeof cfg.token === 'string' && cfg.token.length > 0;
        return false;
    }

    function resolveCredentials({
        form,
        providerSelect,
        googleKey,
        cesiumToken,
        cesiumAsset,
        forgetButton,
        onResolved
    }) {
        // Wire the "Forget" button regardless of which path resolved the
        // credential, so the user can always reset (e.g. to switch providers
        // or rotate a key) without devtools.
        if (forgetButton) {
            forgetButton.addEventListener('click', () => {
                safeClear();
                location.reload();
            });
        }

        // 1. URL params win.
        let cfg = fromURLParams();

        // 2. Fall back to localStorage.
        if (!cfg) {
            const stored = safeRead();
            if (isValid(stored)) cfg = stored;
        }

        if (cfg) {
            form.style.display = 'none';
            safeWrite(cfg);
            onResolved(cfg);
            return;
        }

        // 3. Otherwise show the form. Toggle which credential fields are
        // visible to match the selected provider.
        const syncFields = () => {
            const isCesium = providerSelect.value === 'cesium-ion';
            googleKey.style.display = isCesium ? 'none' : '';
            cesiumToken.style.display = isCesium ? '' : 'none';
            cesiumAsset.style.display = isCesium ? '' : 'none';
        };
        providerSelect.addEventListener('change', syncFields);
        syncFields();

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const submitted = fromForm({ providerSelect, googleKey, cesiumToken, cesiumAsset });
            if (!submitted) return;
            form.style.display = 'none';
            safeWrite(submitted);
            onResolved(submitted);
        });
    }

    window.terratileExamples = window.terratileExamples || {};
    window.terratileExamples.resolveCredentials = resolveCredentials;
})();
