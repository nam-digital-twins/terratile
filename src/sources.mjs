const GOOGLE_TILE_API_URL = 'https://tile.googleapis.com/';
const CESIUM_ION_API_URL = 'https://api.cesium.com/';
const GOOGLE_SESSION_CACHE_MAX_AGE_MS = 3 * 60 * 60 * 1000;

const cloneRequestInit = (requestInit = {}) => ({
    ...requestInit,
    headers: requestInit.headers ? {
        ...requestInit.headers
    } : undefined
});

const ensureTrailingSlash = url => (url.endsWith('/') ? url : `${url}/`);

const isGoogleTilesUrl = (url) => {
    const parsed = new URL(url);
    return parsed.hostname === 'tile.googleapis.com' && parsed.pathname.includes('/3dtiles/');
};

/**
 * Source for a 3D Tiles tileset that can resolve the root tileset URL and any
 * per-request authentication requirements.
 */
class TilesetSource {
    /**
     * Returns the root request for the tileset.
     */
    getRootRequest() {
        throw new Error('TilesetSource#getRootRequest must be implemented by subclasses.');
    }

    /**
     * Resolves a request for a specific tileset resource.
     *
     * @param {string} url - The absolute resource URL.
     * @returns {Promise<{url: string, requestInit: RequestInit}>} The resolved request.
     */
    resolveRequest(url) {
        return {
            url,
            cacheKey: url,
            cacheable: true
        };
    }

    /**
     * Canonical persistent-cache key for a resolved resource URL.
     * Sources with rotating credentials or sessions override this method.
     * @param {string} url - Resolved resource URL.
     * @returns {string} Stable cache key.
     */
    getCacheKey(url) {
        return url;
    }
}

/**
 * Source for an already-resolved tileset URL.
 */
class DirectTilesetSource extends TilesetSource {
    rootUrl;

    requestInit;

    /**
     * @param {string} rootUrl - The root tileset URL.
     * @param {RequestInit} requestInit - Optional fetch options used for all requests.
     */
    constructor(rootUrl, requestInit = {}) {
        super();
        this.rootUrl = rootUrl;
        this.requestInit = cloneRequestInit(requestInit);
    }

    getRootRequest() {
        return {
            url: this.rootUrl,
            requestInit: cloneRequestInit(this.requestInit),
            cacheKey: this.getCacheKey(this.rootUrl),
            cacheable: true
        };
    }

    resolveRequest(url) {
        return {
            url,
            requestInit: cloneRequestInit(this.requestInit),
            cacheKey: this.getCacheKey(url),
            cacheable: true
        };
    }
}

/**
 * Source for Google's Photorealistic 3D Tiles API, including the session token
 * handling required by the API.
 */
class GoogleTilesetSource extends TilesetSource {
    apiKey;

    apiUrl;

    rootUrl;

    rootKey;

    session;

    /**
     * @param {string|null} apiKey - The Google Maps 3D Tiles API key.
     * @param {string} apiUrl - The Google Maps API base URL.
     * @param {string|null} rootUrl - Optional opaque root tileset URL.
     */
    constructor(apiKey, apiUrl = GOOGLE_TILE_API_URL, rootUrl = null) {
        super();
        this.apiKey = apiKey;
        this.apiUrl = apiUrl ? ensureTrailingSlash(apiUrl) : GOOGLE_TILE_API_URL;
        this.rootUrl = rootUrl;
        this.rootKey = rootUrl ? new URL(rootUrl).searchParams.get('key') : null;
    }

    getRootRequest() {
        const url = this.rootUrl ?? `${this.apiUrl}v1/3dtiles/root.json?key=${this.apiKey}`;
        return {
            // The root request is the authority that MINTS the session token, so
            // it must go out session-less. Stamping the current session here would
            // poison the very request used to refresh an expired one: Google
            // rejects a stale session with 400 INVALID_ARGUMENT, refreshSession()
            // would throw, this.session would never update, and every tile would
            // retry forever on the dead token. See refreshSession() in the manager.
            url: this._buildRequestUrl(url, { includeSession: false }),
            // The root response is the authority for the current Google
            // session token and must never survive a reload.
            cacheable: false
        };
    }

    resolveRequest(url) {
        const resolvedUrl = this._buildRequestUrl(url);
        return {
            url: resolvedUrl,
            cacheKey: this.getCacheKey(resolvedUrl),
            cacheable: true,
            // Google only guarantees that a root-derived 3D Tiles session is
            // usable for at least three hours. Keep canonical cross-session
            // caching for quick reloads, but never trust an old hierarchy or
            // payload indefinitely. TileCache also honors a shorter server
            // Cache-Control/Expires lifetime when one is supplied.
            maxAgeMs: GOOGLE_SESSION_CACHE_MAX_AGE_MS
        };
    }

    getCacheKey(url) {
        try {
            const cacheUrl = new URL(url);
            cacheUrl.searchParams.delete('session');
            cacheUrl.searchParams.delete('key');
            return cacheUrl.toString();
        } catch {
            return url;
        }
    }

    _buildRequestUrl(url, { includeSession = true } = {}) {
        const requestUrl = new URL(url);
        const params = requestUrl.searchParams;
        const key = params.get('key') ?? this.apiKey ?? this.rootKey;

        if (key && !params.has('key')) {
            params.set('key', key);
        }

        // Root/refresh path: never carry a session. A stale one embedded in an
        // opaque rootUrl (or held in this.session) would be rejected and defeat
        // the refresh, so strip it entirely and reach the network clean.
        if (!includeSession) {
            params.delete('session');
            return requestUrl.toString();
        }

        // Prefer the source's known-good session over whatever is embedded
        // in the URL. The tree's child content.uri values bake in the session
        // that was current when the root was fetched — after a refresh those
        // become stale. Overriding here is what makes refresh work without
        // rewriting every node's URI.
        if (this.session) {
            params.set('session', this.session);
        } else if (params.has('session')) {
            this.session = params.get('session');
        }

        return requestUrl.toString();
    }

    // Update the active session token. Subsequent resolveRequest calls will
    // rewrite the URL to use this token regardless of what the URL carries.
    setSession(newSession) {
        if (newSession && newSession !== this.session) {
            if (typeof console !== 'undefined') {
                console.debug('[google] session updated', { from: this.session, to: newSession });
            }
            this.session = newSession;
        }
    }
}

/**
 * Source backed by a Cesium ion asset.
 */
class CesiumIonTilesetSource extends TilesetSource {
    accessToken;

    assetId;

    apiUrl;

    resolvedSource;

    /**
     * @param {string} accessToken - The Cesium ion access token.
     * @param {number|string} assetId - The Cesium ion asset ID.
     * @param {string} apiUrl - The Cesium ion REST API base URL.
     */
    constructor(accessToken, assetId, apiUrl = CESIUM_ION_API_URL) {
        super();
        this.accessToken = accessToken;
        this.assetId = assetId;
        this.apiUrl = ensureTrailingSlash(apiUrl);
    }

    async getRootRequest() {
        const source = await this._getResolvedSource();
        return source.getRootRequest();
    }

    async resolveRequest(url) {
        const source = await this._getResolvedSource();
        return source.resolveRequest(url);
    }

    async _getResolvedSource(forceRefresh = false) {
        if (!this.resolvedSource || forceRefresh) {
            const endpointUrl = new URL(`v1/assets/${this.assetId}/endpoint`, this.apiUrl);
            const response = await fetch(endpointUrl, {
                headers: {
                    Authorization: `Bearer ${this.accessToken}`
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to resolve Cesium ion asset endpoint: ${response.status}`);
            }

            const endpoint = await response.json();
            this.resolvedSource = this._createSourceFromEndpoint(endpoint);
        }

        return this.resolvedSource;
    }

    _createSourceFromEndpoint(endpoint) {
        if (endpoint.url) {
            if (endpoint.accessToken) {
                return new DirectTilesetSource(endpoint.url, {
                    headers: {
                        Authorization: `Bearer ${endpoint.accessToken}`
                    }
                });
            }

            return new DirectTilesetSource(endpoint.url);
        }

        if (endpoint.externalType === '3DTILES' && endpoint.options?.url) {
            if (isGoogleTilesUrl(endpoint.options.url)) {
                return new GoogleTilesetSource(null, GOOGLE_TILE_API_URL, endpoint.options.url);
            }

            return new DirectTilesetSource(endpoint.options.url);
        }

        throw new Error(`Cesium ion asset ${this.assetId} is not exposed as a supported 3D Tiles endpoint.`);
    }
}

export {
    CesiumIonTilesetSource,
    DirectTilesetSource,
    GoogleTilesetSource,
    TilesetSource
};
