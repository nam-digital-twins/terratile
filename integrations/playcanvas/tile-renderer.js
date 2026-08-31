/* eslint-disable-next-line no-var */
var TileRenderer = pc.createScript('tileRenderer');

// ─── Core attributes ──────────────────────────────────────────────────────
TileRenderer.attributes.add('provider', {
    type: 'string',
    default: 'google',
    enum: [{
        Google: 'google'
    }, {
        'Cesium ion': 'cesium-ion'
    }, {
        'Direct URL': 'url'
    }]
});
TileRenderer.attributes.add('apiUrl', {
    type: 'string',
    default: 'https://tile.googleapis.com/'
});
TileRenderer.attributes.add('apiKey', {
    type: 'string',
    default: ''
});
TileRenderer.attributes.add('tilesetUrl', {
    type: 'string',
    default: ''
});
TileRenderer.attributes.add('assetId', {
    type: 'number',
    default: 0
});
TileRenderer.attributes.add('camera', {
    type: 'entity'
});

// ─── Reference frame ──────────────────────────────────────────────────────
// When `useLocalFrame` is true the tile subtree is anchored at
// (originLon, originLat, originAlt) with the given yaw/pitch/roll (degrees,
// intrinsic Y-X-Z around ENU) and the per-frame update runs in local game
// coordinates. When false, the legacy translation-only path translates the
// entity by a hardcoded ECEF offset at startup — deprecated, kept for the
// original demo.
TileRenderer.attributes.add('useLocalFrame', {
    type: 'boolean',
    default: false
});
TileRenderer.attributes.add('originLon', { type: 'number', default: 0 });
TileRenderer.attributes.add('originLat', { type: 'number', default: 0 });
TileRenderer.attributes.add('originAlt', { type: 'number', default: 0 });
TileRenderer.attributes.add('originYaw', { type: 'number', default: 0 });
TileRenderer.attributes.add('originPitch', { type: 'number', default: 0 });
TileRenderer.attributes.add('originRoll', { type: 'number', default: 0 });

// ─── Composition ──────────────────────────────────────────────────────────
// Empty renderLayer keeps the PlayCanvas default (World layer).
TileRenderer.attributes.add('renderLayer', { type: 'string', default: '' });
TileRenderer.attributes.add('castShadows', { type: 'boolean', default: false });
// Default off: city-scale integrators don't want globe-cone culling. Set true
// only if the camera may orbit far enough to see curvature.
TileRenderer.attributes.add('globeMode', { type: 'boolean', default: false });
// GL polygon-offset units applied per tile-tree level (negative = pulled
// toward the camera) so finer tiles deterministically win the depth test
// over near-coplanar coarser ancestors during the brief parent/child
// overlap on refine, instead of z-fighting.
//
// Default 0 (OFF). CAUTION: polygon offset is constant in depth-buffer
// units, so biased tiles diverge from UNBIASED geometry (vehicles, props,
// avatars standing on the tiles) by tens of meters of effective depth at
// km viewing distances under a typical huge near/far range -- the ground
// visibly swallows such meshes. Only enable in tile-only scenes, or scenes
// where non-tile geometry never sits close to the tile surface.
TileRenderer.attributes.add('depthBiasPerLevel', { type: 'number', default: 0 });

// ─── Demo / debug ─────────────────────────────────────────────────────────
// Opt-in PCUI credential overlay + localStorage persistence. Off by default
// so the script behaves as a library component.
TileRenderer.attributes.add('showConfigUI', { type: 'boolean', default: false });
// Shift-click picker that logs the tile under the cursor and draws its
// bounding box. Binds a listener to the app canvas — off by default to
// avoid stealing input from host game code.
TileRenderer.attributes.add('debugPicker', { type: 'boolean', default: false });
// Per-tile load/unload/show/hide console logging.
TileRenderer.attributes.add('verbose', { type: 'boolean', default: false });

TileRenderer.prototype.loadGlb = function (request) {
    return new Promise((resolve, reject) => {
        const descriptor = typeof request === 'string' ? {
            url: request
        } : request;
        const sourceUrl = descriptor.url;
        const filename = new URL(sourceUrl).pathname.split('/').pop();

        const loadAsset = (assetUrl, cleanup) => {
            const asset = new pc.Asset(filename, 'container', {
                url: assetUrl
            }, null, {
                image: {
                    postprocess: (gltfImage, textureAsset) => {
                        // max anisotropy on all textures
                        textureAsset.resource.anisotropy = this.app.graphicsDevice.maxAnisotropy;
                    }
                }
            });
            asset.once('load', (containerAsset) => {
                if (cleanup) {
                    cleanup();
                }
                resolve(containerAsset);
            });
            asset.once('error', (err) => {
                if (cleanup) {
                    cleanup();
                }
                // The asset loader can emit plain strings; wrap them so
                // callers can rely on err.name / err.message.
                reject(err instanceof Error ? err : new Error(String(err)));
            });

            this.app.assets.add(asset);
            this.app.assets.load(asset);
        };

        // Fetch-based path whenever the request carries auth headers or an
        // AbortSignal -- the pc.Asset loader supports neither. TileManager
        // injects a signal into every request it drives, so manager loads
        // are cancellable mid-download; a bare loadGlb(url) call without
        // requestInit still takes the direct asset-loader path below.
        if (descriptor.requestInit?.headers || descriptor.requestInit?.signal) {
            (async () => {
                try {
                    const response = await fetch(sourceUrl, descriptor.requestInit);
                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }

                    const blob = await response.blob();
                    const objectUrl = URL.createObjectURL(blob);
                    loadAsset(objectUrl, () => URL.revokeObjectURL(objectUrl));
                } catch (err) {
                    reject(err);
                }
            })();
            return;
        }

        loadAsset(sourceUrl);
    });
};

TileRenderer.prototype.initialize = function () {
    this.selectedNode = null;
    this._destroyed = false;
    this._clickHandler = null;

    if (this.showConfigUI) {
        this._initializeWithConfigUI();
        return;
    }

    const config = {
        provider: this.provider || 'google',
        credential: this.apiKey || '',
        assetId: this.assetId || 0,
        tilesetUrl: this.tilesetUrl || ''
    };

    const missing = this._missingCredentials(config);
    if (missing) {
        console.error(`[tileRenderer] ${missing} — set the \`apiKey\` / \`tilesetUrl\` / \`assetId\` attributes or enable \`showConfigUI\`.`);
        return;
    }

    this.start(config);

    this.on('destroy', () => this._teardown());
};

TileRenderer.prototype._missingCredentials = function (config) {
    const p = config.provider;
    if (p === 'google' && !config.credential) return 'Google API key required';
    if (p === 'cesium-ion' && (!config.credential || !config.assetId)) return 'Cesium ion token and assetId required';
    if (p === 'url' && !config.tilesetUrl) return 'tilesetUrl required';
    return null;
};

TileRenderer.prototype._initializeWithConfigUI = function () {
    const storedConfig = this.loadStoredConfig();
    const initialConfig = {
        provider: this.provider || storedConfig.provider || 'google',
        credential: this.apiKey || storedConfig.credential || '',
        assetId: this.assetId || storedConfig.assetId || 0,
        tilesetUrl: this.tilesetUrl || storedConfig.tilesetUrl || ''
    };

    const style = document.createElement('style');
    style.textContent = `
    .pcui-label {
        font-size: 12px;
    }

    .pcui-overlay-content {
        padding: 8px;
        z-index: 0;
    }`;
    document.head.appendChild(style);
    this._injectedStyle = style;

    const overlay = new pcui.Overlay({
        clickable: false,
        transparent: false
    });
    document.body.appendChild(overlay.dom);
    this._configOverlay = overlay;

    const providerInput = new pcui.SelectInput({
        options: [{
            v: 'google',
            t: 'Google'
        }, {
            v: 'cesium-ion',
            t: 'Cesium ion'
        }, {
            v: 'url',
            t: 'Direct URL'
        }],
        value: initialConfig.provider
    });
    overlay.append(new pcui.LabelGroup({
        field: providerInput,
        text: 'Provider:'
    }));

    const credentialInput = new pcui.TextInput({
        value: initialConfig.credential
    });
    overlay.append(new pcui.LabelGroup({
        field: credentialInput,
        text: 'Credential:'
    }));

    const assetIdInput = new pcui.NumericInput({
        value: initialConfig.assetId,
        precision: 0
    });
    const assetIdGroup = new pcui.LabelGroup({
        field: assetIdInput,
        text: 'Asset ID:'
    });
    overlay.append(assetIdGroup);

    const tilesetUrlInput = new pcui.TextInput({
        value: initialConfig.tilesetUrl
    });
    const tilesetUrlGroup = new pcui.LabelGroup({
        field: tilesetUrlInput,
        text: 'Tileset URL:'
    });
    overlay.append(tilesetUrlGroup);

    const button = new pcui.Button({
        enabled: true,
        text: 'OK'
    });
    button.style.float = 'right';

    const updateFieldState = () => {
        const provider = providerInput.value;

        credentialInput.placeholder = provider === 'google' ? 'Google API key' :
            provider === 'cesium-ion' ? 'Cesium ion access token' :
                'Optional Bearer token';

        assetIdGroup.hidden = provider !== 'cesium-ion';
        tilesetUrlGroup.hidden = provider !== 'url';

        const hasCredential = credentialInput.value.trim().length > 0;
        const hasAssetId = Number(assetIdInput.value) > 0;
        const hasTilesetUrl = tilesetUrlInput.value.trim().length > 0;

        button.enabled = (provider === 'google' && hasCredential) ||
            (provider === 'cesium-ion' && hasCredential && hasAssetId) ||
            (provider === 'url' && hasTilesetUrl);
    };

    button.on('click', () => {
        const config = {
            provider: providerInput.value,
            credential: credentialInput.value.trim(),
            assetId: Number(assetIdInput.value) || 0,
            tilesetUrl: tilesetUrlInput.value.trim()
        };
        this.saveStoredConfig(config);
        overlay.hidden = true;
        this.start(config);
    });
    overlay.append(button);

    providerInput.on('change', updateFieldState);
    credentialInput.on('change', updateFieldState);
    assetIdInput.on('change', updateFieldState);
    tilesetUrlInput.on('change', updateFieldState);

    updateFieldState();

    if (button.enabled && (this.provider !== 'google' || initialConfig.credential || this.tilesetUrl || this.assetId)) {
        overlay.hidden = true;
        this.start(initialConfig);
    } else {
        credentialInput.focus();
    }

    this.on('destroy', () => this._teardown());
};

TileRenderer.prototype.loadStoredConfig = function () {
    try {
        const config = JSON.parse(localStorage.getItem('tiles-config') || '{}');
        const legacyApiKey = localStorage.getItem('tiles-api-key');
        if (!config.provider) {
            config.provider = 'google';
        }
        if (!config.credential && legacyApiKey) {
            config.credential = legacyApiKey;
        }
        return config;
    } catch (err) {
        console.warn('Unable to parse stored tile configuration.', err);
        return {
            provider: 'google'
        };
    }
};

TileRenderer.prototype.saveStoredConfig = function (config) {
    localStorage.setItem('tiles-config', JSON.stringify(config));
    if (config.provider === 'google') {
        localStorage.setItem('tiles-api-key', config.credential);
    }
};

TileRenderer.prototype.createSource = function (config) {
    const provider = config.provider || 'google';

    if (provider === 'cesium-ion') {
        return new terratile.CesiumIonTilesetSource(config.credential, config.assetId);
    }

    if (provider === 'url') {
        const requestInit = config.credential ? {
            headers: {
                Authorization: `Bearer ${config.credential}`
            }
        } : {};
        return new terratile.DirectTilesetSource(config.tilesetUrl, requestInit);
    }

    return new terratile.GoogleTilesetSource(config.credential, this.apiUrl);
};

TileRenderer.prototype.start = function (config) {
    if (this._started) return;
    this._started = true;

    if (!this.useLocalFrame) {
        // Deprecated legacy path: translates the entity by a hardcoded ECEF
        // offset (London). Prefer useLocalFrame for new integrations.
        this.entity.translate(-3978313.573, -4968706.59, -5293.061);
    }

    /** @type {Map<object, pc.Entity>} */
    const nodeToEntity = new Map();

    /** @type {Map<object, pc.Asset>} */
    const nodeToAsset = new Map();

    /** @type {Map<pc.MeshInstance, object>} */
    const meshInstanceToNode = new Map();

    this._nodeToEntity = nodeToEntity;
    this._nodeToAsset = nodeToAsset;
    this._meshInstanceToNode = meshInstanceToNode;

    const resolveLayerIds = () => {
        if (!this.renderLayer) return null;
        const layer = this.app.scene.layers.getLayerByName(this.renderLayer);
        if (!layer) {
            console.warn(`[tileRenderer] renderLayer '${this.renderLayer}' not found; using default layers.`);
            return null;
        }
        return [layer.id];
    };
    const layerIds = resolveLayerIds();

    const load = async (node, request) => {
        if (this._destroyed) return;
        if (this.verbose) console.log(`[tileRenderer] LOADING: ${node.content.uri}`);

        // loadGlb rejections propagate to TileManager, whose catch path
        // counts __loadFailures, retries up to 3, and feeds the session-
        // refresh detector. Swallowing errors here would wedge the node
        // as loaded-with-no-entity and hide provider failures from the
        // manager entirely.
        const asset = await this.loadGlb(request);

        const aborted = request.requestInit?.signal?.aborted;
        if (this._destroyed || aborted) {
            asset.unload();
            this.app.assets.remove(asset);
            if (aborted && !this._destroyed) {
                // Unloaded while the bytes were in flight. Surface it as an
                // abort so the manager resets the node's loaded flag instead
                // of counting a failure -- and so no ghost entity is added
                // to the scene for a node the manager considers unloaded.
                throw new DOMException('Aborted', 'AbortError');
            }
            return;
        }

        /** @type {pc.ContainerResource} */
        const resource = asset.resource;

        const entity = resource.instantiateRenderEntity({
            castShadows: this.castShadows
        });
        this.entity.addChild(entity);

        if (layerIds) {
            const renders = entity.findComponents('render');
            for (const r of renders) r.layers = layerIds.slice();
        }

        if (this.depthBiasPerLevel !== 0) {
            this._applyDepthBias(node, entity);
        }

        for (const meshInstance of entity.render.meshInstances) {
            meshInstanceToNode.set(meshInstance, node);
        }
        nodeToAsset.set(node, asset);
        nodeToEntity.set(node, entity);
    };
    const unload = (node) => {
        if (this.verbose) console.log(`[tileRenderer] UNLOADING: ${node.content.uri}`);

        const entity = nodeToEntity.get(node);
        if (entity) {
            for (const meshInstance of entity.render.meshInstances) {
                meshInstanceToNode.delete(meshInstance);
            }
            entity.destroy();
            nodeToEntity.delete(node);
        }

        const asset = nodeToAsset.get(node);
        if (asset) {
            asset.unload();
            this.app.assets.remove(asset);
            nodeToAsset.delete(node);
        }
    };
    const show = (node) => {
        if (this.verbose) console.log(`[tileRenderer] SHOWING: ${node.content.uri}`);
        const entity = nodeToEntity.get(node);
        if (entity) {
            entity.render.enabled = true;
        }
    };
    const hide = (node) => {
        if (this.verbose) console.log(`[tileRenderer] HIDING: ${node.content.uri}`);
        const entity = nodeToEntity.get(node);
        if (entity) {
            entity.render.enabled = false;
        }
    };
    // Lets the manager verify a load actually produced an entity (a load
    // that resolved without one is reset for retry instead of being marked
    // loaded forever) and drives selection's ancestor-fallback logic.
    const hasEntity = node => nodeToEntity.has(node);

    const source = this.createSource(config);
    this.tileManager = new terratile.TileManager(source, { load, unload, show, hide, hasEntity });
    this.tileManager.globeMode = this.globeMode;

    if (this.useLocalFrame) {
        this.tileManager.setLocalFrame({
            origin: {
                lon: this.originLon,
                lat: this.originLat,
                alt: this.originAlt
            },
            orientation: {
                yaw: this.originYaw,
                pitch: this.originPitch,
                roll: this.originRoll
            }
        });
        const { position, rotation } = this.tileManager.getTilesRootTransform();
        this.entity.setLocalPosition(position[0], position[1], position[2]);
        this.entity.setLocalRotation(rotation[0], rotation[1], rotation[2], rotation[3]);
    }

    this.tileManager.start();

    if (this.debugPicker) {
        this._setupDebugPicker();
    }
};

// Bias each tile's depth output by its tree depth. When a parent and its
// children briefly overlap during refinement (the manager keeps the coarse
// parent visible for one extra frame while the children's uploads settle),
// their meshes approximate the same surface and z-fight. A per-level
// negative polygon offset pulls deeper (finer) tiles toward the camera so
// the finer geometry wins ties deterministically. Where the surfaces
// genuinely differ, real depth differences dominate and the offset is
// negligible. Materials are per-asset (one asset per tile), so mutating
// them in place cannot leak across tiles.
TileRenderer.prototype._applyDepthBias = function (node, entity) {
    let depth = 0;
    for (let p = node.__parent; p; p = p.__parent) depth++;
    if (depth === 0) return;

    const bias = -depth * this.depthBiasPerLevel;
    const renders = entity.findComponents('render');
    for (const r of renders) {
        for (const mi of r.meshInstances) {
            const mat = mi.material;
            if (!mat) continue;
            mat.depthBias = bias;
            mat.slopeDepthBias = bias;
        }
    }
};

TileRenderer.prototype._setupDebugPicker = function () {
    const canvas = this.app.graphicsDevice.canvas;
    this.picker = new pc.Picker(this.app, canvas.width, canvas.height);
    this._clickHandler = (e) => {
        if (!e.shiftKey) return;
        this.picker.prepare(this.camera.camera, this.app.scene);
        const results = this.picker.getSelection(e.clientX, e.clientY);
        this.selectedNode = null;
        for (const meshInstance of results) {
            this.selectedNode = this._meshInstanceToNode.get(meshInstance);
            console.log(this.selectedNode);
        }
    };
    canvas.addEventListener('click', this._clickHandler);
};

TileRenderer.prototype._teardown = function () {
    this._destroyed = true;

    if (this._clickHandler) {
        this.app.graphicsDevice.canvas.removeEventListener('click', this._clickHandler);
        this._clickHandler = null;
    }
    this.picker = null;

    if (this._configOverlay) {
        this._configOverlay.destroy?.();
        this._configOverlay = null;
    }
    if (this._injectedStyle) {
        this._injectedStyle.remove();
        this._injectedStyle = null;
    }

    // No TileManager.stop() yet — loads in flight check this._destroyed before
    // mutating the scene. Dropping the reference lets it GC once callbacks
    // settle.
    this.tileManager = null;
};

TileRenderer.prototype.renderBoundingVolume = function (node) {
    const offset = this.entity.getPosition();

    const boundingVolume = node.boundingVolume;

    // Extract box properties from bounding volume
    const [cx, cy, cz, xx, xy, xz, yx, yy, yz, zx, zy, zz] = boundingVolume.box;

    // Convert the bounding box data into PlayCanvas vectors (adjusting for Z-up to Y-up)
    const center = new pc.Vec3(cx, cz, -cy);
    const xaxis = new pc.Vec3(xx, xz, -xy);
    const yaxis = new pc.Vec3(yx, yz, -yy);
    const zaxis = new pc.Vec3(zx, zz, -zy);

    // Calculate eight vertices of the box
    const vertices = [
        center.clone().sub(xaxis).sub(yaxis).sub(zaxis).add(offset),
        center.clone().add(xaxis).sub(yaxis).sub(zaxis).add(offset),
        center.clone().add(xaxis).add(yaxis).sub(zaxis).add(offset),
        center.clone().sub(xaxis).add(yaxis).sub(zaxis).add(offset),
        center.clone().sub(xaxis).sub(yaxis).add(zaxis).add(offset),
        center.clone().add(xaxis).sub(yaxis).add(zaxis).add(offset),
        center.clone().add(xaxis).add(yaxis).add(zaxis).add(offset),
        center.clone().sub(xaxis).add(yaxis).add(zaxis).add(offset)
    ];

    // Create line segments that connect vertices of the box
    const positions = [
        // Bottom square
        vertices[0], vertices[1],
        vertices[1], vertices[2],
        vertices[2], vertices[3],
        vertices[3], vertices[0],

        // Top square
        vertices[4], vertices[5],
        vertices[5], vertices[6],
        vertices[6], vertices[7],
        vertices[7], vertices[4],

        // Connecting lines
        vertices[0], vertices[4],
        vertices[1], vertices[5],
        vertices[2], vertices[6],
        vertices[3], vertices[7]
    ];

    const colors = [];
    for (let i = 0; i < 24; i++) {
        colors.push(pc.Color.WHITE);
    }

    this.app.drawLines(positions, colors);
};

TileRenderer.prototype.update = function (dt) {
    if (!this.tileManager || !this.camera) return;

    const pos = this.camera.getPosition();
    const fovRad = this.camera.camera.fov * Math.PI / 180;
    const screenH = this.app.graphicsDevice.height;
    const planes = this.camera.camera.frustum?.planes ?? null;

    if (this.useLocalFrame) {
        this.tileManager.updateLocal([pos.x, pos.y, pos.z], fovRad, screenH, planes);
    } else {
        const offset = this.entity.getPosition();
        this.tileManager.update(
            [pos.x - offset.x, pos.y - offset.y, pos.z - offset.z],
            fovRad, screenH, planes,
            [offset.x, offset.y, offset.z]
        );
    }

    if (this.debugPicker && this.selectedNode) {
        this.renderBoundingVolume(this.selectedNode);
    }
};
