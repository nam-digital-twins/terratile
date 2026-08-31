import { cartesianToGeodetic } from './geodetic.mjs';
import { length } from './math.mjs';
import { createLocalFrame } from './reference-frame.mjs';
import { GoogleTilesetSource } from './sources.mjs';
import { StreamingStats, TILE_LOAD_STAGES } from './streaming-stats.mjs';
import { TileCache } from './tile-cache.mjs';

const REQUEST_CLASS_BONUS = Object.freeze({
    frontier: 8,
    visible: 4,
    predicted: 2,
    coverage: 0,
    speculative: -2
});

const REQUEST_CLASS_RANK = Object.freeze({
    speculative: 0,
    coverage: 1,
    predicted: 2,
    visible: 3,
    frontier: 4
});

const IDENTITY_ROOT_TRANSFORM = Object.freeze({
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1]
});

/**
 * Manager class for {@link https://github.com/CesiumGS/3d-tiles/tree/main/specification#readme 3D Tiles},
 * an open standard for streaming massive heterogeneous 3D geospatial datasets.
 */
class TileManager {
    source;

    handlers;

    /** Optional TileCache-compatible byte source used by core fetches. */
    byteCache = null;

    /** Streaming lifecycle, queue and timing telemetry. */
    streamingStats = new StreamingStats();

    expandedNodes = new Set();

    /** @type {Map<string, boolean>} */
    contentHidden = new Map();

    /** @type {Array<{polygon: number[][], mode: string, opacity: number, _bbox: object}>} */
    regions = [];

    maximumScreenSpaceError = 24;

    /**
     * Soft cap on the number of loaded GLB tiles. When non-null and the current
     * loaded count exceeds this, the effective screen-space-error threshold is
     * gradually ratcheted up, causing the refine gate to collapse excess LOD.
     * Ratchets back down toward `maximumScreenSpaceError` once the count falls
     * below the cap. `null` disables the mechanism (default).
     * @type {number|null}
     */
    softTileLimit = null;

    /**
     * Distance weight in the eviction score. When `softTileLimit` is
     * exceeded, candidates (non-selected, non-pinned loaded tiles) are
     * scored as `notSelectedFrames + evictionDistanceWeight * dist`
     * where `dist` is the tile-Y distance from the camera to the tile's
     * bounding-volume center. Higher score = evict first.
     *
     * Default `0.01` means 100 m of distance is worth one "frame point",
     * so a tile last needed 1 frame ago at 5 km is scored 51, while a
     * tile last needed 1 frame ago at 50 m is scored ~1.5 -- the far
     * tile is evicted first. Set to `0` for pure age-LRU (legacy).
     * @type {number}
     */
    evictionDistanceWeight = 0.01;

    /**
     * Threshold (as a multiplier of `softTileLimit`) above which the
     * adaptive `_sseBias` ramp engages, coarsening the selected LOD to
     * relieve sustained memory pressure. Eviction always runs at 1.0x;
     * this knob only governs when LOD itself starts collapsing.
     *
     * Default `1.3` means the bias only engages once the loaded count
     * sits 30% above the soft cap, so transient overshoots during
     * pan/zoom transitions don't degrade visual quality -- eviction
     * handles the temporary excess silently while the LOD stays sharp.
     * Set to `1.0` (or close) to engage immediately on any overshoot.
     * @type {number}
     */
    sseBiasOvershootFactor = 1.3;

    /**
     * Threshold (as a multiplier of `softTileLimit`) above which the
     * eviction loop fires. When triggered, eviction still drops the
     * count back to `softTileLimit` so the cap has real meaning -- but
     * between triggers the count is free to swell up to this factor.
     *
     * Default `1.3` lets utilization spike to 30% above the cap during
     * transitions (so new tiles can land without waiting for the slow
     * unload of stale ones); eviction catches up in the frame where the
     * threshold is crossed. Set to `1.0` for strict-cap behaviour
     * (eviction every frame the count is over budget).
     * @type {number}
     */
    evictionOvershootFactor = 1.3;

    /**
     * Target frame time (ms) the adaptive SSE controller aims for. When
     * the smoothed actual frame time sustainedly exceeds 1.5x this value,
     * `_adaptiveBias` ramps up so the selection picks coarser tiles and
     * frame time recovers. When it drops below 1.1x, the bias decays.
     * Default `16` = 60 fps target. Set higher (e.g. 33 for 30 fps) on
     * devices that cap the refresh rate.
     * @type {number}
     */
    targetFrameMs = 16;

    /**
     * Cap on `_adaptiveBias`. Frame-time-driven LOD coarsening will not
     * exceed this multiplier on `maximumScreenSpaceError`, no matter how
     * slow the frame gets. Default `3` lets sustained slow frames coarsen
     * the target LOD up to 3x so the picture stays interactive under load
     * (the same mechanism CesiumJS and Google's SDK use to keep pans
     * smooth). Set to `1` to disable frame-time coarsening entirely, so
     * LOD is a stable function of camera distance and never pulses
     * (already-loaded tiles are not collapsed when a load burst briefly
     * spikes frame time).
     * @type {number}
     */
    adaptiveSseBiasMax = 3;

    /**
     * Weight of the motion-alignment bonus in the request-priority sum.
     * Tiles whose direction-from-camera aligns with the camera velocity
     * vector get `weight * align` extra priority (`align` in [0..1]).
     * Default `0.5` is roughly half of the ssePart component, so motion
     * bias matters but doesn't dominate target-SSE selection. Set to `0`
     * to disable predictive preloading.
     * @type {number}
     */
    priorityMotionWeight = 0.5;

    /** Enable velocity/forward extrapolation for out-of-view prefetch. */
    predictivePrefetch = true;

    /** Camera speed below which predictive prefetch is disabled. */
    predictiveMinSpeed = 2;

    /** Seconds of camera motion used for the predictive look-ahead point. */
    predictiveLookAheadSeconds = 1.5;

    /** Coarser-than-visible SSE target used inside the predicted corridor. */
    predictiveSseFactor = 1.75;

    /** Minimum alignment cosine for a node to enter the predicted corridor. */
    predictiveConeCosine = 0.25;

    /** Coarse SSE target for tiles behind both view and travel directions. */
    behindCameraSseFactor = 8;

    /** Metadata-known descendant levels permitted to stream ahead of display. */
    speculativeDescendantDepth = 1;

    /** Maximum new speculative descendant requests generated per traversal. */
    maxSpeculativeRequestsPerFrame = 8;

    /** Number of speculative requests generated by the previous traversal. */
    _lastSpeculativeRequestCount = 0;

    /**
     * Weight of the closeness (`1 / (1 + dist*1e-4)`) bonus in the
     * request-priority sum. Default `0.3` boosts near-camera tiles over
     * far-camera tiles of the same SSE class. Set to `0` to ignore
     * distance in priority (foveation still applies).
     * @type {number}
     */
    priorityClosenessWeight = 0.3;

    /**
     * Maximum number of NEW `loadContent` calls dispatched per frame.
     * Already-in-flight loads continue independently. Default `16` means
     * a burst of newly-selected tiles spreads across multiple frames
     * (rather than all firing at once and drowning the next frame's
     * higher-priority requests). Set very high (e.g. 1024) to recover
     * the original "fire everything" behaviour.
     * @type {number}
     */
    maxNewRequestsPerFrame = 16;

    /**
     * Frames to keep a just-deselected tile visible before hiding it.
     * Default `1`: a coarse parent stays visible one extra frame after its
     * finer children join the selection, covering the children's first-draw
     * GPU upload / shader-compile cost so refinement never flashes a hole.
     * The cost is a one-frame parent/child overlap in which near-coplanar
     * surfaces can z-fight. Set to `0` for an atomic same-frame switch --
     * safe when the viewer guarantees tiles are GPU-resident before their
     * `load` handler resolves (e.g. by prewarming textures in a budgeted
     * instantiation queue). Higher values extend the overlap window.
     * @type {number}
     */
    deferredHideFrames = 1;

    /**
     * Monotonic count of selection-churn events: a tile re-shown within 60
     * frames of being selection-hidden (perceived as flicker). Telemetry
     * only -- read it periodically and diff to get a rate. Never resets.
     * @type {number}
     */
    _oscillationCount = 0;

    /**
     * Refinement display strategy at the frontier (a refining tile that has
     * renderable content of its own).
     *
     * `'legacy'`: partially-streamed refinement shows the ready
     * pieces immediately, with holes where the missing ones will land.
     *
     * `'wave'`: the frontier tile keeps covering its area while its
     * replacement set streams in, then swaps -- no transitional holes.
     * Guard rails (each disarms a failure mode observed in earlier
     * attempts): the hold is COOLDOWN-GATED per tile (no re-hold within
     * `waveReholdCooldownFrames` of last showing finer coverage -- kills
     * re-hold flapping while still allowing hole-free revisits after the
     * fine children were evicted), TIME-BOUNDED (`waveHoldMaxFrames`, and
     * an expired hold disqualifies the tile permanently), requires at least one
     * genuinely finer ready replacement piece (fallback-cover noise cannot
     * trigger it), never fires for tiles without content of their own
     * (skip-LOD intermediates stay transparent), and permanently-failed
     * tiles count as covered-as-hole so they cannot wedge a hold. Held-back
     * ready descendants are eviction-immune while the hold lasts, so the
     * pending set grows monotonically to the swap point.
     * `'atomic'` (default): strict REPLACE refinement. A renderable parent remains the
     * sole coverage for its area until the first renderable frontier below
     * each direct child (walking transparently through `.json` wrappers) is
     * ready. The whole frontier swaps in together, one tree level per frame.
     * Ready frontier tiles and the visible ancestor chain are eviction-immune
     * while the transition is active. Unlike `wave`, atomic mode never times
     * out to a partial set with holes.
     * `'mixed'`: progressive skip-LOD selection. Ready descendants render
     * immediately while the nearest ready parent fills missing regions. Hosts
     * can implement `setMixed`/`clearMixed` to mask coarse pixels already
     * covered by deeper tiles (for example with a selection-depth stencil).
     *
     * @type {'legacy'|'wave'|'atomic'|'mixed'}
     */
    refinementMode = 'atomic';

    /** Number of renderable parents held by strict atomic refinement last frame. */
    _lastAtomicHoldCount = 0;

    /** Number of partial subtrees that could produce visible coverage gaps last frame. */
    _lastCoverageGapCount = 0;

    /** Number of direct replacement-frontier nodes awaited last frame. */
    _lastRefinementTargetCount = 0;

    /**
     * Parent/children handover after atomic coverage becomes ready. Default
     * `'dither'` cross-fades the swap over `transitionFrames`; `'instant'`
     * swaps in a single frame. `'dither'` requires the host to implement
     * `setFade`/`setMixed`; without them it degrades to an instant swap.
     */
    transitionMode = 'dither';

    /** Number of traversal frames used by the complementary dither handover. */
    transitionFrames = 10;

    /** @type {Map<object, {startFrame:number, children:object[], seenFrame:number}>} */
    _activeTransitions = new Map();

    /** Number of active atomic handovers last frame. */
    _lastTransitionCount = 0;

    /** Nodes carrying host-side mixed-LOD stencil state from the last frame. */
    _mixedConfiguredNodes = new Set();

    /**
     * Upper bound, in traversal frames, on any single wave hold. On expiry
     * the tile falls back to legacy partial display permanently (fine
     * pieces + holes) rather than staying coarse. Bounds the worst case
     * "briefly coarser than legacy" window; holes can still appear after
     * expiry, exactly as in legacy.
     * @type {number}
     */
    waveHoldMaxFrames = 45;

    /**
     * Frames after a successful advance before the SAME tile may hold
     * again (e.g. its fine children were later evicted while it stayed
     * loaded, and the camera came back). Healthy areas get another
     * hole-free swap on revisit; the cooldown prevents rapid re-hold
     * flapping (the whole-area flicker failure mode). `0` = never re-hold
     * (strict first-time-only hysteresis). Note this only applies to tiles
     * whose hold RESOLVED -- a tile whose hold expired at
     * `waveHoldMaxFrames` is permanently legacy and never holds again, so
     * a stuck area cannot enter a hold/expire pulse loop.
     * @type {number}
     */
    waveReholdCooldownFrames = 600;

    /**
     * A tile may only wave-hold if its OWN screen-space error is within
     * `maximumScreenSpaceError * waveHoldMaxSseFactor` -- i.e. it is a true
     * refinement frontier a level or so above target, not a coarse
     * ancestor. Without this cap, a city-scale (or larger) tile that was
     * loaded during an earlier zoom can become hold-eligible again after
     * the re-hold cooldown, and its hold HIDES the entire fine subtree
     * beneath it while showing one giant blurry tile for up to
     * `waveHoldMaxFrames` -- per ancestor level. Default `3` (~1.5 LOD
     * levels above target).
     * @type {number}
     */
    waveHoldMaxSseFactor = 3;

    /** Size of the last frame's eviction-immune set (wave mode telemetry). */
    _lastImmuneCount = 0;

    _loadedGlbCount = 0;

    _sseBias = 1;

    /** EWMA frame time in ms; updated at the top of `updateLocal`. */
    _frameTimeMs = 16;

    /** Frame-time-driven SSE multiplier; combines with `_sseBias`. */
    _adaptiveBias = 1;

    /** `performance.now()` of the previous `updateLocal` call, or 0. */
    _lastUpdateMs = 0;

    /** Previous-frame camera position in local frame, or null on first call. */
    _prevCameraLocal = null;

    /** Camera velocity in m/s, expressed in local-frame coordinates. */
    _cameraVelocityLocal = [0, 0, 0];

    /** Camera velocity in m/s, expressed in tile-Y coordinates (set by `updateLocal`). */
    _cameraVelocityTileY = [0, 0, 0];

    /** Reused per-frame snapshot buffer to avoid Array.from allocation. */
    _expandedSnapshot = [];

    /** Per-frame cached `2 * tan(fovY / 2)`; set at the top of `_updateCore`. */
    _frameSseDenom = 0;

    // Camera forward unit vector in tile-Y space, populated by
    //  `updateLocal` when the caller passes it. Used by `_computePriority`
    //  to weight tiles near the screen center higher (foveation).
    _cameraForwardTileY = null;

    // Scratch pool for _selectSubtree's partial-refinement probe. Each
    //  pair is a reusable `{ selected: Set, ctx: object }`; the recursion
    //  pushes (by depth) and pops via _getChildScratch / _releaseChildScratch
    //  so hot-path allocations drop to zero after the first frame.
    _childScratchStack = [];

    _childScratchDepth = 0;

    /** Cached `cos(globeRadius * π / 180)` and its square; refreshed when `globeRadius` changes. */
    _cachedGlobeRadiusDeg = null;

    _cosGr = -1;

    _cosGr2 = 1;

    /**
     * When false, tiles whose bounding volume center falls outside a cone of
     * `globeRadius` degrees around the camera direction are skipped — preventing
     * continent-scale tiles on the far side of the Earth from being loaded.
     * Set to true to disable filtering and stream the full globe.
     * @type {boolean}
     */
    globeMode = true;

    /**
     * Half-angle in degrees (0–90) of the visibility cone used when `globeMode`
     * is false. Tiles whose center is more than this many degrees away from the
     * camera direction are not loaded. 10° ≈ 1100 km radius around the camera,
     * 90° keeps the full visible hemisphere.
     * @type {number}
     */
    globeRadius = 10;

    // Cap on in-flight tile fetches. 128 works well on Google's HTTP/2-backed
    // Photorealistic 3D Tiles API, so the default sits there -- higher
    // concurrency fills new visible area (and refills holes during refinement)
    // materially faster. Lower it if your provider rate-limits aggressively.
    maxConcurrentRequests = 128;

    /** Maximum asynchronous decode jobs admitted by the engine-neutral core. */
    maxConcurrentDecodes = 12;

    /** Soft backpressure threshold for downloaded bytes awaiting decode. */
    maxDownloadedBytes = 256 * 1024 * 1024;

    /** Soft backpressure threshold for decoded resources awaiting preparation. */
    maxDecodedBytes = 512 * 1024 * 1024;

    /**
     * Hard cap on active tile pipeline jobs across request, download, decode
     * and preparation. Byte limits alone do not bound queues of many small
     * tiles, so this protects frame time and heap usage independently of tile
     * payload size. Set to 0 for no job-count cap.
     */
    maxPipelineJobs = 256;

    /** Frames an unrequested pipeline job may remain before cancellation. */
    staleRequestFrames = 12;

    /**
     * Skip-LOD refinement depth. Each `_updateCore` expand pass normally refines
     * one LOD level per frame. When `maxSkipDepth > 1`, the pass also recurses
     * into already-expanded descendants and expands any tile that is still too
     * coarse — up to this many levels deeper per frame. This only helps tiles
     * whose `.children` arrays are already populated (e.g. from the root JSON
     * that inlines several levels of tree structure, or from prior loads).
     * Cap it: recursion here widens the working set dramatically per frame.
     * @type {number}
     */
    maxSkipDepth = 3;

    _activeRequests = 0;

    _requestQueue = [];

    _activeDecodes = 0;

    _decodeQueue = [];

    _downloadedBytes = 0;

    _decodedBytes = 0;

    _pipelineJobs = new Map();

    _capacityWaiters = [];

    /** @type {?object} Local reference frame from {@link module:terratile.createLocalFrame}, or null. */
    _localFrame = null;

    _started = false;

    // ── Selection-rebuild scaffolding ─────────────────────────────────────
    // The new architecture (see restructure_plan.md) rebuilds the set of
    // visible tiles from scratch every frame instead of mutating a live
    // state machine. Phase 1 lands the engine dark: `_select` is callable
    // and pure, but `_updateCore` still drives the old mutation path.

    /** Root tile node of the fetched tileset, stored after start(). */
    _root = null;

    // When true, `_updateCore` drives the selection-based pipeline instead
    // of the legacy expand/collapse state machine.
    useSelectionMode = true;

    // Selected-tile set from the previous frame; diff target for the
    // show/hide application step.
    _prevSelected = new Set();

    // Tiles that dropped out of selection and are scheduled to hide once
    // they have been unselected for `deferredHideFrames` frames (unless
    // selection picks them up again first). Delaying the hide lets a
    // freshly-shown replacement tile actually finish its first render pass
    // before its coarser parent disappears — prevents the hole on LOD
    // refinement. Map of node -> frame number it fell out of selection.
    _pendingHide = new Map();

    // All nodes whose GLB content is currently loaded and has a live
    // entity. Maintained by `loadContent` / `unloadContent`. Used by
    // selection-mode eviction to find candidates for unload.
    _loadedNodes = new Set();

    // frame number → `_notSelectedSince[node]` — maps each loaded node
    // that wasn't in the last selection pass to the frame number when it
    // first fell out. Nodes still not selected after `evictionGraceFrames`
    // are unloaded.
    _notSelectedSince = new Map();

    /** Monotonic frame counter driving selection-mode eviction. */
    _frameNumber = 0;

    // Pan debounce: a tile must have been in-view for at least this many
    // consecutive frames before we burn bandwidth on requesting it.
    // Prevents request storms during fast pans where tiles enter/exit
    // the frustum before loads could even finish. Cesium's equivalent is
    // `Cesium3DTile.isOnScreenLongEnough`. 2 frames ~= ≤ 34 ms at 60 fps.
    onScreenThresholdFrames = 2;

    // Ancestor-fallback coarseness cap. When a whole subtree has nothing
    // finer loaded yet, an ancestor tile is allowed to cover the gap only
    // if its screen space error is ≤ `maxFallbackSseFactor ×
    // maximumScreenSpaceError`. Higher = coarser ancestors are accepted,
    // so fewer transient holes during refinement at the cost of a briefly
    // blurry patch; lower = prefer a hole over a blurry flash. This may
    // exceed `maxPreloadSseFactor` (the fetch-ahead cap), in which case the
    // fallback relies on coarse tiles still resident from an earlier view
    // rather than ones proactively preloaded. Default 8: prefer a briefly
    // blurry coarse patch over a hole during refinement and fast pans.
    maxFallbackSseFactor = 8;

    // Skip-LOD preload cap. Intermediate `.glb` tiles walked by the
    // selection only get a proactive fetch request when their SSE is ≤
    // `maxPreloadSseFactor × maximumScreenSpaceError`. Coarser ancestors
    // are skipped — they'd burn bandwidth on tiles that are too coarse to
    // be useful fallbacks. Keeps the fetch queue focused on tiles close
    // to the target LOD plus one-to-two levels of fallback coverage.
    maxPreloadSseFactor = 3;

    /**
     * Out-of-FOV SSE multiplier. The selection walk no longer culls
     * out-of-frustum subtrees; instead it walks into them and refines
     * to a coarser target = `maximumScreenSpaceError * outOfFovSseFactor`.
     * Tiles in this omnidirectional ring get fetched (so a sudden camera
     * rotation finds them already loaded) but never enter `ctx.selected`
     * so they don't render. Default `4` is roughly two LOD levels coarser
     * than the in-FOV target. Set to `1` to load OOV at full quality
     * (very expensive); set very high (e.g. `1000`) to effectively
     * restore frustum culling for loading.
     * @type {number}
     */
    outOfFovSseFactor = 4;

    // Idle traversal throttle. The selection walk is cheap (sub-ms on a
    // ~2000-tile working set) but still free CPU when the camera isn't
    // moving. With `idleTraversalSkipFrames > 0`, `updateLocal()` skips the
    // selection pass on idle frames; a traversal is forced as soon as the
    // camera moves more than `idleTraversalMoveM` metres, so LOD stays
    // responsive to pan/zoom. Set `idleTraversalSkipFrames = 0` to disable.
    idleTraversalSkipFrames = 10;

    idleTraversalMoveM = 2;

    _framesSinceTraversal = 0;

    _lastTraversalPosLocal = [Infinity, Infinity, Infinity];

    // Streaming lock. When true, `updateLocal()` returns early -- no
    // selection, no new requests, no eviction. In-flight fetches still
    // resolve (their load handlers run normally) so what was already on the
    // way will land, but nothing new is started and the scene stops
    // reacting to camera motion. Useful for stabilising the view during
    // screenshots, video capture, AR stationary viewing, or any case where
    // boundary-tile churn at the cap edge is more distracting than missing
    // detail. Set `streamingPaused = false` to resume; the first unpaused
    // frame triggers a traversal regardless of the idle throttle.
    streamingPaused = false;

    // Eviction is memory-pressure-based (see _updateCoreSelection): tiles
    // stay loaded until we exceed `softTileLimit`, then we LRU-evict down
    // to the cap. No fixed time-based grace — that destroyed useful
    // fallback tiles before the user could pan back to them.

    // Rolling-window failure tracking for automatic session refresh. Any
    // non-abort load error pushes the current timestamp; when the count in
    // the last `_failureWindowMs` crosses `_failureThreshold`, the manager
    // auto-calls `refreshSession()`. Cooled down by `_refreshCooldownMs`
    // to prevent refresh loops if the refresh itself fails.
    _failureTimestamps = [];

    _failureThreshold = 5;

    _failureWindowMs = 10_000;

    _refreshCooldownMs = 30_000;

    _lastRefreshMs = 0;

    _refreshing = null;

    // Failed work must yield to the rest of the application without becoming
    // permanently poisoned. Transient network/parser/host-contention errors
    // retry automatically with bounded exponential backoff. Responses that
    // normally mean the content itself is absent enter a longer cooldown, but
    // are still probed again later so a provider-side repair can heal a live
    // viewer without requiring an SSE change or reload.
    retryBaseDelayMs = 500;

    retryMaxDelayMs = 8_000;

    permanentFailureRetryMs = 30_000;

    /**
     * Creates a new instance of the 3D map tile manager.
     *
     * @param {string|object} apiKey - Your Google Maps 3D Tiles API key or a custom tileset source.
     * @param {string|object} apiUrl - The base URL from where tiles data is loaded, or handlers when using a custom source.
     * @param {{load: Function, unload: Function, show: Function, hide: Function}} handlers - Engine-specific node handlers.
     */
    constructor(apiKey, apiUrl = 'https://tile.googleapis.com/', handlers = {}) {
        if (apiKey && typeof apiKey.getRootRequest === 'function' && typeof apiKey.resolveRequest === 'function') {
            this.source = apiKey;
            this.handlers = apiUrl || {};
        } else {
            this.source = new GoogleTilesetSource(apiKey, apiUrl);
            this.handlers = handlers;
        }
        this.byteCache = new TileCache({
            onEvent: (name, amount) => {
                const counter = {
                    l1Hits: 'cacheL1Hits',
                    l2Hits: 'cacheL2Hits',
                    misses: 'cacheMisses',
                    evictions: 'cacheEvictions',
                    failedWrites: 'cacheFailedWrites'
                }[name];
                if (counter) this.streamingStats.increment(counter, amount);
            }
        });
        const configuredWorkers = Number(this.handlers?.workerProfile?.dracoWorkers ?? 0) +
            Number(this.handlers?.workerProfile?.basisWorkers ?? 0);
        if (configuredWorkers > 0) {
            this.maxConcurrentDecodes = Math.min(24, Math.max(4, configuredWorkers));
        }
        this.handlers?.attachManager?.(this);
    }

    /**
     * Fetch a tile set JSON file.
     *
     * @param {{url: string, requestInit: RequestInit}|string} request - The request descriptor.
     * @returns {Promise<{json: object, url: string}>} The tile set data plus the resolved URL.
     */
    async fetchJson(request) {
        const descriptor = this._normalizeRequestDescriptor(request);
        const response = this.byteCache ?
            await this.byteCache.fetch(descriptor.url, descriptor.requestInit, {
                key: descriptor.cacheKey,
                cacheable: descriptor.cacheable,
                maxAgeMs: descriptor.maxAgeMs
            }) :
            await fetch(descriptor.url, descriptor.requestInit);

        // If the fetch was unsuccessful, throw an error with the server body
        // attached so the caller can log Google's actual message (e.g.
        // "INVALID_ARGUMENT" with a session-related detail).
        if (!response.ok) {
            let bodyText = '';
            try {
                bodyText = (await response.clone().text()).slice(0, 400);
            } catch { /* ignore */ }
            const err = new Error(`HTTP ${response.status} for ${descriptor.url} — ${bodyText}`);
            err.status = response.status;
            err.body = bodyText;
            throw err;
        }

        return {
            json: await response.json(),
            url: response.url || descriptor.url
        };
    }

    /**
     * Fetch a binary tile through the configured Terratile byte cache.
     * @param {{url: string, requestInit: RequestInit}|string} request - Request descriptor.
     * @returns {Promise<ArrayBuffer>} Complete response bytes.
     */
    async fetchBuffer(request) {
        const descriptor = this._normalizeRequestDescriptor(request);
        if (this.byteCache) {
            return this.byteCache.fetchBuffer(descriptor.url, descriptor.requestInit, {
                key: descriptor.cacheKey,
                cacheable: descriptor.cacheable,
                maxAgeMs: descriptor.maxAgeMs
            });
        }
        const response = await fetch(descriptor.url, descriptor.requestInit);
        if (!response.ok) {
            let bodyText = '';
            try {
                bodyText = (await response.clone().text()).slice(0, 400);
            } catch { /* best effort */ }
            const err = new Error(`HTTP ${response.status} for ${descriptor.url} — ${bodyText}`);
            err.status = response.status;
            err.body = bodyText;
            throw err;
        }
        return response.arrayBuffer();
    }

    _setLoadStage(node, stage) {
        node.__loadStage = stage ?? undefined;
        this.streamingStats.setStage(node, stage);
    }

    /**
     * Return the authoritative lifecycle stage for a tile node.
     * @param {object} node - Tile node to inspect.
     * @returns {string|null} Current lifecycle stage, or null when inactive.
     */
    getLoadStage(node) {
        return this.streamingStats.getStage(node);
    }

    /**
     * Return a detached snapshot of core and renderer streaming telemetry.
     * @returns {object} Streaming counters, gauges and timing percentiles.
     */
    getStreamingStats() {
        this.streamingStats.setGauge('activeNetwork', this._activeRequests);
        this.streamingStats.setGauge('queuedNetwork', this._requestQueue.length);
        this.streamingStats.setGauge('activeDecode', this._activeDecodes);
        this.streamingStats.setGauge('queuedDecode', this._decodeQueue.length);
        this.streamingStats.setGauge('downloadedBytes', this._downloadedBytes);
        this.streamingStats.setGauge('decodedBytes', this._decodedBytes);
        this.streamingStats.setGauge('pipelineJobs', this._pipelineJobs.size);
        this.streamingStats.setGauge('pipelineJobLimit', this.maxPipelineJobs);
        const renderer = typeof this.handlers.getStreamingStats === 'function' ?
            this.handlers.getStreamingStats() : null;
        if (renderer?.queues) {
            this.streamingStats.setGauge('queuedPrepare',
                (renderer.queues.activePrepare ?? 0) + (renderer.queues.queuedPrepare ?? 0));
            this.streamingStats.setGauge('residentCount', renderer.queues.residentCount ?? 0);
            this.streamingStats.setGauge('residentSourceBytes', renderer.queues.residentSourceBytes ?? 0);
            this.streamingStats.setGauge('residentGpuBytes', renderer.queues.residentGpuBytes ?? 0);
        }
        if (renderer?.workers) {
            this.streamingStats.setGauge('dracoWorkers', renderer.workers.draco ?? 0);
            this.streamingStats.setGauge('basisWorkers', renderer.workers.basis ?? 0);
        }
        const cache = this.byteCache?.snapshot?.() ?? null;
        return this.streamingStats.snapshot({
            ...(renderer ? { renderer } : {}),
            ...(cache ? { cache } : {})
        });
    }

    /**
     * Summarize whether the active camera view still has basemap-critical work.
     * Hosts can use this one generic signal to defer unrelated asset traffic
     * without understanding Terratile queues or refinement internals.
     * Readiness means that visible coverage exists without holes. Refinement,
     * transitions and queued detail may continue after the host is released.
     * @returns {{critical:boolean, ready:boolean, selectedCount:number,
     * criticalJobs:number, coverageGaps:number, atomicHolds:number}} Detached
     * basemap-priority state for the current camera view.
     */
    getBasemapPriorityState() {
        let criticalJobs = 0;
        for (const job of this._pipelineJobs.values()) {
            if ((REQUEST_CLASS_RANK[job.requestClass] ?? 0) >= REQUEST_CLASS_RANK.visible) {
                criticalJobs++;
            }
        }
        const selectedCount = this._prevSelected.size;
        const coverageGaps = this._lastCoverageGapCount;
        const atomicHolds = this._lastAtomicHoldCount;
        const critical = selectedCount === 0 || coverageGaps > 0;
        return {
            critical,
            ready: !critical,
            selectedCount,
            criticalJobs,
            coverageGaps,
            atomicHolds
        };
    }

    /**
     * Renderer integrations can report timings that are measured host-side.
     * @param {string} name - Timing metric name.
     * @param {number} milliseconds - Measured duration in milliseconds.
     */
    reportStreamingMetric(name, milliseconds) {
        this.streamingStats.record(name, milliseconds);
    }

    _hasPipelineCapacity() {
        return this._downloadedBytes < this.maxDownloadedBytes &&
            this._decodedBytes < this.maxDecodedBytes;
    }

    _hasPipelineJobCapacity() {
        const limit = Math.floor(Number(this.maxPipelineJobs) || 0);
        return limit <= 0 || this._pipelineJobs.size < limit;
    }

    _preemptLowerPriorityPipelineJob(requestClass, priority) {
        if (this._hasPipelineJobCapacity()) return true;
        const incomingRank = REQUEST_CLASS_RANK[requestClass] ?? 0;
        let candidate = null;
        for (const job of this._pipelineJobs.values()) {
            if (job.cancelReason) continue;
            const rank = REQUEST_CLASS_RANK[job.requestClass] ?? 0;
            if (rank > incomingRank || (rank === incomingRank && job.priority >= priority)) continue;
            if (!candidate || rank < candidate.rank ||
                (rank === candidate.rank && job.priority < candidate.job.priority)) {
                candidate = { job, rank };
            }
        }
        if (candidate) {
            candidate.job.cancelReason = 'pipeline-capacity';
            candidate.job.controller.abort();
            this.streamingStats.increment('pipelineCapacityPreemptions');
        }
        return false;
    }

    _waitForPipelineCapacity(node, priority, signal) {
        if (this._hasPipelineCapacity()) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const entry = { node, priority, signal, resolve, reject, onAbort: null };
            if (signal) {
                entry.onAbort = () => {
                    const index = this._capacityWaiters.indexOf(entry);
                    if (index >= 0) this._capacityWaiters.splice(index, 1);
                    const err = new Error('Aborted');
                    err.name = 'AbortError';
                    reject(err);
                };
                if (signal.aborted) {
                    entry.onAbort();
                    return;
                }
                signal.addEventListener('abort', entry.onAbort, { once: true });
            }
            this._capacityWaiters.push(entry);
            this._capacityWaiters.sort((a, b) => b.priority - a.priority);
        });
    }

    _drainCapacityWaiters() {
        while (this._capacityWaiters.length > 0 && this._hasPipelineCapacity()) {
            const entry = this._capacityWaiters.shift();
            if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
            entry.resolve();
        }
    }

    _refreshPipelinePriorities(updates) {
        const activePriorities = new Map();
        for (const update of updates) {
            const { node, priority, requestClass = null } = update;
            const job = this._pipelineJobs.get(node);
            if (!job) continue;
            job.priority = priority;
            job.lastWantedFrame = this._frameNumber;
            if (requestClass &&
                (REQUEST_CLASS_RANK[requestClass] ?? 0) > (REQUEST_CLASS_RANK[job.requestClass] ?? 0)) {
                job.requestClass = requestClass;
                this.streamingStats.increment('superseded');
            }
            activePriorities.set(node, priority);
        }
        if (activePriorities.size === 0) return;

        const refreshQueue = (queue) => {
            let changed = false;
            for (const entry of queue) {
                const priority = activePriorities.get(entry.node);
                if (priority === undefined) continue;
                entry.priority = priority;
                changed = true;
            }
            if (changed) queue.sort((a, b) => b.priority - a.priority);
        };
        refreshQueue(this._requestQueue);
        refreshQueue(this._decodeQueue);
        refreshQueue(this._capacityWaiters);

        if (typeof this.handlers.updatePriorities === 'function') {
            this.handlers.updatePriorities(activePriorities);
        } else if (typeof this.handlers.updatePriority === 'function') {
            for (const [node, priority] of activePriorities) {
                this.handlers.updatePriority(node, priority);
            }
        }
    }

    _refreshPipelinePriority(node, priority, requestClass = null) {
        this._refreshPipelinePriorities([{ node, priority, requestClass }]);
    }

    _cancelStalePipelineJobs(wanted) {
        for (const [node, job] of this._pipelineJobs) {
            if (wanted.has(node)) {
                job.lastWantedFrame = this._frameNumber;
                continue;
            }
            if (job.cancelReason) continue;
            const staleFrames = job.requestClass === 'speculative' ?
                Math.min(2, this.staleRequestFrames) : this.staleRequestFrames;
            if (this._frameNumber - job.lastWantedFrame < staleFrames) continue;
            job.cancelReason = 'stale';
            job.controller.abort();
            this.streamingStats.increment('staleDropped');
        }
    }

    _finishPipelineJob(node) {
        this._pipelineJobs.delete(node);
        node.__abortController = null;
    }

    /**
     * Start the tile manager. This function will load the root JSON and expand the root node.
     * Once called, the local reference frame is locked — setLocalFrame/clearLocalFrame will throw.
     */
    async start() {
        this._started = true;
        const rootRequest = await this.source.getRootRequest();
        const request = {
            ...rootRequest,
            requestInit: { ...(rootRequest.requestInit ?? {}), priority: 'high' }
        };
        const { json, url } = await this.fetchJson(request);
        this._assignBaseUrl(json.root, new URL('.', url).toString());
        this._root = json.root;
        // In selection mode the per-frame driver owns the entire load tree —
        // firing legacy expandNode here would race against selection and load
        // intermediate tiles visibly (creating the coarse-over-fine overlap).
        if (!this.useSelectionMode) {
            this.expandNode(json.root);
        }
    }

    /**
     * Define a local reference frame at the given geodetic anchor. After this is set:
     *   - getTilesRootTransform() returns the transform to apply to the engine's tile
     *     root entity so that tiles appear in local (game) coordinates.
     *   - updateLocal() accepts camera position and frustum planes in local space.
     *
     * Must be called before start(). See src/reference-frame.mjs for the full
     * convention spec (axes, rotation order, units).
     *
     * @param {object} spec - Geodetic anchor plus optional orientation.
     * @param {{lon: number, lat: number, alt: number}} spec.origin - Anchor in WGS84 degrees / metres (`alt` optional, defaults to 0).
     * @param {{yaw: number, pitch: number, roll: number}} [spec.orientation] - Yaw/pitch/roll in degrees relative to ENU (each optional, defaults to 0).
     */
    setLocalFrame(spec) {
        if (this._started) {
            throw new Error('TileManager.setLocalFrame: frame is locked once start() has been called');
        }
        this._localFrame = createLocalFrame(spec);
    }

    /**
     * Remove the local reference frame. Must be called before start().
     */
    clearLocalFrame() {
        if (this._started) {
            throw new Error('TileManager.clearLocalFrame: frame is locked once start() has been called');
        }
        this._localFrame = null;
    }

    /**
     * Transform to apply to the engine entity that parents all tile GLBs, so that
     * tile content renders in local (game) coordinates. Returns the identity
     * transform when no local frame is set.
     *
     * @returns {{position: number[], rotation: number[]}} Position [x,y,z] and quaternion [x,y,z,w].
     */
    getTilesRootTransform() {
        if (!this._localFrame) return IDENTITY_ROOT_TRANSFORM;
        return {
            position: this._localFrame.rootPosition.slice(),
            rotation: this._localFrame.rootRotation.slice()
        };
    }

    /**
     * Per-frame update when a local reference frame is active. Camera position
     * and frustum planes are given in local (game) space; both are converted to
     * the internal tile-Y space before traversal.
     *
     * Throws if no local frame has been set.
     *
     * @param {number[]} cameraPosLocal - Camera position [x,y,z] in local space.
     * @param {number} [fovY] - Vertical FOV in radians (for SSE).
     * @param {number} [screenHeight] - Render target height in pixels (for SSE).
     * @param {object[]|null} [frustumPlanesLocal] - Six Plane-like objects in local space.
     * @param {number[]|null} [cameraForwardLocal] - Unit forward vector [x,y,z] in local
     * space. When supplied, `_computePriority` favors tiles near the screen
     * center (foveation). Ignored if null.
     */
    updateLocal(cameraPosLocal, fovY, screenHeight, frustumPlanesLocal, cameraForwardLocal) {
        const frame = this._localFrame;
        if (!frame) {
            throw new Error('TileManager.updateLocal: no local frame set; call setLocalFrame() before start()');
        }

        // Frame-time EWMA. Measured every call (including streaming-paused
        // and idle-throttled frames) so the average reflects what the user
        // actually experiences. Drives the adaptive SSE controller below.
        // Clamp dt floor at 1 ms to avoid div-by-zero in the velocity
        // calc and unstable EWMA on the very first frame.
        const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const dtMs = this._lastUpdateMs ? Math.max(1, nowMs - this._lastUpdateMs) : 16;
        this._lastUpdateMs = nowMs;
        this._frameTimeMs = this._frameTimeMs * 0.9 + dtMs * 0.1;

        // Streaming lock: no selection, no requests, no eviction. In-flight
        // fetches keep landing through their existing load handlers; the
        // scene freezes at its current loaded + visible set.
        if (this.streamingPaused) return;

        // Idle-traversal throttle: when configured and the camera has barely
        // moved since the last traversal, skip the heavy selection pass. A
        // traversal is forced as soon as the camera moves > idleTraversalMoveM
        // metres so LOD stays responsive to pan/zoom.
        if (this.idleTraversalSkipFrames > 0) {
            const last = this._lastTraversalPosLocal;
            const dx = cameraPosLocal[0] - last[0];
            const dy = cameraPosLocal[1] - last[1];
            const dz = cameraPosLocal[2] - last[2];
            const movedSq = dx * dx + dy * dy + dz * dz;
            const threshSq = this.idleTraversalMoveM * this.idleTraversalMoveM;
            if (this._framesSinceTraversal < this.idleTraversalSkipFrames && movedSq < threshSq) {
                this._framesSinceTraversal++;
                return;
            }
            this._framesSinceTraversal = 0;
            last[0] = cameraPosLocal[0];
            last[1] = cameraPosLocal[1];
            last[2] = cameraPosLocal[2];
        }

        // Camera velocity (m/s) in the local frame. Computed against the
        // previous traversal's cameraPos (skipped frames don't reset it),
        // so velocity reflects motion since the last actual selection.
        // Used by `_computePriority` to give tiles ahead of camera motion
        // a priority boost so they preload before the camera arrives.
        if (this._prevCameraLocal) {
            const dtSec = Math.max(dtMs / 1000, 1e-3);
            this._cameraVelocityLocal[0] = (cameraPosLocal[0] - this._prevCameraLocal[0]) / dtSec;
            this._cameraVelocityLocal[1] = (cameraPosLocal[1] - this._prevCameraLocal[1]) / dtSec;
            this._cameraVelocityLocal[2] = (cameraPosLocal[2] - this._prevCameraLocal[2]) / dtSec;
        } else {
            this._prevCameraLocal = [0, 0, 0];
        }
        this._prevCameraLocal[0] = cameraPosLocal[0];
        this._prevCameraLocal[1] = cameraPosLocal[1];
        this._prevCameraLocal[2] = cameraPosLocal[2];

        // Camera: local → tile-Y. Must be full-magnitude (originTileY + rotated offset),
        // not local-relative — _updateCore's globe-cone check in expandNode() relies on
        // the true ECEF magnitude to cull far-side tiles.
        const R = frame.R_local_to_tileY;
        const o = frame.originTileY;
        const cameraPosTileY = [
            o[0] + R[0] * cameraPosLocal[0] + R[1] * cameraPosLocal[1] + R[2] * cameraPosLocal[2],
            o[1] + R[3] * cameraPosLocal[0] + R[4] * cameraPosLocal[1] + R[5] * cameraPosLocal[2],
            o[2] + R[6] * cameraPosLocal[0] + R[7] * cameraPosLocal[1] + R[8] * cameraPosLocal[2]
        ];

        // Camera velocity: pure rotation (vector, no translation). Used by
        // `_computePriority` for the motion-alignment bonus.
        const vL = this._cameraVelocityLocal;
        this._cameraVelocityTileY[0] = R[0] * vL[0] + R[1] * vL[1] + R[2] * vL[2];
        this._cameraVelocityTileY[1] = R[3] * vL[0] + R[4] * vL[1] + R[5] * vL[2];
        this._cameraVelocityTileY[2] = R[6] * vL[0] + R[7] * vL[1] + R[8] * vL[2];

        // Camera forward: pure rotation (direction only, no translation).
        if (cameraForwardLocal) {
            const [fx, fy, fz] = cameraForwardLocal;
            this._cameraForwardTileY = [
                R[0] * fx + R[1] * fy + R[2] * fz,
                R[3] * fx + R[4] * fy + R[5] * fz,
                R[6] * fx + R[7] * fy + R[8] * fz
            ];
        } else {
            this._cameraForwardTileY = null;
        }

        const frustumCtx = frustumPlanesLocal ? {
            mode: 'frame',
            planes: frustumPlanesLocal,
            R: frame.R_tileY_to_local,
            t: frame.rootPosition
        } : null;

        this._updateCore(cameraPosTileY, fovY, screenHeight, frustumCtx);
    }

    /**
     * Checks if a node is in the camera's view frustum.
     *
     * The bounding box center is first converted from ECEF (Z-up) to tile-Y
     * (engine Y-up). The frustumCtx then maps tile-Y into the frame the caller's
     * planes live in:
     *   - { mode: 'translate', worldOffset, planes }:
     *       legacy raw path — planes are in PlayCanvas world space, worldOffset
     *       is the world entity position that shifts tile-Y into that space.
     *   - { mode: 'frame', R, t, planes }:
     *       local-frame path — (R, t) maps tile-Y directly into local (game)
     *       space, where the supplied planes live.
     *
     * Cull condition for a sphere: dot(plane.normal, center) + plane.distance < -radius
     * (plane normals point inward; a sphere fully behind a plane is outside the frustum).
     * Rotation does not change the radius, so the max-half-axis heuristic is preserved.
     *
     * Falls back to always-visible when the context is absent or the node has no box,
     * so tiles are never wrongly discarded if the API is unavailable.
     *
     * @param {object} node - The node to test.
     * @param {object|null} frustumCtx - View-transform context (see above) or null.
     * @returns {boolean} True if the node's bounding sphere intersects the frustum.
     */
    isInView(node, frustumCtx) {
        if (!frustumCtx || !node.boundingVolume?.box) {
            return true;
        }

        const [bx, by, bz, xx, xy, xz, yx, yy, yz, zx, zy, zz] = node.boundingVolume.box;

        // ECEF Z-up → tile-Y center
        const tx = bx;
        const ty = bz;
        const tz = -by;

        let wx, wy, wz;
        if (frustumCtx.mode === 'frame') {
            const R = frustumCtx.R, t = frustumCtx.t;
            wx = R[0] * tx + R[1] * ty + R[2] * tz + t[0];
            wy = R[3] * tx + R[4] * ty + R[5] * tz + t[1];
            wz = R[6] * tx + R[7] * ty + R[8] * tz + t[2];
        } else {
            const o = frustumCtx.worldOffset;
            wx = o[0] + tx;
            wy = o[1] + ty;
            wz = o[2] + tz;
        }

        // Minimal-enclosing sphere of the oriented bounding box:
        // r = sqrt(|X|^2 + |Y|^2 + |Z|^2) = corner-to-center distance.
        // Using max(|X|,|Y|,|Z|) here was a bug -- it under-estimates the
        // true bounding sphere by up to sqrt(3) for cube-ish tiles (which
        // Google's 3D Tiles are), causing tiles whose centers sit just
        // outside a frustum plane but whose corners extend back into the
        // frustum to be wrongly culled. Symptom: tiles at the edges of
        // the FOV never load and never render.
        const r2 = xx * xx + xy * xy + xz * xz +
                   yx * yx + yy * yy + yz * yz +
                   zx * zx + zy * zy + zz * zz;
        const r = Math.sqrt(r2);

        for (const plane of frustumCtx.planes) {
            const dot = plane.normal.x * wx + plane.normal.y * wy + plane.normal.z * wz;
            if (dot + plane.distance < -r) {
                return false;
            }
        }
        return true;
    }

    /**
     * Checks if a node is within the level-of-detail switch distance.
     *
     * Uses Cesium's Screen Space Error (SSE) formula when `geometricError` is present
     * on the tile JSON node: SSE = (geometricError × screenHeight) / (dist × 2tan(fovY/2)).
     * Refine (return true) when SSE exceeds maximumScreenSpaceError (default 24 px).
     * This gives consistent visual quality at all zoom levels and FOVs, unlike a fixed
     * distance multiplier.
     *
     * Falls back to the original fixed-distance formula for tilesets that omit
     * geometricError, or when fovY / screenHeight are not yet available.
     *
     * @param {object} node - The node to test.
     * @param {number[]} cameraPos - Camera position as [x, y, z] in local tile space.
     * @param {number} [fovY] - Vertical field of view in radians.
     * @param {number} [screenHeight] - Render target height in pixels.
     * @param {number} [sseMul] - Extra multiplier on the SSE threshold
     * (defaults to 1). Used by the selection walk to accept coarser
     * out-of-FOV tiles (multiplier > 1) while keeping in-FOV tiles at
     * target quality.
     * @returns {boolean} True if the node should be refined (expanded).
     */
    isInRange(node, cameraPos, fovY, screenHeight, sseMul = 1) {
        // Some tiles use sphere or region bounding volumes instead of box.
        // We cannot compute a meaningful distance without a box, so treat them as always in range.
        if (!node.boundingVolume?.box) {
            return true;
        }

        const [bx, by, bz, xx, xy, xz, yx, yy, yz, zx, zy, zz] = node.boundingVolume.box;
        const dx = bx - cameraPos[0];
        const dy = bz - cameraPos[1]; // NOTE: box is Z-up, engine is Y-up
        const dz = -by - cameraPos[2];
        const dist = Math.max(length(dx, dy, dz), 1e-7);

        const ge = node.geometricError;
        if (ge !== undefined && fovY !== undefined && screenHeight !== undefined) {
            // Cesium SSE formula: refine when the tile introduces more than
            // maximumScreenSpaceError pixels of visual error at current distance/FOV.
            // Use frame-cached 2*tan(fovY/2) when available; otherwise recompute.
            const sseDenominator = this._frameSseDenom > 0 ? this._frameSseDenom : 2 * Math.tan(fovY / 2);
            const sse = (ge * screenHeight) / (dist * sseDenominator);
            return sse > this.maximumScreenSpaceError * this._sseBias * this._adaptiveBias * sseMul;
        }

        // Fallback: fixed-distance proxy (original formula)
        const lenx = length(xx, xy, xz);
        const leny = length(yx, yy, yz);
        const lenz = length(zx, zy, zz);
        return dist < Math.max(lenx, leny, lenz, 100) * 4;
    }

    async loadContent(node, priority = 0, requestClass = 'visible') {
        if (!node.content) return;
        // Guard against re-loading. The same node can be reached more than once when a
        // .json sub-tileset wrapper eagerly resolves its inner root (see below).
        if (node.__contentLoaded || !this._isLoadRetryDue(node)) {
            return;
        }
        if (!this._hasPipelineJobCapacity()) {
            this._preemptLowerPriorityPipelineJob(requestClass, priority);
            this.streamingStats.increment('pipelineCapacityDeferrals');
            return false;
        }
        node.__contentLoaded = true;

        // Each fetch gets its own AbortController so unloadContent can cancel it.
        const controller = new AbortController();
        node.__abortController = controller;
        this._pipelineJobs.set(node, {
            node,
            priority,
            requestClass,
            controller,
            lastWantedFrame: this._frameNumber,
            cancelReason: null
        });
        this._setLoadStage(node, TILE_LOAD_STAGES.REQUESTED);
        this.streamingStats.increment('requested');

        const uri = node.content.uri;
        let downloadedSize = 0;
        let decodedSize = 0;
        let decodeSlotHeld = false;
        let prepareSlotHeld = false;

        try {
            const request = await this._getNodeRequest(node);
            // Inject the abort signal into the request so both fetchJson and handlers.load
            // (which calls fetch internally) respond to cancellation. Also forward
            // the SSE/foveation priority so the viewer-side instantiation queue can
            // sort GPU uploads by the same signal as the fetch queue.
            const signalledRequest = {
                ...request,
                priority,
                requestClass,
                // Tell Chromium's network scheduler that basemap bytes outrank
                // application assets. Terratile's numeric priority still owns
                // ordering within the tile queue.
                requestInit: {
                    ...(request.requestInit ?? {}),
                    signal: controller.signal,
                    priority: 'high'
                }
            };

            if (typeof this.handlers.prepare === 'function') {
                await this._waitForPipelineCapacity(node, priority, controller.signal);
            }
            await this._acquireRequestSlot(priority, node, controller.signal);
            // slotReleased tracks manual early releases so the finally block
            // doesn't double-release (needed for the .json branch below).
            let slotReleased = false;
            try {
                if (uri.includes('.glb') && typeof this.handlers.prepare === 'function') {
                    this._setLoadStage(node, TILE_LOAD_STAGES.DOWNLOADING);
                    const downloadStart = performance.now();
                    const bytes = await this.fetchBuffer(signalledRequest);
                    this.streamingStats.record('downloadMs', performance.now() - downloadStart);
                    this.streamingStats.increment('networkBytes', bytes.byteLength);

                    // The network semaphore protects only byte transfer. Decode
                    // and GPU preparation continue independently so downloads
                    // can fill available bandwidth while atomic coverage keeps
                    // the coarse parent visible.
                    this._releaseRequestSlot();
                    slotReleased = true;
                    downloadedSize = bytes.byteLength;
                    this._downloadedBytes += downloadedSize;
                    this.streamingStats.setGauge('downloadedBytes', this._downloadedBytes);
                    this._setLoadStage(node, TILE_LOAD_STAGES.DOWNLOADED);

                    if (typeof this.handlers.acquirePrepareSlot === 'function') {
                        await this.handlers.acquirePrepareSlot(node, priority, controller.signal);
                        prepareSlotHeld = true;
                    }

                    await this._acquireDecodeSlot(node, priority, controller.signal);
                    decodeSlotHeld = true;
                    this._downloadedBytes = Math.max(0, this._downloadedBytes - downloadedSize);
                    downloadedSize = 0;
                    this.streamingStats.setGauge('downloadedBytes', this._downloadedBytes);
                    this._drainCapacityWaiters();
                    this._setLoadStage(node, TILE_LOAD_STAGES.DECODING);
                    const decodeStart = performance.now();
                    const decoded = typeof this.handlers.decode === 'function' ?
                        await this.handlers.decode(node, bytes, signalledRequest) : bytes;
                    this.streamingStats.record('decodeMs', performance.now() - decodeStart);
                    this._releaseDecodeSlot();
                    decodeSlotHeld = false;

                    if (controller.signal.aborted) {
                        if (typeof this.handlers.releaseDecoded === 'function') {
                            this.handlers.releaseDecoded(node, decoded);
                        }
                        const error = new Error('Aborted');
                        error.name = 'AbortError';
                        throw error;
                    }

                    decodedSize = typeof this.handlers.getDecodedByteLength === 'function' ?
                        Number(this.handlers.getDecodedByteLength(node, decoded)) || bytes.byteLength :
                        bytes.byteLength;
                    this._decodedBytes += decodedSize;
                    this.streamingStats.setGauge('decodedBytes', this._decodedBytes);
                    this._setLoadStage(node, TILE_LOAD_STAGES.DECODED);

                    this._setLoadStage(node, TILE_LOAD_STAGES.PREPARING);
                    const prepareStart = performance.now();
                    await this.handlers.prepare(node, decoded, signalledRequest);
                    this.streamingStats.record('prepareMs', performance.now() - prepareStart);
                    if (controller.signal.aborted) {
                        if (typeof this.handlers.discard === 'function') this.handlers.discard(node);
                        if (typeof this.handlers.releaseDecoded === 'function') {
                            this.handlers.releaseDecoded(node, decoded);
                        }
                        const error = new Error('Aborted');
                        error.name = 'AbortError';
                        throw error;
                    }
                    this._decodedBytes = Math.max(0, this._decodedBytes - decodedSize);
                    decodedSize = 0;
                    this.streamingStats.setGauge('decodedBytes', this._decodedBytes);
                    this._drainCapacityWaiters();
                    if (typeof this.handlers.releaseDecoded === 'function') {
                        this.handlers.releaseDecoded(node, decoded);
                    }
                    if (prepareSlotHeld && typeof this.handlers.releasePrepareSlot === 'function') {
                        this.handlers.releasePrepareSlot(node);
                        prepareSlotHeld = false;
                    }
                    this._setLoadStage(node, TILE_LOAD_STAGES.RENDER_READY);
                    this._completeRenderableLoad(node);
                } else if (uri.includes('.glb') && this.handlers.load) {
                    this._setLoadStage(node, TILE_LOAD_STAGES.DOWNLOADING);
                    await this.handlers.load(node, signalledRequest);
                    this._setLoadStage(node, TILE_LOAD_STAGES.RENDER_READY);
                    // Verify the load actually produced an entity. If the viewer
                    // handler swallowed an error (returning undefined without
                    // throwing), there's no entity — marking loaded here would
                    // wedge the node forever (loadContent's __contentLoaded guard
                    // would skip all retries). Reset state so the next selection
                    // request can retry.
                    if (typeof this.handlers.hasEntity === 'function' &&
                        !this.handlers.hasEntity(node)) {
                        node.__contentLoaded = false;
                        this._setLoadStage(node, null);
                        throw new Error(`Tile load completed without a renderable entity: ${node.content?.uri ?? ''}`);
                    }
                    this._loadedGlbCount += 1;
                    this._loadedNodes.add(node);
                    this._clearLoadFailureState(node);

                    // In selection mode, freshly loaded tiles must not be visible
                    // unless the current frame's selection explicitly chose them.
                    // Otherwise intermediate tiles loaded via .json-wrapper
                    // recursion (or legacy expandNode on boot) end up rendering
                    // on top of the selected targets.
                    if (this.useSelectionMode && !this._prevSelected.has(node)) {
                        this.handlers.hide(node);
                    }

                    // Apply region suppression before the normal hide check so that
                    // region-hidden tiles are never made visible by later show() calls.
                    const region = this._regionForNode(node);
                    node.__regionMode = region?.mode ?? null;
                    if (region?.mode === 'hide') {
                        this.handlers.hide(node);
                        this.contentHidden.set(this._getNodeContentKey(node), true);
                    } else if (region?.mode === 'transparent' && this.handlers.setOpacity) {
                        this.handlers.setOpacity(node, region.opacity);
                    }

                    if (this.contentHidden.get(this._getNodeContentKey(node))) {
                        this.handlers.hide(node);
                    }
                } else if (uri.includes('.json')) {
                    this._setLoadStage(node, TILE_LOAD_STAGES.DOWNLOADING);
                    const downloadStart = performance.now();
                    const { json, url } = await this.fetchJson(signalledRequest);
                    this.streamingStats.record('downloadMs', performance.now() - downloadStart);
                    // Release the slot NOW — before the recursive loadContent call.
                    // The recursive call will acquire its own slot. Holding the slot
                    // across the recursion deadlocks when all slots are occupied by
                    // .json chains waiting for their own children to finish.
                    this._releaseRequestSlot();
                    slotReleased = true;
                    this._setLoadStage(node, TILE_LOAD_STAGES.DOWNLOADED);
                    this._assignBaseUrl(json.root, new URL('.', url).toString(), node);
                    node.children = [json.root];
                    this._clearLoadFailureState(node);
                    this._setLoadStage(node, TILE_LOAD_STAGES.DECODED);
                    // Eagerly resolve the sub-tileset root's own content. Without this, the
                    // parent hides itself once loadContent returns for each child, but a .json
                    // wrapper produces no entity of its own. If the wrapper is also "out of
                    // LOD range", update() will never expand it further, leaving a permanent
                    // hole where the parent's geometry used to be. Recursing here ensures a
                    // renderable tile is available before the parent disappears, and
                    // transparently unrolls .json -> .json -> .glb chains.
                    await this.loadContent(json.root, priority, requestClass);
                }
            } finally {
                if (!slotReleased) this._releaseRequestSlot();
            }
            this.streamingStats.increment('completed');
            this._finishPipelineJob(node);
        } catch (err) {
            if (decodeSlotHeld) this._releaseDecodeSlot();
            if (prepareSlotHeld && typeof this.handlers.releasePrepareSlot === 'function') {
                this.handlers.releasePrepareSlot(node);
                prepareSlotHeld = false;
            }
            if (downloadedSize > 0) {
                this._downloadedBytes = Math.max(0, this._downloadedBytes - downloadedSize);
                this.streamingStats.setGauge('downloadedBytes', this._downloadedBytes);
                this._drainCapacityWaiters();
            }
            if (decodedSize > 0) {
                this._decodedBytes = Math.max(0, this._decodedBytes - decodedSize);
                this.streamingStats.setGauge('decodedBytes', this._decodedBytes);
                this._drainCapacityWaiters();
            }
            if (err.name === 'AbortError') {
                if (typeof this.handlers.discard === 'function') this.handlers.discard(node);
                // Fetch was cancelled by unloadContent — not an error. Reset the flag so
                // the tile can be reloaded if the camera revisits this area.
                // eslint-disable-next-line require-atomic-updates -- `node` is a never-reassigned parameter
                node.__contentLoaded = false;
                this._setLoadStage(node, null);
                this.streamingStats.increment('cancelled');
                this._finishPipelineJob(node);
                return;
            }
            // Yield and retry automatically. A busy host can transiently fail
            // networking or preparation during startup; that must not poison
            // the node for the remainder of the page session.
            const retry = this._scheduleLoadRetry(node, err);
            if (retry.failureCount <= 3 || retry.failureCount % 10 === 0) {
                console.warn(`tile load failed (attempt ${retry.failureCount}; retry in ${retry.delayMs}ms):`,
                    node.content?.uri, err.message);
            }
            this.streamingStats.increment('failed');
            this._recordFailure(err);
            this._finishPipelineJob(node);
        }
    }

    _isLoadRetryDue(node, nowMs = Date.now()) {
        if (node.__loadDead) {
            const deadUntil = Number(node.__loadDeadUntilMs) || 0;
            // A dead marker without a deadline is an explicit permanent veto
            // (used by hosts/tests). Runtime failures always carry a deadline.
            if (deadUntil === 0 || nowMs < deadUntil) return false;
            node.__loadDead = undefined;
            node.__loadDeadUntilMs = undefined;
        }
        return (Number(node.__nextLoadRetryMs) || 0) <= nowMs;
    }

    _scheduleLoadRetry(node, error) {
        const failureCount = (node.__loadFailures ?? 0) + 1;
        const status = Number(error?.status) || 0;
        const absentContent = status === 404 || status === 410 || status === 422;
        const exponential = this.retryBaseDelayMs * (2 ** Math.min(failureCount - 1, 10));
        let delayMs = Math.min(this.retryMaxDelayMs, exponential);
        if (absentContent && failureCount >= 3) {
            delayMs = Math.max(delayMs, this.permanentFailureRetryMs);
            node.__loadDead = true;
            node.__loadDeadUntilMs = Date.now() + delayMs;
        } else {
            node.__loadDead = undefined;
            node.__loadDeadUntilMs = undefined;
        }
        node.__loadFailures = failureCount;
        node.__nextLoadRetryMs = Date.now() + Math.max(0, delayMs);
        node.__contentLoaded = false;
        this._setLoadStage(node, null);
        this.streamingStats.increment('retryScheduled');
        return { failureCount, delayMs: Math.max(0, delayMs) };
    }

    _clearLoadFailureState(node) {
        if ((node.__loadFailures ?? 0) > 0) this.streamingStats.increment('retryRecovered');
        node.__loadFailures = 0;
        node.__nextLoadRetryMs = undefined;
        node.__loadDead = undefined;
        node.__loadDeadUntilMs = undefined;
    }

    _completeRenderableLoad(node) {
        if (typeof this.handlers.hasEntity === 'function' && !this.handlers.hasEntity(node)) {
            node.__contentLoaded = false;
            this._setLoadStage(node, null);
            throw new Error(`Tile preparation completed without a renderable entity: ${node.content?.uri ?? ''}`);
        }

        this._loadedGlbCount += 1;
        this._loadedNodes.add(node);
        this._clearLoadFailureState(node);

        if (this.useSelectionMode && !this._prevSelected.has(node)) {
            this.handlers.hide(node);
        }

        const region = this._regionForNode(node);
        node.__regionMode = region?.mode ?? null;
        if (region?.mode === 'hide') {
            this.handlers.hide(node);
            this.contentHidden.set(this._getNodeContentKey(node), true);
        } else if (region?.mode === 'transparent' && this.handlers.setOpacity) {
            this.handlers.setOpacity(node, region.opacity);
        }

        if (this.contentHidden.get(this._getNodeContentKey(node))) {
            this.handlers.hide(node);
        }
    }

    /**
     * Rolling-window failure tracker. Each non-abort load error calls this;
     * when the in-window count crosses the threshold, trigger a session
     * refresh. No-op if a refresh is already in flight or the cooldown
     * hasn't elapsed since the last one.
     * @param {Error|null} error - Load error used to distinguish session
     * failures from host/network contention that a session refresh cannot fix.
     */
    _recordFailure(error = null) {
        // Session refresh only helps provider/session failures. Refreshing the
        // root for a socket reset, parser error or saturated main thread adds
        // more startup traffic and cannot repair the actual problem.
        if (error) {
            const status = Number(error.status) || 0;
            // HTTP error messages include the request URL, whose normal query
            // string itself contains "session". Inspect the provider body so
            // an unrelated 404/500 does not look like an expired session.
            const detail = String(error.body ?? '');
            const sessionFailure = status === 400 || status === 401 || status === 403 ||
                /invalid[_ ]argument|expired|invalid session|session token/i.test(detail);
            if (!sessionFailure) return;
        }
        const now = Date.now();
        this._failureTimestamps.push(now);
        const cutoff = now - this._failureWindowMs;
        while (this._failureTimestamps.length > 0 && this._failureTimestamps[0] < cutoff) {
            this._failureTimestamps.shift();
        }
        if (this._failureTimestamps.length < this._failureThreshold) return;
        if (this._refreshing) return;
        if (now - this._lastRefreshMs < this._refreshCooldownMs) return;
        console.warn(`[terratile] ${this._failureTimestamps.length} tile load failures in ${this._failureWindowMs}ms — triggering session refresh`);
        this._failureTimestamps.length = 0;
        this.refreshSession().catch(err => console.error('session refresh failed:', err));
    }

    /**
     * Re-fetch the root tileset to obtain a fresh session token, update the
     * source's session, and clear per-node failure counters so previously
     * failed tiles retry with the new session. The viewer-level fetch cache
     * already bypasses caching for session-less URLs (the root has none), so
     * the refresh always reaches the network.
     *
     * @returns {Promise<boolean>} true if a session token was refreshed.
     */
    refreshSession() {
        if (this._refreshing) return this._refreshing;
        this._lastRefreshMs = Date.now();
        this._refreshing = (async () => {
            try {
                const request = await this.source.getRootRequest();
                // Don't run _buildRequestUrl on this — the root URL already
                // comes fully built from getRootRequest, and if we did round-
                // trip it via resolveRequest the old session would be
                // re-injected from this.source.session.
                const response = await fetch(request.url, {
                    ...(request.requestInit ?? {}),
                    priority: 'high'
                });
                if (!response.ok) {
                    throw new Error(`refreshSession: HTTP ${response.status}`);
                }
                const json = await response.json();
                // The root response contains child URIs with the fresh
                // session embedded. Pull the first one and extract the token.
                const newSession = this._extractSessionFromTree(json.root);
                if (!newSession) {
                    console.warn('[terratile] refreshSession: no session found in root response');
                    return false;
                }
                if (typeof this.source.setSession === 'function') {
                    this.source.setSession(newSession);
                } else {
                    this.source.session = newSession;
                }
                // Clear failure counters so previously dead-tile nodes retry.
                this._resetLoadFailures(this._root);
                return true;
            } finally {
                this._refreshing = null;
            }
        })();
        return this._refreshing;
    }

    _extractSessionFromTree(node) {
        if (!node) return null;
        const uri = node.content?.uri;
        if (uri) {
            try {
                const u = new URL(uri);
                const s = u.searchParams.get('session');
                if (s) return s;
            } catch { /* relative URI, skip */ }
        }
        if (node.children) {
            for (const child of node.children) {
                const s = this._extractSessionFromTree(child);
                if (s) return s;
            }
        }
        return null;
    }

    // Recursively clear retry state so selection's next tick can immediately
    // use the fresh provider session.
    _resetLoadFailures(node) {
        if (!node) return;
        if ((node.__loadFailures ?? 0) > 0) {
            this._clearLoadFailureState(node);
            // Anything that was stuck __contentLoaded=true but isn't actually
            // in our loaded set is a permanent-failure marker — clear it.
            if (!this._loadedNodes.has(node)) {
                node.__contentLoaded = false;
            }
        }
        if (node.children) {
            for (const child of node.children) this._resetLoadFailures(child);
        }
    }

    unloadContent(node) {
        // Cancel any in-flight fetch for this node immediately.
        node.__abortController?.abort();
        node.__abortController = null;

        if (node.content) {
            const uri = node.content.uri;
            // Drop any stale hide directive — prevents a future reload of the
            // same URL from being silently hidden by accumulated state.
            this.contentHidden.delete(this._getNodeContentKey(node));
            if (uri.includes('.glb') && this.handlers.unload) {
                this.handlers.unload(node);
                if (node.__contentLoaded) this._loadedGlbCount = Math.max(0, this._loadedGlbCount - 1);
                this._loadedNodes.delete(node);
                this._notSelectedSince.delete(node);
                this._prevSelected.delete(node);
                node.__contentLoaded = false;
                // Wave hysteresis resets with the content: if this area is
                // ever revisited from scratch, a fresh hold is allowed.
                node.__waveAdvancedFrame = undefined;
                node.__waveHoldExpired = undefined;
                node.__waveHoldPrevFrame = undefined;
                if (typeof this.handlers.hasResident === 'function' && this.handlers.hasResident(node)) {
                    this._setLoadStage(node, TILE_LOAD_STAGES.RESIDENT);
                } else {
                    this._setLoadStage(node, null);
                }
            } else if (uri.includes('.json')) {
                // Intentionally keep node.children in place. update() uses
                //   `if (child.children)` as the gate for calling expandNode,
                // so deleting children here strands nested sub-tileset subtrees:
                // after one collapse cycle the gate never passes again and the
                // region stays frozen at whatever coarser LOD it fell back to.
                // Resetting the flag is enough — loadContent re-fetches and
                // overwrites node.children with fresh data on re-expansion.
                node.__contentLoaded = false;
                this._setLoadStage(node, null);
            }
        }
    }

    /**
     * Expanding a node will initiate async loads of its children's content. When all
     * children are loaded, the parent node itself is hidden.
     *
     * @param {object} node - The node to expand.
     * @param {number[]} [cameraPos] - Camera position for priority scoring.
     * @param {number} [fovY] - Vertical FOV in radians for priority scoring.
     * @param {number} [screenHeight] - Screen height in pixels for priority scoring.
     */
    async expandNode(node, cameraPos, fovY, screenHeight) {
        if (!this.expandedNodes.has(node)) {
            this.expandedNodes.add(node);

            // Initiate the loading of all child nodes, highest SSE first.
            // When globeMode is false and camera position is available, skip children
            // whose bounding volume center is more than globeRadius degrees away from
            // the camera direction — preventing far-side tiles from being loaded.
            // World-wrapper tiles centred near the ECEF origin are exempt so they
            // always expand to their real geographic children.
            //
            // Squared form avoids sqrt:
            //   cos(θ) = dot / (|cam| * |tile|)
            //   cull when cos²(θ) < cos²(globeRadius)  →  dot² < cos²(gr) * camMag2 * tileMag2
            //   (dot < 0 also implies θ > 90°, always cull)
            if (node.children) {
                const camMag2 = cameraPos ?
                    cameraPos[0] ** 2 + cameraPos[1] ** 2 + cameraPos[2] ** 2 :
                    0;
                // Cached in _updateCore (frame-constant). Only consulted inside
                // the !globeMode && cameraPos branch below, so value elsewhere is irrelevant.
                const cosGr2 = this._cosGr2;
                await Promise.all(node.children.map((child) => {
                    if (!this.globeMode && cameraPos && child.boundingVolume?.box) {
                        const [bx, by, bz] = child.boundingVolume.box;
                        const Tx = bx, Ty = bz, Tz = -by; // ECEF Z-up → engine Y-up
                        const tileMag2 = Tx * Tx + Ty * Ty + Tz * Tz;
                        if (tileMag2 > 0.01 * camMag2) { // skip world-wrapper tiles at origin
                            const dot = cameraPos[0] * Tx + cameraPos[1] * Ty + cameraPos[2] * Tz;
                            if (dot < 0 || dot * dot < cosGr2 * camMag2 * tileMag2) {
                                return Promise.resolve(); // outside globeRadius cone
                            }
                        }
                    }
                    const priority = this._computePriority(child, cameraPos, fovY, screenHeight);
                    return this.loadContent(child, priority);
                }));
            }

            // Wait one render frame so the GPU has had a chance to draw the newly loaded
            // child entities before we hide the parent. Without this delay, the parent
            // disappears on the same frame the children finish parsing — one frame before
            // they appear on screen — producing a visible hole on every LOD switch.
            // The token guards against a collapse + re-expand race during the RAF wait:
            // if collapseNode fires and expandNode is called again, a new token is written,
            // so this stale continuation skips the hide and the fresh call takes over.
            const token = Symbol('expandToken');
            // eslint-disable-next-line require-atomic-updates -- `node` is a never-reassigned parameter
            node.__expandToken = token;
            await new Promise((resolve) => {
                requestAnimationFrame(resolve);
            });

            if (this.expandedNodes.has(node) && node.__expandToken === token) {
                if (node.content?.uri.includes('.glb')) {
                    // This node has a GLB entity — hide it now that its children are ready.
                    this.handlers.hide(node);
                    this.contentHidden.set(this._getNodeContentKey(node), true);
                    // Walk further up to hide coarser ancestors now fully covered.
                    this._hideCoarserAncestors(node.__parent ?? null);
                } else {
                    // .json wrapper: its visual coverage comes from its nearest .glb ancestor
                    // (shown when this subtree was last collapsed). Hide that ancestor now
                    // that this wrapper's children are loaded and visible on screen.
                    const toHide = this._findVisualAncestor(node);
                    if (toHide) {
                        this.handlers.hide(toHide);
                        this.contentHidden.set(this._getNodeContentKey(toHide), true);
                        // Walk further up to hide coarser ancestors now fully covered.
                        this._hideCoarserAncestors(toHide.__parent ?? null);
                    }
                }
            }
        }
    }

    /**
     * Collapsing a node will unload all content from child nodes. The node's content
     * is then shown (since it should already be loaded).
     *
     * @param {object} node - The node to collapse.
     */
    collapseNode(node) {
        // Recursively collapse any children that were themselves expanded before unloading them
        if (node.children) {
            for (const child of node.children) {
                if (this.expandedNodes.has(child)) {
                    this.collapseNode(child);
                }
                this.unloadContent(child);
            }
        }

        // Show the nearest .glb ancestor as the visual replacement for this node.
        // For a .glb node that is the replacement itself. For a .json wrapper it's
        // the closest .glb up the __parent chain — the entity that was hidden when
        // this subtree was first expanded.
        const toShow = this._findVisualAncestor(node);
        if (toShow && toShow.__regionMode !== 'hide') {
            this.handlers.show(toShow);
            this.contentHidden.set(this._getNodeContentKey(toShow), false);
        }

        this.expandedNodes.delete(node);
    }

    /**
     * Update the tile manager based on the current camera state (raw tile-space path).
     *
     * @param {number[]} cameraPos - Camera position as [x, y, z] in tile-Y space.
     * @param {number} [fovY] - Vertical field of view in radians (for SSE formula).
     * @param {number} [screenHeight] - Render target height in pixels (for SSE formula).
     * @param {object[]|null} [frustumPlanes] - Six PlayCanvas Plane objects for frustum culling.
     * @param {number[]|null} [worldOffset] - World entity position [x, y, z] in PlayCanvas world space.
     */
    update(cameraPos, fovY, screenHeight, frustumPlanes, worldOffset) {
        const frustumCtx = (frustumPlanes && worldOffset) ?
            { mode: 'translate', planes: frustumPlanes, worldOffset } :
            null;
        this._updateCore(cameraPos, fovY, screenHeight, frustumCtx);
    }

    /**
     * Shared traversal driver used by both `update()` (raw tile-Y path) and
     * `updateLocal()` (local-frame path). Operates entirely in tile-Y — callers
     * convert their camera / frustum inputs into this space first.
     *
     * @param {number[]} cameraPos - Camera position in tile-Y.
     * @param {number|undefined} fovY - Vertical FOV in radians (for SSE).
     * @param {number|undefined} screenHeight - Render target height in pixels (for SSE).
     * @param {object|null} frustumCtx - See isInView() for shape.
     */
    _updateCore(cameraPos, fovY, screenHeight, frustumCtx) {
        // ── Cache per-frame constants (lifted out of per-node loops) ─────────
        this._frameSseDenom = fovY !== undefined ? 2 * Math.tan(fovY / 2) : 0;
        if (this._cachedGlobeRadiusDeg !== this.globeRadius) {
            this._cosGr = Math.cos(this.globeRadius * Math.PI / 180);
            this._cosGr2 = this._cosGr * this._cosGr;
            this._cachedGlobeRadiusDeg = this.globeRadius;
        }

        // ── SSE bias auto-tune (shared) ────────────────────────────────────
        // Hysteresis: ratchet up only when we are meaningfully over the cap
        // (configurable via `sseBiasOvershootFactor`, default 1.3x). Decay
        // is unconditional whenever bias > 1, so the value returns to 1
        // cleanly once the working set drops back in budget. Prevents the
        // every-frame oscillation that otherwise causes tiles to
        // load/unload near the cap. The higher overshoot tolerance lets
        // transient overshoots during pan/zoom transitions ride out
        // without LOD collapse -- eviction handles the excess silently.
        if (this.softTileLimit != null &&
            this._loadedGlbCount > this.softTileLimit * this.sseBiasOvershootFactor) {
            this._sseBias = Math.min(this._sseBias * 1.1, 10);
        } else if (this._sseBias > 1) {
            this._sseBias = Math.max(this._sseBias * 0.98, 1);
        }

        // ── Adaptive SSE from frame time ────────────────────────────────────
        // Mirror of the memory block but driven by frame time instead of
        // tile count. Ramps `_adaptiveBias` up when the smoothed frame time
        // sustainedly exceeds 1.5x target (frames are slow); decays back
        // when below 1.1x (frames are comfortable). The two biases multiply
        // wherever `_sseBias` is consumed, so the effective threshold is
        // `maximumScreenSpaceError * _sseBias * _adaptiveBias`. This is the
        // single biggest "feels smooth" mechanism in Cesium / Google
        // viewers: bursts of demand silently coarsen the target instead of
        // tanking the frame.
        const slowFrameMs = this.targetFrameMs * 1.5;
        const fastFrameMs = this.targetFrameMs * 1.1;
        if (this._frameTimeMs > slowFrameMs) {
            this._adaptiveBias = Math.min(this._adaptiveBias * 1.05, this.adaptiveSseBiasMax);
        } else if (this._frameTimeMs < fastFrameMs && this._adaptiveBias > 1) {
            this._adaptiveBias = Math.max(this._adaptiveBias * 0.97, 1);
        }

        if (this.useSelectionMode) {
            this._updateCoreSelection(cameraPos, fovY, screenHeight, frustumCtx);
            return;
        }

        // ── State reconciliation ─────────────────────────────────────────────
        // Repair drift between expandedNodes, __contentLoaded, contentHidden,
        // and handler-side entity presence. Without this, async aborts /
        // mutations leave orphans that accumulate over many frames.
        this._reconcileState();

        // Reuse snapshot buffer; expandNode can mutate expandedNodes mid-pass.
        const expandedNodes = this._expandedSnapshot;
        expandedNodes.length = 0;
        for (const n of this.expandedNodes) expandedNodes.push(n);

        // ── Collapse pass ────────────────────────────────────────────────────
        // Collect all out-of-range nodes whose visual replacement is ready.
        const toCollapse = [];
        for (const node of expandedNodes) {
            if (!this.expandedNodes.has(node)) continue;
            if (!(this.isInView(node, frustumCtx) && this.isInRange(node, cameraPos, fovY, screenHeight))) {
                if (this._collapseIsReady(node)) {
                    toCollapse.push(node);
                }
            }
        }

        // Only collapse "root" out-of-range nodes — nodes whose direct parent is also
        // being collapsed this frame are redundant: the parent's collapseNode will
        // recurse into them in the correct order, avoiding double-unload flicker.
        const collapseSet = new Set(toCollapse);
        for (const node of toCollapse) {
            if (!this.expandedNodes.has(node)) continue;  // already handled by a parent
            if (node.__parent && collapseSet.has(node.__parent)) continue;
            this.collapseNode(node);
        }

        // ── Expand pass (skip-LOD capable) ───────────────────────────────────
        // Walk up to `maxSkipDepth` levels deep from each currently-expanded
        // node per frame. expandNode is idempotent (guarded by expandedNodes
        // membership) so deep-recursing past already-expanded intermediate
        // tiles is free. The recursion only materialises a deeper LOD when
        // that level's `.children` array is already populated — typical for
        // tiles inlined in the root JSON or previously touched by loadContent.
        const expandChildren = (parent, remaining) => {
            if (remaining <= 0 || !parent.children) return;
            for (const child of parent.children) {
                if (!child.children) continue;
                if (!this.isInView(child, frustumCtx)) continue;
                if (!this.isInRange(child, cameraPos, fovY, screenHeight)) continue;
                this.expandNode(child, cameraPos, fovY, screenHeight).catch(err => console.error('Error expanding node:', err));
                expandChildren(child, remaining - 1);
            }
        };
        for (const node of expandedNodes) {
            if (!this.expandedNodes.has(node)) continue;  // collapsed in pass above
            expandChildren(node, this.maxSkipDepth);
        }
    }

    /**
     * Reconciles the three state vectors — `expandedNodes`, `node.__contentLoaded`,
     * and handler-side entity presence — that can drift apart across async
     * boundaries (aborted loads, collapse-during-load races, region changes).
     *
     * Without this, orphan state accumulates each frame: nodes marked loaded
     * with no entity, expanded nodes whose load silently aborted, etc. Over
     * time this starves expansion and inflates the loaded count.
     *
     * O(|expandedNodes|) per call — bounded by softTileLimit so this is cheap.
     */
    _reconcileState() {
        const toEvict = [];
        for (const node of this.expandedNodes) {
            // A `.glb` expanded node whose content load was aborted silently
            // has __contentLoaded=false. It cannot serve as a visual parent —
            // drop from expandedNodes so the expand pass can retry.
            //
            // Note: we deliberately do NOT do an orphan check on
            // (__contentLoaded=true + !hasEntity) — with frame-budgeted
            // instantiation there is a long legitimate window where the flag
            // is true but the entity hasn't been created yet, and false
            // positives there would evict in-flight loads every tick.
            const uri = node.content?.uri;
            if (uri && uri.includes('.glb') && node.__contentLoaded === false) {
                toEvict.push(node);
            }
        }
        for (const node of toEvict) {
            this.expandedNodes.delete(node);
            if (node.content) this.contentHidden.delete(this._getNodeContentKey(node));
        }
    }

    /**
     * Define geographic regions that affect streamed-tile display or lifetime.
     * Replaces any previously set regions.
     *
     * Modes:
     *   'hide'        - tiles whose centre is in the polygon are hidden.
     *   'transparent' - tiles whose centre is in the polygon are faded to `opacity`.
     *   'pin'         - tiles whose centre is in the polygon (or within the
     *                   tile's own bounding-sphere radius of the polygon's
     *                   bbox) are skipped by softTileLimit eviction. Use to
     *                   keep an area-of-interest resident under a tight cap
     *                   without boundary-tile eviction churn. The buffered
     *                   bbox check pins boundary tiles whose centres lie just
     *                   outside the polygon but whose footprints overlap it.
     *                   Caveat: if the pinned set exceeds softTileLimit, the
     *                   cap stops being enforced -- caller must size the
     *                   polygon and cap so the pinned set fits.
     *
     * @param {Array<{polygon: number[][], mode: string, opacity: number}>} regions
     * - Each region specifies a ground-plane polygon in lon/lat degrees, a display
     * mode (`'hide'`, `'transparent'`, or `'pin'`), and (for `'transparent'`) an
     * opacity value in [0, 1].
     */
    setRegions(regions) {
        this.regions = regions.map((r) => {
            const lons = r.polygon.map(p => p[0]);
            const lats = r.polygon.map(p => p[1]);
            return {
                ...r,
                _bbox: {
                    minLon: Math.min(...lons),
                    maxLon: Math.max(...lons),
                    minLat: Math.min(...lats),
                    maxLat: Math.max(...lats)
                }
            };
        });
    }

    /**
     * Returns the first region whose polygon contains the tile's ground-plane center,
     * or null if the tile is outside all regions.
     *
     * @param {object} node - The tile node to test.
     * @returns {?{polygon: number[][], mode: string, opacity: number}} The matching
     * region, or null if the node's center is outside every region.
     */
    _regionForNode(node) {
        if (!this.regions.length || !node.boundingVolume?.box) return null;

        // boundingVolume.box center is standard ECEF (Z-up): bx=eqX, by=eqY, bz=polar.
        // cartesianToGeodetic() expects engine Y-up space, so remap:
        //   engine x = bx,  engine y (up/polar) = bz,  engine z = -by
        const [bx, by, bz] = node.boundingVolume.box;
        const [lon, lat] = cartesianToGeodetic(bx, bz, -by);

        for (const r of this.regions) {
            if (lon < r._bbox.minLon || lon > r._bbox.maxLon ||
                lat < r._bbox.minLat || lat > r._bbox.maxLat) continue;
            if (this._pointInPolygon(lon, lat, r.polygon)) return r;
        }
        return null;
    }

    /**
     * Ray-cast point-in-polygon test (crossing-number algorithm).
     * Works correctly for convex and concave polygons on a flat lon/lat plane.
     *
     * @param {number} lon - Longitude of the test point, in degrees.
     * @param {number} lat - Latitude of the test point, in degrees.
     * @param {number[][]} polygon - Array of [lon, lat] vertices.
     * @returns {boolean} true if the point lies inside the polygon.
     */
    _pointInPolygon(lon, lat, polygon) {
        let inside = false;
        const n = polygon.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = polygon[i][0], yi = polygon[i][1];
            const xj = polygon[j][0], yj = polygon[j][1];
            const intersects = ((yi > lat) !== (yj > lat)) &&
                (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
            if (intersects) inside = !inside;
        }
        return inside;
    }

    /**
     * Returns true if `node` lies inside any region with mode === 'pin'.
     * Pinning uses a buffered-bbox test (polygon bbox expanded by the tile's
     * own bounding-sphere radius converted to degrees) so boundary tiles
     * whose centres lie just outside the polygon -- but whose footprints
     * intersect it -- are pinned too. This matches the AABB-style clip test
     * a viewer typically runs for fragment-shader discard.
     *
     * Used by softTileLimit eviction to skip pinned nodes when picking
     * eviction candidates.
     *
     * @param {object} node - The tile node to test.
     * @returns {boolean} true if the node lies inside any region with mode 'pin'.
     */
    _isPinnedNode(node) {
        if (!this.regions.length || !node.boundingVolume?.box) return false;

        const box = node.boundingVolume.box;
        const [bx, by, bz] = box;
        const [lon, lat] = cartesianToGeodetic(bx, bz, -by);

        // Bounding-sphere radius (metres) -> ~degree buffer at midlat.
        // 1 deg latitude ~= 111 km. The box half-axes are orthogonal per
        // the 3D Tiles spec, so the diagonal magnitude (= sphere radius)
        // is just the Euclidean norm of the three half-axis vectors.
        const xx = box[3], xy = box[4], xz = box[5];
        const yx = box[6], yy = box[7], yz = box[8];
        const zx = box[9], zy = box[10], zz = box[11];
        const r = Math.sqrt(xx * xx + xy * xy + xz * xz +
                            yx * yx + yy * yy + yz * yz +
                            zx * zx + zy * zy + zz * zz);
        const buf = r / 111000;

        for (const reg of this.regions) {
            if (reg.mode !== 'pin') continue;
            if (lon < reg._bbox.minLon - buf || lon > reg._bbox.maxLon + buf ||
                lat < reg._bbox.minLat - buf || lat > reg._bbox.maxLat + buf) continue;
            return true;
        }
        return false;
    }

    _assignBaseUrl(node, baseUrl, parent = null) {
        Object.defineProperty(node, '__baseUrl', {
            configurable: true,
            enumerable: false,
            value: baseUrl,
            writable: true
        });
        Object.defineProperty(node, '__parent', {
            configurable: true,
            enumerable: false,
            value: parent,
            writable: true
        });

        if (node.children) {
            for (const child of node.children) {
                this._assignBaseUrl(child, baseUrl, node);
            }
        }
    }

    /**
     * Walks up the __parent chain to find the nearest ancestor with a .glb content URI.
     * For a .glb node, returns the node itself. For a .json wrapper or content-less node,
     * returns the first .glb ancestor, or null if none exists.
     *
     * @param {object} node - The tile node to start the walk from.
     * @returns {object|null} The nearest .glb ancestor (or `node` itself), or null.
     */
    _findVisualAncestor(node) {
        let cur = node;
        while (cur) {
            if (cur.content?.uri.includes('.glb')) return cur;
            cur = cur.__parent ?? null;
        }
        return null;
    }

    /**
     * Returns true if it is safe to collapse a node right now — i.e. its visual
     * replacement (the nearest .glb ancestor) has a loaded entity ready to take over.
     *
     * For a .glb node the replacement is itself (always ready).
     * For a .json wrapper the replacement is the nearest .glb ancestor; we check that
     * expandNode previously hid that ancestor (contentHidden === true), which confirms
     * the entity was loaded. If no such ancestor exists we defer the collapse to avoid
     * creating an unrecoverable hole.
     *
     * @param {object} node - The tile node being considered for collapse.
     * @returns {boolean} true if the node's visual replacement is loaded and ready.
     */
    _collapseIsReady(node) {
        const ancestor = this._findVisualAncestor(node);
        if (!ancestor) return false;
        if (ancestor === node) return true;  // .glb node — replacement is itself, always ready
        const key = this._getNodeContentKey(ancestor);
        return this.contentHidden.get(key) === true;
    }

    /**
     * Walks up the __parent chain from `startNode` and hides every .glb ancestor
     * that is currently shown (contentHidden === false).
     *
     * This fixes the "lowest-detail tiles stuck after zoom-out → zoom-in" bug:
     * a zoom-out collapse shows a coarse .glb ancestor via _findVisualAncestor;
     * on zoom-in, expandNode previously only hid the immediate refinement target,
     * leaving coarser ancestors visible. This method clears them all.
     *
     * @param {object|null} startNode - The first node to check (typically `toHide.__parent`).
     */
    /**
     * Acquires one of the maxConcurrentRequests fetch slots. If all slots are
     * occupied, the caller suspends in a max-heap priority queue until one is
     * released. Higher priority (= higher SSE) callers are unblocked first so
     * coarse, high-error tiles load before fine-detail ones.
     *
     * @param {number} [priority] - SSE or equivalent score; higher = more urgent.
     * @param {object|null} [node] - Tile node associated with the queued request.
     * @param {AbortSignal|null} [signal] - Optional cancellation signal.
     * @returns {Promise<void>}
     */
    _acquireRequestSlot(priority = 0, node = null, signal = null) {
        if (this._activeRequests < this.maxConcurrentRequests) {
            this._activeRequests++;
            this.streamingStats.setGauge('activeNetwork', this._activeRequests);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, priority, node, signal, onAbort: null };
            if (signal) {
                entry.onAbort = () => {
                    const index = this._requestQueue.indexOf(entry);
                    if (index >= 0) {
                        this._requestQueue.splice(index, 1);
                        this._requestQueue.sort((a, b) => b.priority - a.priority);
                    }
                    this.streamingStats.setGauge('queuedNetwork', this._requestQueue.length);
                    const err = new Error('Aborted');
                    err.name = 'AbortError';
                    reject(err);
                };
                if (signal.aborted) {
                    entry.onAbort();
                    return;
                }
                signal.addEventListener('abort', entry.onAbort, { once: true });
            }
            this._heapPush(entry);
            this.streamingStats.setGauge('queuedNetwork', this._requestQueue.length);
        });
    }

    /**
     * Releases a fetch slot. The highest-priority waiter is unblocked next
     * (slot transferred, active count unchanged); if no waiters the count drops.
     */
    _releaseRequestSlot() {
        if (this._requestQueue.length > 0) {
            const entry = this._heapPop();
            if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
            entry.resolve();
        } else {
            this._activeRequests--;
        }
        this.streamingStats.setGauge('activeNetwork', this._activeRequests);
        this.streamingStats.setGauge('queuedNetwork', this._requestQueue.length);
    }

    _acquireDecodeSlot(node, priority = 0, signal = null) {
        if (this._activeDecodes < this.maxConcurrentDecodes) {
            this._activeDecodes++;
            this.streamingStats.setGauge('activeDecode', this._activeDecodes);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const entry = { node, priority, resolve, reject, signal, onAbort: null };
            if (signal) {
                entry.onAbort = () => {
                    const index = this._decodeQueue.indexOf(entry);
                    if (index >= 0) this._decodeQueue.splice(index, 1);
                    this.streamingStats.setGauge('queuedDecode', this._decodeQueue.length);
                    const err = new Error('Aborted');
                    err.name = 'AbortError';
                    reject(err);
                };
                if (signal.aborted) {
                    entry.onAbort();
                    return;
                }
                signal.addEventListener('abort', entry.onAbort, { once: true });
            }
            this._decodeQueue.push(entry);
            this._decodeQueue.sort((a, b) => b.priority - a.priority);
            this.streamingStats.setGauge('queuedDecode', this._decodeQueue.length);
        });
    }

    _releaseDecodeSlot() {
        if (this._decodeQueue.length > 0) {
            const entry = this._decodeQueue.shift();
            if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
            entry.resolve();
        } else {
            this._activeDecodes--;
        }
        this.streamingStats.setGauge('activeDecode', this._activeDecodes);
        this.streamingStats.setGauge('queuedDecode', this._decodeQueue.length);
    }

    // ── Max-heap for the priority queue ──────────────────────────────────────

    _heapPush(entry) {
        this._requestQueue.push(entry);
        let i = this._requestQueue.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this._requestQueue[parent].priority >= this._requestQueue[i].priority) break;
            [this._requestQueue[parent], this._requestQueue[i]] = [this._requestQueue[i], this._requestQueue[parent]];
            i = parent;
        }
    }

    _heapPop() {
        const top = this._requestQueue[0];
        const last = this._requestQueue.pop();
        if (this._requestQueue.length > 0) {
            this._requestQueue[0] = last;
            let i = 0;
            const n = this._requestQueue.length;
            while (true) {
                let largest = i;
                const l = 2 * i + 1, r = 2 * i + 2;
                if (l < n && this._requestQueue[l].priority > this._requestQueue[largest].priority) largest = l;
                if (r < n && this._requestQueue[r].priority > this._requestQueue[largest].priority) largest = r;
                if (largest === i) break;
                [this._requestQueue[i], this._requestQueue[largest]] = [this._requestQueue[largest], this._requestQueue[i]];
                i = largest;
            }
        }
        return top;
    }

    /**
     * Target-focused request priority with a foveation weight (Option B + C
     * from the priority plan). The SSE component peaks at the target level
     * (`maximumScreenSpaceError`) and decays as the tile grows coarser, so
     * finer user-visible tiles load before root-scale ancestors. The
     * foveation component multiplies by a factor in [0.3, 1.0] based on how
     * closely the tile sits on the camera-forward axis — center-of-view
     * tiles beat edges of view. Forward is optional; if absent the
     * foveation factor is 1 (pure Option B).
     *
     * @param {object} node - The tile node to score.
     * @param {number[]} cameraPos - Camera position in tile-Y space.
     * @param {number|undefined} fovY - Vertical FOV in radians (SSE component).
     * @param {number|undefined} screenHeight - Render target height in pixels (SSE component).
     * @returns {number} The request priority; higher loads sooner.
     */
    _computePriority(node, cameraPos, fovY, screenHeight) {
        if (!node.boundingVolume?.box || !cameraPos) return 0;
        const [bx, by, bz] = node.boundingVolume.box;
        const tx = bx, ty = bz, tz = -by;  // ECEF Z-up → tile-Y
        const dx = tx - cameraPos[0];
        const dy = ty - cameraPos[1];
        const dz = tz - cameraPos[2];
        const dist = Math.max(length(dx, dy, dz), 1e-7);

        // SSE component: ideal = 1, coarser tiles < 1 via log falloff so
        // root-scale tiles still get a finite (small) priority instead of
        // zero. Without geometricError / fov / screen we fall back to a
        // 1/dist weight.
        let ssePart = 1;
        const ge = node.geometricError;
        if (ge !== undefined && fovY !== undefined && screenHeight !== undefined) {
            const sseDenom = this._frameSseDenom > 0 ? this._frameSseDenom : 2 * Math.tan(fovY / 2);
            const sse = (ge * screenHeight) / (dist * sseDenom);
            const threshold = Math.max(this.maximumScreenSpaceError, 1);
            const ratio = Math.max(sse / threshold, 1);
            ssePart = 1 / (1 + Math.log(ratio));  // 1 at target, ~0.3 at 10x, ~0.07 at root
        } else {
            ssePart = 1 / (1 + dist * 1e-5);
        }

        // Foveation: additive bonus 0 (off-axis) .. 0.7 (on-axis). Dot of
        // camera-forward and tile-direction. Additive so that off-axis
        // tiles aren't multiplicatively suppressed (the old ssePart *
        // foveation could starve a high-SSE off-screen tile of slots
        // even though it was needed for the next pan tick).
        let foveationBonus = 0;
        if (this._cameraForwardTileY) {
            const f = this._cameraForwardTileY;
            const cosA = (dx * f[0] + dy * f[1] + dz * f[2]) / dist;
            foveationBonus = 0.7 * Math.max(0, cosA);
        }

        // Motion alignment: tiles in the direction of camera motion get
        // a priority boost so they preload before the camera arrives. Only
        // engages when the camera is actually moving (> ~1 m/s). Aligned
        // tiles get the full bonus; tiles behind get zero (not penalized,
        // foveation already handles that axis).
        let motionAlign = 0;
        let rawMotionAlign = 0;
        const v = this._cameraVelocityTileY;
        const vmag2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        if (vmag2 > 1) {
            const vmag = Math.sqrt(vmag2);
            const align = (dx * v[0] + dy * v[1] + dz * v[2]) / (dist * vmag);
            rawMotionAlign = align;
            motionAlign = Math.max(0, align);
        }

        // Closeness: 1/dist normalized to [0..1]. 1 at the camera, ~0.5 at
        // 10 km, ~0.09 at 100 km. Boosts near-camera tiles over equally-
        // scored far-camera tiles -- without this an off-axis distant tile
        // and an off-axis close tile of similar SSE compete on equal terms.
        const closeness = 1 / (1 + dist * 1e-4);

        const forwardAlign = this._cameraForwardTileY ?
            (dx * this._cameraForwardTileY[0] + dy * this._cameraForwardTileY[1] +
                dz * this._cameraForwardTileY[2]) / dist : 0;
        const behindPenalty = forwardAlign < -0.2 && rawMotionAlign < -0.2 ? 0.75 : 0;

        return ssePart +
            foveationBonus +
            this.priorityClosenessWeight * closeness +
            this.priorityMotionWeight * motionAlign -
            behindPenalty;
    }

    // ── Selection-based pipeline ────────────────────────────────────────
    // Methods below implement a per-frame selection model. They are pure with
    // respect to terratile's state (read `__contentLoaded`, `children`,
    // bounding volumes; don't mutate anything). `_updateCore` does not yet
    // call them — that's behind the `useSelectionMode` flag.

    /**
     * Entry point: walk the tileset from the stored root and produce the
     * frame's visibility decision as two flat collections.
     *
     * @param {number[]} cameraPos - Camera position in tile-Y space.
     * @param {number|undefined} fovY - Vertical FOV in radians (SSE calc).
     * @param {number|undefined} screenHeight - Render target height (SSE calc).
     * @param {object|null} frustumCtx - See `isInView` for shape.
     * @returns {{ selected: Set<object>, requested: Array<{node: object, priority: number}>, immune: Set<object> }}
     * The set of nodes to keep visible this frame; the list of nodes whose
     * content should be requested, each with its computed priority; and the
     * set of loaded-but-unselected nodes that must survive this frame's
     * eviction because a wave hold is waiting on them (always empty in
     * `'legacy'` mode -- nothing populates it there).
     */
    _select(cameraPos, fovY, screenHeight, frustumCtx) {
        const selected = new Set();
        const requested = [];
        const immune = new Set();
        this._lastAtomicHoldCount = 0;
        this._lastCoverageGapCount = 0;
        this._lastRefinementTargetCount = 0;
        this._lastTransitionCount = 0;
        if (!this._root) return { selected, requested, immune };
        const ctx = {
            cameraPos,
            fovY,
            screenHeight,
            frustumCtx,
            selected,
            requested,
            requestedByNode: new Map(),
            immune,
            prefetchState: { speculativeCount: 0 },
            frameNumber: this._frameNumber
        };
        // Defensive: force pool depth back to 0 at the start of every
        // selection pass. Normally balanced by _releaseChildScratch but a
        // thrown error mid-recursion could otherwise leave it inflated.
        this._childScratchDepth = 0;
        this._selectSubtree(this._root, null, ctx);
        // A transition not reached by this frame's in-view traversal is no
        // longer useful. Restore its materials and release its immunity.
        for (const [parent, transition] of this._activeTransitions) {
            if (transition.seenFrame === this._frameNumber) continue;
            this._finishTransition(parent, transition.children);
            this._activeTransitions.delete(parent);
        }
        this._lastTransitionCount = this._activeTransitions.size;
        this._lastSpeculativeRequestCount = ctx.prefetchState.speculativeCount;
        return { selected, requested, immune };
    }

    _setFade(node, progress, direction) {
        if (typeof this.handlers.setFade === 'function') {
            this.handlers.setFade(node, progress, direction);
        }
    }

    _finishTransition(parent, children) {
        this._setFade(parent, 1, 'steady');
        for (let i = 0; i < children.length; i++) {
            this._setFade(children[i], 1, 'steady');
        }
    }

    _nodeDepth(node) {
        let depth = 0;
        for (let current = node?.__parent; current; current = current.__parent) depth++;
        return depth;
    }

    /**
     * Diff host-side stencil state against this frame's mixed-LOD selection.
     * The core remains renderer-agnostic: hosts that support mixed coverage
     * receive only a stable tree depth and decide how to encode it.
     * @param {Set<object>} selected - Nodes selected for display this frame.
     */
    _applyMixedSelectionState(selected) {
        const enabled = this.refinementMode === 'mixed' &&
            typeof this.handlers.setMixed === 'function';

        for (const node of this._mixedConfiguredNodes) {
            if (!enabled || !selected.has(node)) {
                if (typeof this.handlers.clearMixed === 'function') {
                    this.handlers.clearMixed(node);
                }
            }
        }

        if (!enabled) {
            this._mixedConfiguredNodes.clear();
            return;
        }

        for (const node of selected) {
            if (!this._mixedConfiguredNodes.has(node)) {
                this.handlers.setMixed(node, this._nodeDepth(node));
            }
        }
        this._mixedConfiguredNodes = new Set(selected);
    }

    /**
     * Collect the first renderable replacement frontier below `node` without
     * descending through a renderable GLB. External-tileset JSON wrappers and
     * contentless structural nodes are transparent; an unresolved JSON wrapper
     * is itself returned so the atomic pass can request it while retaining the
     * current parent as coverage.
     *
     * @param {object} node - A direct child (or transparent descendant) of the
     * refining renderable parent.
     * @param {object[]} out - Destination array, reused by the caller.
     */
    _collectReplacementFrontier(node, out) {
        if (!node) return;
        const uri = node.content?.uri;
        if (uri?.includes('.glb')) {
            out.push(node);
            return;
        }
        if (uri?.includes('.json') && (!node.children || node.children.length === 0)) {
            out.push(node);
            return;
        }
        if (node.children && node.children.length > 0) {
            for (let i = 0; i < node.children.length; i++) {
                this._collectReplacementFrontier(node.children[i], out);
            }
            return;
        }
        // Unknown/unsupported leaf content cannot provide replacement
        // coverage. Keep it in the frontier so atomic mode holds the parent
        // instead of silently treating the area as complete.
        if (node.content) out.push(node);
    }

    _queueSpeculativeDescendants(node, ctx, depth) {
        if (depth <= 0 || !node?.children || node.children.length === 0) return;
        const state = ctx.prefetchState;
        if (!state || state.speculativeCount >= this.maxSpeculativeRequestsPerFrame) return;
        const frontier = [];
        for (let i = 0; i < node.children.length; i++) {
            this._collectReplacementFrontier(node.children[i], frontier);
        }
        for (let i = 0; i < frontier.length; i++) {
            if (state.speculativeCount >= this.maxSpeculativeRequestsPerFrame) break;
            const target = frontier[i];
            if (!target.__contentLoaded && !this._isEntityReady(target)) {
                if (this._pushRequest(target, ctx, true, 'speculative')) state.speculativeCount++;
            }
            if (depth > 1 && (target.__contentLoaded || this._isEntityReady(target))) {
                this._queueSpeculativeDescendants(target, ctx, depth - 1);
            }
        }
    }

    /**
     * Strict direct-frontier REPLACE refinement. The current renderable node
     * remains selected until every frontier member is render-ready. The first
     * all-ready frame commits exactly that frontier; deeper refinement begins
     * on later frames, preventing unbounded deep fan-out.
     *
     * @param {object} node - Renderable parent being refined.
     * @param {object} ancestor - Nearest loaded ancestor (normally `node`).
     * @param {object} ctx - Per-frame selection context.
     * @returns {boolean} true when this subtree has visible coverage.
     */
    _selectAtomicFrontier(node, ancestor, ctx) {
        const frontier = [];
        for (let i = 0; i < node.children.length; i++) {
            this._collectReplacementFrontier(node.children[i], frontier);
        }

        // A structural leaf with no discoverable replacement frontier cannot
        // refine. Keep its own content as the stable target.
        if (frontier.length === 0) {
            if (this._isEntityReady(node)) {
                ctx.selected.add(node);
                return true;
            }
            return false;
        }

        let allReady = true;
        const ready = [];
        for (let i = 0; i < frontier.length; i++) {
            const target = frontier[i];
            const uri = target.content?.uri;
            const targetReady = uri?.includes('.glb') && this._isEntityReady(target);
            if (targetReady) {
                ready.push(target);
                this._queueSpeculativeDescendants(target, ctx, this.speculativeDescendantDepth);
                continue;
            }

            allReady = false;
            this._lastRefinementTargetCount++;
            // The retry gate suppresses permanent/timed-dead targets while
            // allowing cooldown-expired targets to wake without an SSE change.
            this._pushRequest(target, ctx, true, 'frontier');
        }

        if (!allReady) {
            node.__atomicAdvancedFrame = undefined;
            const transition = this._activeTransitions.get(node);
            if (transition) {
                this._finishTransition(node, transition.children);
                this._activeTransitions.delete(node);
            }
            // Ready-but-held replacement pieces must survive memory pressure,
            // otherwise the all-ready condition can never converge.
            for (let i = 0; i < ready.length; i++) ctx.immune.add(ready[i]);

            if (this._isEntityReady(node)) {
                ctx.selected.add(node);
                this._lastAtomicHoldCount++;
                return true;
            }
            if (ancestor && this._isUsableAncestor(ancestor, ctx)) {
                ctx.selected.add(ancestor);
                this._lastAtomicHoldCount++;
                return true;
            }
            this._lastCoverageGapCount++;
            return false;
        }

        // Keep the immediate visible ancestor chain resident as fallback. This
        // mirrors traditional replacement traversal: levels may remain cached
        // even though only the frontier is rendered.
        if (this._isEntityReady(node)) ctx.immune.add(node);

        let transition = this._activeTransitions.get(node);
        if (transition) {
            transition.seenFrame = ctx.frameNumber;
            const frames = Math.max(1, this.transitionFrames);
            const progress = Math.min(1, (ctx.frameNumber - transition.startFrame) / frames);
            if (progress < 1) {
                ctx.selected.add(node);
                ctx.immune.add(node);
                this._setFade(node, progress, 'out');
                for (let i = 0; i < ready.length; i++) {
                    ctx.selected.add(ready[i]);
                    ctx.immune.add(ready[i]);
                    this._setFade(ready[i], progress, 'in');
                }
                return true;
            }
            this._finishTransition(node, ready);
            this._activeTransitions.delete(node);
            transition = null;
            node.__atomicAdvancedFrame = ctx.frameNumber;
            for (let i = 0; i < ready.length; i++) {
                if (this.isInView(ready[i], ctx.frustumCtx)) ctx.selected.add(ready[i]);
            }
            return true;
        }

        if (node.__atomicAdvancedFrame === undefined) {
            if (this.transitionMode === 'dither' &&
                this.transitionFrames > 0 &&
                typeof this.handlers.setFade === 'function') {
                transition = {
                    startFrame: ctx.frameNumber,
                    children: ready.slice(),
                    seenFrame: ctx.frameNumber
                };
                this._activeTransitions.set(node, transition);
                ctx.selected.add(node);
                ctx.immune.add(node);
                this._setFade(node, 0, 'out');
                for (let i = 0; i < ready.length; i++) {
                    ctx.selected.add(ready[i]);
                    ctx.immune.add(ready[i]);
                    this._setFade(ready[i], 0, 'in');
                }
                return true;
            }
            // Commit exactly one replacement level on the first all-ready
            // frame. Grandchildren are intentionally not considered yet.
            node.__atomicAdvancedFrame = ctx.frameNumber;
            for (let i = 0; i < ready.length; i++) {
                if (this.isInView(ready[i], ctx.frustumCtx)) ctx.selected.add(ready[i]);
            }
            return true;
        }

        // The frontier was committed on an earlier frame; its members may now
        // independently start their own direct-child atomic refinements.
        let covered = true;
        for (let i = 0; i < ready.length; i++) {
            if (!this._selectSubtree(ready[i], node, ctx)) covered = false;
        }
        return covered;
    }

    // Grab a reusable `{ selected, ctx }` pair from the stack pool,
    //  growing the pool on demand. Caller MUST pair with _releaseChildScratch.
    _getChildScratch() {
        if (this._childScratchDepth >= this._childScratchStack.length) {
            this._childScratchStack.push({
                selected: new Set(),
                ctx: {
                    cameraPos: null,
                    fovY: 0,
                    screenHeight: 0,
                    frustumCtx: null,
                    selected: null,
                    requested: null,
                    requestedByNode: null,
                    immune: null,
                    prefetchState: null,
                    frameNumber: 0
                }
            });
        }
        return this._childScratchStack[this._childScratchDepth++];
    }

    _releaseChildScratch(scratch) {
        scratch.selected.clear();
        this._childScratchDepth--;
    }

    /**
     * Frame driver when `useSelectionMode === true`. Replaces the legacy
     * expand/collapse state machine. Three phases:
     *   1. Compute the new selected set + request list from the tree.
     *   2. Apply show/hide as a diff against the previous frame's set.
     *   3. Kick off loads for requested nodes; track eviction for loaded
     *      nodes that haven't been selected for `evictionGraceFrames`.
     *
     * Per-frame constants and the SSE-bias tune are applied by the
     * shared `_updateCore` prologue — this method assumes they're set.
     *
     * @param {number[]} cameraPos - Camera position in tile-Y space.
     * @param {number|undefined} fovY - Vertical FOV in radians (SSE calc).
     * @param {number|undefined} screenHeight - Render target height in pixels (SSE calc).
     * @param {object|null} frustumCtx - Frustum-cull context; see `isInView` for shape.
     */
    _updateCoreSelection(cameraPos, fovY, screenHeight, frustumCtx) {
        this._frameNumber++;

        const { selected, requested, immune } = this._select(cameraPos, fovY, screenHeight, frustumCtx);
        if (typeof this.handlers.updateFrameContext === 'function') {
            this.handlers.updateFrameContext({
                frameNumber: this._frameNumber,
                cameraPos,
                cameraForward: this._cameraForwardTileY,
                cameraVelocity: this._cameraVelocityTileY,
                selected,
                immune
            });
        }
        if (typeof this.handlers.setProtectedNodes === 'function') {
            this.handlers.setProtectedNodes(immune);
        }
        this._applyMixedSelectionState(selected);
        // Wave-mode telemetry: nonzero while any hold is waiting on
        // descendants (a cheap "refinement in progress" signal).
        this._lastImmuneCount = immune.size;
        const wantedPipelineNodes = new Set(selected);
        for (const node of immune) wantedPipelineNodes.add(node);
        for (const request of requested) {
            wantedPipelineNodes.add(request.node);
        }
        this._refreshPipelinePriorities(requested);
        this._cancelStalePipelineJobs(wantedPipelineNodes);

        // Diff-apply with deferred hide. Process pending hides first — any
        // tile that dropped out of selection `deferredHideFrames` or more
        // frames ago AND hasn't been re-selected finally disappears. Then
        // show newly-selected tiles. Finally, queue this frame's drop-outs
        // (or hide them immediately when deferredHideFrames is 0 — the
        // atomic same-frame switch). Net effect at the default of 1: a
        // coarse parent stays visible one extra frame after its finer
        // children join `selected`, giving the children's GPU uploads a
        // tick to finalize before the parent is pulled. Avoids the classic
        // refine-frame hole.
        for (const [node, dropFrame] of this._pendingHide) {
            if (selected.has(node)) {
                this._pendingHide.delete(node);
            } else if (this._frameNumber - dropFrame >= this.deferredHideFrames) {
                this.handlers.hide(node);
                this._setLoadStage(node, TILE_LOAD_STAGES.RENDER_READY);
                node.__hideFrame = this._frameNumber;
                this._pendingHide.delete(node);
            }
        }
        for (const node of selected) {
            if (!this._prevSelected.has(node)) {
                // Oscillation telemetry: a node re-shown within 60 frames of
                // being selection-hidden is churn the user perceives as
                // flicker. Cheap monotonic counter for the viewer HUD; the
                // frame stamp lives on the node so bookkeeping dies with it.
                if (this._frameNumber - (node.__hideFrame ?? -Infinity) < 60) {
                    this._oscillationCount++;
                }
                // A host may keep unloaded content in a render-ready resident
                // cache. Revive it synchronously before show so a zoom-out or
                // revisit does not spend one frame with an empty selection
                // while the normal async load path catches up.
                this._restoreResident(node);
                this.handlers.show(node);
                this._setLoadStage(node, TILE_LOAD_STAGES.VISIBLE);
            }
        }
        for (const node of this._prevSelected) {
            if (!selected.has(node)) {
                if (this.deferredHideFrames === 0) {
                    this.handlers.hide(node);
                    this._setLoadStage(node, TILE_LOAD_STAGES.RENDER_READY);
                    node.__hideFrame = this._frameNumber;
                } else {
                    this._pendingHide.set(node, this._frameNumber);
                }
            }
        }
        this._prevSelected = selected;

        // Fire loads for requested nodes, highest priority first. Sorting
        // here matters because the first `maxConcurrentRequests` calls to
        // `_acquireRequestSlot` get slots immediately (bypassing the heap).
        // Without this sort, slot allocation would be first-come-first-
        // served by selection-walk order, not by SSE priority.
        // loadContent is idempotent (early-returns if __contentLoaded) so
        // blanket-resubmitting the whole list every frame is cheap.
        requested.sort((a, b) => b.priority - a.priority);
        // Per-frame budget: dispatch at most `maxNewRequestsPerFrame` new
        // loads this tick. Anything not fired this frame gets another shot
        // next frame (selection re-runs every frame with fresh priority,
        // and a tile ahead of motion may have even higher priority by
        // then). Caps the size of any single selection-walk burst so it
        // can't drown a subsequent frame's higher-priority requests.
        let fired = 0;
        const budget = this.maxNewRequestsPerFrame;
        for (let i = 0; i < requested.length && fired < budget; i++) {
            const req = requested[i];
            if (req.node.__contentLoaded || this._isEntityReady(req.node)) continue;
            if (!this._hasPipelineJobCapacity()) {
                this._preemptLowerPriorityPipelineJob(req.requestClass, req.priority);
                break;
            }
            fired++;
            this.loadContent(req.node, req.priority, req.requestClass).catch((err) => {
                if (err && err.name !== 'AbortError') {
                    console.error('Error loading content:', err);
                }
            });
        }

        // Eviction tracking: every loaded-but-not-selected node gets its
        // "last-selected" timestamp set the moment it falls out of selection.
        // Selected nodes reset to the current frame so they're top-of-LRU.
        const now = this._frameNumber;
        for (const node of this._loadedNodes) {
            if (selected.has(node)) {
                this._notSelectedSince.set(node, now);
            } else if (!this._notSelectedSince.has(node)) {
                this._notSelectedSince.set(node, now);
            }
        }

        // Memory-pressure eviction (Cesium-style). A tile stays in memory
        // as long as there's budget; we only unload when the count crosses
        // softTileLimit * evictionOvershootFactor. When the threshold is
        // crossed, we drop all the way back to softTileLimit -- the
        // overshoot gives transitions room to bring in a burst of new
        // tiles without the eviction loop fighting them on every frame.
        // Net behaviour: utilization rides between 1.0x and the overshoot
        // factor (default 1.3x), with brief spikes triggering one big
        // eviction sweep rather than tight frame-by-frame trimming.
        //
        // Score = age-since-not-selected (frames) + distanceWeight * dist.
        // Higher score = evict first. The distance term breaks the pure-LRU
        // tie when a recently-dropped far tile shares the same age as a
        // recently-dropped near tile — the far one is much less useful as
        // a coverage fallback for the camera's current location and goes
        // first, freeing slots for in-view requests.
        if (this.softTileLimit != null &&
            this._loadedGlbCount > this.softTileLimit * this.evictionOvershootFactor) {
            // Two-tier eviction:
            //   Tier 1 ("orphan"): tiles the omni walk did NOT reach this
            //   frame. These are out-of-coverage entirely -- safe to drop
            //   first, sorted by age + distance like before.
            //   Tier 2 ("walked-blanket"): tiles the omni walk DID reach
            //   but are not currently selected (i.e., the OOV coverage
            //   ring). These are the user-felt blanket and we don't want
            //   to lose them -- but if Tier 1 didn't free enough budget,
            //   we drop the FINEST (= highest current SSE) walked tiles
            //   first because coarse tiles cover more area per byte.
            const tier1 = [];
            const tier2 = [];
            const w = this.evictionDistanceWeight;
            const cx = cameraPos ? cameraPos[0] : 0;
            const cy = cameraPos ? cameraPos[1] : 0;
            const cz = cameraPos ? cameraPos[2] : 0;
            for (const node of this._loadedNodes) {
                if (selected.has(node)) continue;
                if (this._isPinnedNode(node)) continue;
                // Wave mode: a held frontier tile is waiting on this node;
                // evicting it would restart its load and stall the swap.
                // Always empty in legacy mode.
                if (immune.has(node)) continue;
                const walked = node.__lastViewFrame === now;
                if (walked) {
                    // Sort tier-2 by SSE descending (finest first to evict).
                    const sse = this._computeNodeSse(node, {
                        cameraPos,
                        fovY,
                        screenHeight,
                        frustumCtx: null,
                        selected: null,
                        requested: null,
                        frameNumber: now
                    });
                    tier2.push({ node, score: sse });
                } else {
                    const since = this._notSelectedSince.get(node) ?? now;
                    const age = now - since;
                    let dist = 0;
                    if (cameraPos && w !== 0 && node.boundingVolume?.box) {
                        const [bx, by, bz] = node.boundingVolume.box;
                        const tx = bx, ty = bz, tz = -by;
                        const dx = tx - cx, dy = ty - cy, dz = tz - cz;
                        dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    }
                    tier1.push({ node, score: age + w * dist });
                }
            }
            tier1.sort((a, b) => b.score - a.score);
            tier2.sort((a, b) => b.score - a.score);
            let overflow = this._loadedGlbCount - this.softTileLimit;
            for (let i = 0; i < tier1.length && overflow > 0; i++) {
                this.unloadContent(tier1[i].node);
                overflow--;
            }
            for (let i = 0; i < tier2.length && overflow > 0; i++) {
                this.unloadContent(tier2[i].node);
                overflow--;
            }
        }
    }

    /**
     * Cesium-style recursive selection with `_ancestorWithContent` tracking.
     * Each in-view tile we walk past gets queued for load (not just target
     * leaves) so mid-level tiles are always available as coarse fallback
     * coverage while finer tiles stream in.
     *
     * Rules:
     *   - All-or-nothing refinement per subtree: either the subtree fully
     *     covers itself via its fine children, or the nearest loaded
     *     ancestor covers the whole subtree. Avoids ancestor-over-sibling
     *     overlap.
     *   - Child selections are probed into a TEMP set so we commit them
     *     atomically — no in-place rollback.
     *   - `ancestor` parameter threads the nearest loaded `.glb` ancestor
     *     down the recursion; the caller always knows its fallback target.
     *
     * @param {object} node - The subtree root to select from.
     * @param {object|null} ancestor - Nearest loaded `.glb` ancestor on path.
     * @param {object} ctx - The per-frame selection context (see `_select`).
     * @returns {boolean} true if this subtree produced coverage (selected,
     * out-of-view, or using ancestor); false if no loaded
     * ancestor was available and children are missing.
     */
    _selectSubtree(node, ancestor, ctx) {
        // Omnidirectional walk: out-of-frustum subtrees are NOT culled --
        // we still walk into them and request their tiles, just at a
        // coarser target SSE (`outOfFovSseFactor`). They never enter
        // `ctx.selected` so they don't render; they just sit in the
        // loaded cache so a quick camera rotation finds them ready.
        // The `inView` flag threads through every decision below.
        const inView = this.isInView(node, ctx.frustumCtx);
        const predicted = !inView && this._isPredictiveCandidate(node, ctx);
        const behind = !inView && !predicted && this._isBehindCamera(node, ctx);
        const sseMul = inView ? 1 : predicted ? this.predictiveSseFactor :
            behind ? this.behindCameraSseFactor : this.outOfFovSseFactor;
        const requestClass = inView ? 'visible' : predicted ? 'predicted' : 'coverage';

        // Pan-debounce bookkeeping: record when this tile first became
        // continuously visible. If it wasn't visible in the immediately
        // previous frame, treat this as a fresh arrival and reset the
        // timer. `_pushRequest` checks this before queueing a load.
        const frame = ctx.frameNumber;
        if (inView) {
            if (node.__lastVisibleFrame !== frame - 1) node.__inViewSinceFrame = frame;
            node.__lastVisibleFrame = frame;
        }
        node.__lastViewFrame = frame;

        // .json wrapper: transparent. Descend into its inner root inheriting
        // the current ancestor. If the wrapper hasn't been fetched yet we
        // just return false — the caller (subtree root) decides whether to
        // cover via ancestor for its whole area. Inserting ancestor here
        // would overlap any ready sibling subtrees.
        const uri = node.content?.uri;
        if (uri && uri.includes('.json')) {
            if (node.children && node.children.length > 0) {
                return this._selectSubtree(node.children[0], ancestor, ctx);
            }
            // Permanently-failed wrapper: its subtree can never resolve;
            // covered-as-hole (same rationale as dead .glb targets below).
            // Wave-only: legacy keeps its historical behavior (ancestor
            // fallback covers dead areas with blur instead of a hole).
            if (node.__loadDead && !this._isLoadRetryDue(node) && this.refinementMode === 'wave') return true;
            // Skip the pan debounce when no loaded ancestor covers this
            // area — the alternative to fetching immediately is a visible
            // hole, not a redundant request.
            this._pushRequest(node, ctx, !inView || !ancestor, requestClass);
            return false;
        }

        // Skip-LOD preload. The threshold expands by `sseMul` so OOV tiles
        // are still considered "close enough" to fetch at their coarser
        // target. The base maxPreloadSseFactor still bounds how far above
        // the (relaxed) target we'll go. For OOV requests we skip the
        // pan debounce -- those are deliberate coverage, not fast-pan
        // glances that might be cancelled by camera motion.
        if (uri && uri.includes('.glb') && !this._isEntityReady(node)) {
            const sse = this._computeNodeSse(node, ctx);
            if (sse === 0 || sse <= this.maximumScreenSpaceError * sseMul * this.maxPreloadSseFactor) {
                // Debounce is also skipped when no loaded ancestor covers
                // this area (`!ancestor`): a fast pan into fresh territory
                // shows a hole for every debounced frame, so fetch
                // immediately; covered areas can afford the 2-frame wait.
                this._pushRequest(node, ctx, !inView || !ancestor, requestClass);
            }
        }

        // Thread "nearest loaded ancestor" through the recursion.
        const next = this._isEntityReady(node) ? node : ancestor;

        // Refinement decision uses the same relaxed threshold for OOV.
        const needsRefine = this.isInRange(node, ctx.cameraPos, ctx.fovY, ctx.screenHeight, sseMul);

        if (needsRefine && node.children && node.children.length > 0) {
            // Strict REPLACE refinement is applied only at an in-view,
            // renderable frontier. Out-of-view traversal keeps the existing
            // coarse preload behavior and transparent wrappers pass through to
            // the first GLB before this branch can engage.
            if (this.refinementMode === 'atomic' && inView && this._isEntityReady(node)) {
                return this._selectAtomicFrontier(node, next, ctx);
            }
            // Probe children into a pooled temp set. We commit either the
            // children (all ready) or the ancestor (partial) — never both
            // — so sibling overlaps can't happen. The scratch pair (Set +
            // ctx object) is reused across frames to avoid allocations in
            // the hot path.
            const scratch = this._getChildScratch();
            const childSelected = scratch.selected;
            const childCtx = scratch.ctx;
            childCtx.cameraPos = ctx.cameraPos;
            childCtx.fovY = ctx.fovY;
            childCtx.screenHeight = ctx.screenHeight;
            childCtx.frustumCtx = ctx.frustumCtx;
            childCtx.selected = childSelected;
            childCtx.requested = ctx.requested;
            childCtx.requestedByNode = ctx.requestedByNode;
            childCtx.immune = ctx.immune;
            childCtx.prefetchState = ctx.prefetchState;
            childCtx.frameNumber = ctx.frameNumber;

            let allReady = true;
            for (let i = 0; i < node.children.length; i++) {
                if (!this._selectSubtree(node.children[i], next, childCtx)) allReady = false;
            }

            // Single-return structure so the scratch is always released.
            // Selection (add-to-selected) is gated by `inView` -- OOV
            // tiles are walked + requested but never displayed.
            let result;
            if (allReady) {
                if (inView) {
                    for (const e of childSelected) {
                        // Wave: strip self-fallback. A deep pocket with
                        // nothing loaded rides on `node` as its cover (the
                        // nothing-ready branch below adds `next`, often ==
                        // node); committing node alongside its own finer
                        // descendants would z-fight. Wave accepts a brief
                        // hole there instead; legacy keeps its historical
                        // overlap behavior untouched.
                        if (e === node && this.refinementMode === 'wave') continue;
                        ctx.selected.add(e);
                    }
                    // Hysteresis stamp: this area is showing finer coverage
                    // this frame. A wave hold may only re-engage after
                    // `waveReholdCooldownFrames` beyond the LAST such frame
                    // (re-holding on immediate pocket flaps is the
                    // oscillation failure mode; a revisit long after the
                    // fine children were evicted is legitimate).
                    if (this.refinementMode === 'wave') node.__waveAdvancedFrame = ctx.frameNumber;
                }
                result = true;
            } else if (childSelected.size > 0) {
                if (this._waveShouldHold(node, childSelected, inView, ctx)) {
                    // Wave hold, at the refinement frontier only: this tile
                    // has renderable content of its own and a genuine finer
                    // replacement is partially streamed. Keep covering the
                    // area with this tile (no transitional hole) and make
                    // the held-back ready descendants eviction-immune so
                    // the pending set only grows -- the swap is reached
                    // monotonically instead of being churned by eviction.
                    // All the ways this can wedge or flap are disarmed in
                    // _waveShouldHold (hysteresis, time bound, dead tiles,
                    // fallback noise, frontier-only).
                    for (const e of childSelected) ctx.immune.add(e);
                    ctx.selected.add(node);
                    result = true;
                } else if (this.refinementMode === 'mixed' && inView && this._isEntityReady(node)) {
                    // Experimental skip-LOD display: keep every ready finer
                    // descendant and retain this renderable parent as coverage
                    // for missing sibling regions. The host receives tree-depth
                    // stencil state through setMixed/clearMixed, so deeper tiles
                    // mask the parent instead of z-fighting with it.
                    for (const e of childSelected) ctx.selected.add(e);
                    ctx.selected.add(node);
                    result = true;
                } else {
                    // Partial refinement with some ready children — keep the
                    // fine coverage, hole for missing siblings (not overlap
                    // by a coarser ancestor). The ready children MUST be
                    // committed (not silently held back without immunity):
                    // dropping them leaves them loaded-but-hidden, permanent
                    // eviction candidates that churn (load -> evict ->
                    // reload) and pin the view at low LOD. See the reverted
                    // holdParentOnPartialRefine experiment (2026-07-03).
                    if (inView) {
                        for (const e of childSelected) ctx.selected.add(e);
                    }
                    if (inView) this._lastCoverageGapCount++;
                    result = false;
                }
            } else if (next && this._isUsableAncestor(next, ctx)) {
                // Nothing ready in the whole subtree — ancestor covers.
                if (inView) ctx.selected.add(next);
                result = true;
            } else {
                if (inView) this._lastCoverageGapCount++;
                result = false;
            }
            this._releaseChildScratch(scratch);
            return result;
        }

        // Target tile (leaf or SSE already satisfied).
        if (this._isEntityReady(node)) {
            if (inView) ctx.selected.add(node);
            return true;
        }
        // Permanently-failed target: it will never load, so treat it as
        // covered-as-hole. Returning false forever would keep its ancestors
        // in "partial refinement" for the rest of the session -- gating wave
        // holds open indefinitely. WAVE-ONLY: legacy keeps the historical
        // behavior (dead areas read not-ready forever and get covered by
        // the blurry ancestor fallback instead of a hole) so the default
        // mode stays semantically identical to the trusted baseline.
        if (node.__loadDead && !this._isLoadRetryDue(node) && this.refinementMode === 'wave') return true;
        // Target not ready. Return false without adding the ancestor — the
        // ancestor covers the whole subtree (including sibling targets that
        // DID load), so inserting it here would overlap them. The caller
        // (subtree root) handles ancestor-vs-children atomically for its
        // entire area.
        return false;
    }

    // Raw screen-space error for a node at the current camera. Returns 0
    //  if required inputs aren't available (caller should skip the
    //  threshold check in that case).
    _computeNodeSse(node, ctx) {
        if (!node.boundingVolume?.box || !ctx.cameraPos) return 0;
        if (ctx.fovY === undefined || ctx.screenHeight === undefined) return 0;
        const ge = node.geometricError;
        if (ge === undefined) return 0;
        const [bx, by, bz] = node.boundingVolume.box;
        const dx = bx - ctx.cameraPos[0];
        const dy = bz - ctx.cameraPos[1];
        const dz = -by - ctx.cameraPos[2];
        const dist = Math.max(length(dx, dy, dz), 1e-7);
        const sseDenom = this._frameSseDenom > 0 ? this._frameSseDenom : 2 * Math.tan(ctx.fovY / 2);
        return (ge * ctx.screenHeight) / (dist * sseDenom);
    }

    /**
     * Whether a loaded tile is acceptable as a transient fallback during
     * partial refinement. Rejects tiles whose screen-space error is
     * astronomically above the target threshold — typically the world-
     * scale root tile, which would flash as a blurry globe over the
     * viewport every time a fine subtree took > 1 frame to stream in.
     *
     * @param {object} node - The loaded ancestor tile node to test.
     * @param {object} ctx - The per-frame selection context (see `_select`).
     * @returns {boolean} true if the tile is close enough to the target SSE
     * to use as a transient fallback.
     */
    _isUsableAncestor(node, ctx) {
        if (!node.boundingVolume?.box || !ctx.cameraPos || ctx.fovY === undefined || ctx.screenHeight === undefined) {
            return true;  // can't measure; allow
        }
        // Compare the node's actual screen-space error against the fallback
        // threshold. (This used to call _computePriority, whose additive
        // score tops out around ~2.5 -- always below the threshold, so the
        // guard never rejected anything and the world root could flash as
        // a blurry fallback.)
        const sse = this._computeNodeSse(node, ctx);
        return sse <= this.maximumScreenSpaceError * this.maxFallbackSseFactor;
    }

    /**
     * Whether this node's GLB content is currently renderable — i.e. the
     * viewer's handler has an entity for it (in scene or LRU-cached).
     * Falls back to the `__contentLoaded` flag when the handler doesn't
     * expose `hasEntity`.
     *
     * @param {object} node - The tile node to test.
     * @returns {boolean} true if the node has renderable GLB content.
     */
    _isEntityReady(node) {
        if (!node.content?.uri?.includes('.glb')) return false;
        const stage = this.getLoadStage(node);
        if (stage && stage !== TILE_LOAD_STAGES.RENDER_READY &&
            stage !== TILE_LOAD_STAGES.VISIBLE && stage !== TILE_LOAD_STAGES.RESIDENT) {
            return false;
        }
        if (typeof this.handlers.hasEntity === 'function') {
            if (this.handlers.hasEntity(node)) return true;
            if (typeof this.handlers.hasResident === 'function') {
                return this.handlers.hasResident(node);
            }
            return false;
        }
        return node.__contentLoaded === true;
    }

    /**
     * Adopt a host-resident renderable tile back into the manager's loaded
     * accounting before it is shown. `handlers.restore(node)` must be
     * synchronous and return true only when `handlers.hasEntity(node)` will be
     * true immediately afterwards.
     *
     * @param {object} node - Selected tile that may be resident but inactive.
     * @returns {boolean} true when an active entity is ready for show().
     */
    _restoreResident(node) {
        if (typeof this.handlers.hasEntity !== 'function' || this.handlers.hasEntity(node)) {
            return true;
        }
        if (typeof this.handlers.hasResident !== 'function' || !this.handlers.hasResident(node)) {
            return false;
        }
        if (typeof this.handlers.restore !== 'function' || !this.handlers.restore(node)) {
            return false;
        }
        if (!this.handlers.hasEntity(node)) return false;

        if (!this._loadedNodes.has(node)) {
            this._loadedNodes.add(node);
            this._loadedGlbCount++;
        }
        node.__contentLoaded = true;
        this._clearLoadFailureState(node);
        this._notSelectedSince.set(node, this._frameNumber);
        this._setLoadStage(node, TILE_LOAD_STAGES.RENDER_READY);
        return true;
    }

    /**
     * Whether a partially-refined node should keep covering its area (wave
     * hold) instead of committing the partial fine set with holes. Every
     * clause disarms a specific failure mode from the two abandoned wave
     * attempts (see the 2026-07-08 post-mortem in the project plan):
     * frontier-only (skip-LOD intermediates without content must stay
     * transparent or the viewport starves), first-time-only hysteresis
     * (re-holds on pocket flaps are the whole-area flicker), a genuine-finer
     * -progress requirement (fallback-cover noise must not trigger holds),
     * and a hard time bound (missing tiles -- failed, veto-rejected, or
     * never-arriving -- must degrade to legacy holes, not hold forever).
     * When it returns true it also advances the node's hold-episode clock.
     *
     * @param {object} node - The refining node (already known to needRefine).
     * @param {Set<object>} childSelected - The subtree's ready partial set.
     * @param {boolean} inView - Frustum result for `node` this frame.
     * @param {object} ctx - The per-frame selection context.
     * @returns {boolean} true to hold `node` as the area's coverage.
     */
    _waveShouldHold(node, childSelected, inView, ctx) {
        if (this.refinementMode !== 'wave' || !inView) return false;
        // Permanently disqualified: a previous hold hit waveHoldMaxFrames
        // without resolving. Legacy display from here on -- re-allowing it
        // would create a hold/expire pulse loop on genuinely stuck areas.
        if (node.__waveHoldExpired) return false;
        // Advance-cooldown hysteresis: recently showed finer coverage; no
        // re-hold until the cooldown elapses (0 = never re-hold).
        if (node.__waveAdvancedFrame !== undefined) {
            if (this.waveReholdCooldownFrames === 0) return false;
            if (ctx.frameNumber - node.__waveAdvancedFrame < this.waveReholdCooldownFrames) return false;
        }
        if (!this._isEntityReady(node)) return false;
        // Frontier SSE cap: only a tile near the target LOD may hold. A
        // coarse ancestor holding would hide its ENTIRE fine subtree and
        // display one giant blurry tile -- the "city-sized flash" failure.
        // Unmeasurable SSE (0) is treated as too coarse: refuse.
        const ownSse = this._computeNodeSse(node, ctx);
        if (ownSse === 0 || ownSse > this.maximumScreenSpaceError * this.waveHoldMaxSseFactor) {
            return false;
        }
        // Genuine progress check: at least one ready piece strictly finer
        // than this node. Pocket-fallback entries (this node itself, or a
        // coarser ancestor inserted as cover) do not count.
        let hasFiner = false;
        for (const e of childSelected) {
            if (e !== node && e.geometricError < node.geometricError) {
                hasFiner = true;
                break;
            }
        }
        if (!hasFiner) return false;
        // Hold-episode clock. A gap since the last held frame starts a new
        // episode (camera left and came back); consecutive frames accrue.
        if (node.__waveHoldPrevFrame !== ctx.frameNumber - 1) {
            node.__waveHoldStart = ctx.frameNumber;
        }
        node.__waveHoldPrevFrame = ctx.frameNumber;
        if (ctx.frameNumber - node.__waveHoldStart >= this.waveHoldMaxFrames) {
            // Expired: permanent legacy fall-through for this node. The
            // missing pieces are taking too long (slow network, failures
            // racing the 3-strike marker, veto-rejected pockets) -- holes
            // now beat staying coarse indefinitely.
            node.__waveHoldExpired = true;
            return false;
        }
        return true;
    }

    _isPredictiveCandidate(node, ctx) {
        if (!this.predictivePrefetch || !node.boundingVolume?.box || !ctx.cameraPos) return false;
        const velocity = this._cameraVelocityTileY;
        const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
        if (speed < this.predictiveMinSpeed) return false;

        const [bx, by, bz] = node.boundingVolume.box;
        const center = [bx, bz, -by];
        const lookAhead = this.predictiveLookAheadSeconds;
        const predicted = [
            ctx.cameraPos[0] + velocity[0] * lookAhead,
            ctx.cameraPos[1] + velocity[1] * lookAhead,
            ctx.cameraPos[2] + velocity[2] * lookAhead
        ];
        const dx = center[0] - ctx.cameraPos[0];
        const dy = center[1] - ctx.cameraPos[1];
        const dz = center[2] - ctx.cameraPos[2];
        const distance = Math.max(1e-6, Math.hypot(dx, dy, dz));
        const motionAlignment = (dx * velocity[0] + dy * velocity[1] + dz * velocity[2]) /
            (distance * speed);
        if (motionAlignment < this.predictiveConeCosine) return false;

        const currentDistance = distance;
        const predictedDistance = Math.hypot(
            center[0] - predicted[0],
            center[1] - predicted[1],
            center[2] - predicted[2]
        );
        if (predictedDistance >= currentDistance) return false;

        if (this._cameraForwardTileY) {
            const forward = this._cameraForwardTileY;
            const forwardAlignment = (dx * forward[0] + dy * forward[1] + dz * forward[2]) / distance;
            // A side-looking flight may still predict along velocity, but do
            // not spend fine-detail work directly behind the current view.
            if (forwardAlignment < -0.5) return false;
        }
        return true;
    }

    _isBehindCamera(node, ctx) {
        if (!node.boundingVolume?.box || !ctx.cameraPos) return false;
        const [bx, by, bz] = node.boundingVolume.box;
        const dx = bx - ctx.cameraPos[0];
        const dy = bz - ctx.cameraPos[1];
        const dz = -by - ctx.cameraPos[2];
        const distance = Math.max(1e-6, Math.hypot(dx, dy, dz));
        const forward = this._cameraForwardTileY;
        const velocity = this._cameraVelocityTileY;
        const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
        const forwardAlignment = forward ?
            (dx * forward[0] + dy * forward[1] + dz * forward[2]) / distance : 0;
        const motionAlignment = speed >= this.predictiveMinSpeed ?
            (dx * velocity[0] + dy * velocity[1] + dz * velocity[2]) / (distance * speed) : 0;
        return forwardAlignment < -0.2 && (speed < this.predictiveMinSpeed || motionAlignment < -0.2);
    }

    _pushRequest(node, ctx, skipDebounce = false, requestClass = 'visible') {
        if (!node.content) return false;
        if (!this._isLoadRetryDue(node)) return false;
        // Pan debounce: require the tile to have been continuously in view
        // for at least onScreenThresholdFrames before we fetch it, so fast
        // pans don't flood the request queue with tiles the camera has
        // already flown past. Skipped for OOV-coverage requests -- those
        // aren't "glances", they're the deliberate omnidirectional ring.
        if (!skipDebounce) {
            const since = node.__inViewSinceFrame ?? ctx.frameNumber;
            if (ctx.frameNumber - since < this.onScreenThresholdFrames) return false;
        }
        const priority = this._computePriority(node, ctx.cameraPos, ctx.fovY, ctx.screenHeight) +
            (REQUEST_CLASS_BONUS[requestClass] ?? 0);
        const existing = ctx.requestedByNode?.get(node);
        if (existing) {
            if (priority > existing.priority) {
                existing.priority = priority;
                existing.requestClass = requestClass;
            }
            return false;
        }
        const request = { node, priority, requestClass };
        ctx.requested.push(request);
        ctx.requestedByNode?.set(node, request);
        return true;
    }

    _hideCoarserAncestors(startNode) {
        let cur = startNode;
        while (cur) {
            if (cur.content?.uri.includes('.glb') &&
                !this.contentHidden.get(this._getNodeContentKey(cur))) {
                this.handlers.hide(cur);
                this.contentHidden.set(this._getNodeContentKey(cur), true);
            }
            cur = cur.__parent ?? null;
        }
    }

    _normalizeRequestDescriptor(request) {
        if (typeof request === 'string') {
            return {
                url: request
            };
        }

        return request;
    }

    async _getNodeRequest(node) {
        const baseUrl = node.__baseUrl ?? '';
        const absoluteUrl = new URL(node.content.uri, baseUrl).toString();
        const request = await this.source.resolveRequest(absoluteUrl);
        Object.defineProperty(node, '__contentKey', {
            configurable: true,
            enumerable: false,
            value: request.url,
            writable: true
        });
        return request;
    }

    _getNodeContentKey(node) {
        return node.__contentKey ?? node.content?.uri;
    }
}

export { TileManager };
