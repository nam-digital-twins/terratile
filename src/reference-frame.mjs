import { cartesianToGeodetic, geodeticToCartesian } from './geodetic.mjs';

/**
 * Reference-frame math between terratile's internal "tile-Y" space and the
 * user-chosen "local" game space. This is the single source of truth for the
 * local-coordinate conventions — do not reimplement these transforms elsewhere.
 *
 * Spaces
 *   tile-Y : engine-Y-up proxy of ECEF used throughout TileManager.
 *            x_tileY = x_ecef,  y_tileY = z_ecef,  z_tileY = -y_ecef.
 *   local  : Y-up game space at the user-chosen geodetic anchor.
 *            At zero orientation: +X = east, +Y = up, -Z = north (+Z = south).
 *
 * Orientation {yaw, pitch, roll}, degrees, intrinsic Y-X-Z:
 *     1. yaw   — right-hand rotation around local +Y
 *     2. pitch — right-hand rotation around the new local +X
 *     3. roll  — right-hand rotation around the final local +Z
 * Equivalent composite applied to a local vector: R_y(yaw) · R_x(pitch) · R_z(roll).
 *
 * Point transform
 *     p_local = R_tileY_to_local · (p_tileY - originTileY)
 *     p_tileY = originTileY + R_local_to_tileY · p_local
 *
 * Engine tile-root transform (apply to the node that parents all GLB tiles)
 *     rotation = R_tileY_to_local          (as quaternion [x,y,z,w])
 *     position = -R_tileY_to_local · originTileY
 * so that for any GLB child whose local position is p_tileY (tile coords),
 *     world position = R · p_tileY + t = p_local.
 */

const DEG = Math.PI / 180;

const ecefToTileY = ([x, y, z]) => [x, z, -y];

const matFromColumns = (cx, cy, cz) => [
    cx[0], cy[0], cz[0],
    cx[1], cy[1], cz[1],
    cx[2], cy[2], cz[2]
];

const matMul = (a, b) => {
    const out = new Array(9);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            out[r * 3 + c] =
                a[r * 3 + 0] * b[0 * 3 + c] +
                a[r * 3 + 1] * b[1 * 3 + c] +
                a[r * 3 + 2] * b[2 * 3 + c];
        }
    }
    return out;
};

const matVec = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
];

const transpose = m => [
    m[0], m[3], m[6],
    m[1], m[4], m[7],
    m[2], m[5], m[8]
];

const rotX = (theta) => {
    const c = Math.cos(theta), s = Math.sin(theta);
    return [
        1, 0, 0,
        0, c, -s,
        0, s, c
    ];
};

const rotY = (theta) => {
    const c = Math.cos(theta), s = Math.sin(theta);
    return [
        c, 0, s,
        0, 1, 0,
        -s, 0, c
    ];
};

const rotZ = (theta) => {
    const c = Math.cos(theta), s = Math.sin(theta);
    return [
        c, -s, 0,
        s, c, 0,
        0, 0, 1
    ];
};

// Shepperd's method: pick the branch with the largest numerator so the
// normalising sqrt stays well away from zero.
const quatFromMatrix = (m) => {
    const m00 = m[0], m01 = m[1], m02 = m[2];
    const m10 = m[3], m11 = m[4], m12 = m[5];
    const m20 = m[6], m21 = m[7], m22 = m[8];
    const trace = m00 + m11 + m22;
    let x, y, z, w;
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        w = 0.25 / s;
        x = (m21 - m12) * s;
        y = (m02 - m20) * s;
        z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
        const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
        w = (m21 - m12) / s;
        x = 0.25 * s;
        y = (m01 + m10) / s;
        z = (m02 + m20) / s;
    } else if (m11 > m22) {
        const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
        w = (m02 - m20) / s;
        x = (m01 + m10) / s;
        y = 0.25 * s;
        z = (m12 + m21) / s;
    } else {
        const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
        w = (m10 - m01) / s;
        x = (m02 + m20) / s;
        y = (m12 + m21) / s;
        z = 0.25 * s;
    }
    return [x, y, z, w];
};

/**
 * Build the transforms that bridge local (game) space and tile-Y space.
 * See the file header for the coordinate and rotation conventions.
 *
 * @param {object} spec - Geodetic anchor plus optional orientation.
 * @param {{lon: number, lat: number, alt: number}} spec.origin - Anchor in WGS84 degrees / metres.
 * @param {{yaw: number, pitch: number, roll: number}} [spec.orientation] - Yaw/pitch/roll in degrees, intrinsic Y-X-Z around ENU.
 * @returns {object} Transforms between local and tile-Y, plus engine tile-root position and rotation.
 */
function createLocalFrame(spec) {
    if (!spec || !spec.origin) {
        throw new Error('createLocalFrame: spec.origin {lon, lat, alt} is required');
    }
    const { lon, lat, alt = 0 } = spec.origin;
    const { yaw = 0, pitch = 0, roll = 0 } = spec.orientation ?? {};

    const originTileY = ecefToTileY(geodeticToCartesian(lon, lat, alt));

    const lonR = lon * DEG;
    const latR = lat * DEG;
    const sinLon = Math.sin(lonR), cosLon = Math.cos(lonR);
    const sinLat = Math.sin(latR), cosLat = Math.cos(latR);

    // ENU basis at origin, expressed in ECEF, then remapped to tile-Y.
    const eastT  = ecefToTileY([-sinLon, cosLon, 0]);
    const northT = ecefToTileY([-sinLat * cosLon, -sinLat * sinLon, cosLat]);
    const upT    = ecefToTileY([cosLat * cosLon, cosLat * sinLon, sinLat]);

    // B : columns are local basis vectors (east, up, -north) expressed in tile-Y.
    // This is the map "ENU-remapped coords" → tile-Y, i.e. the zero-orientation
    // `R_local_to_tileY`.
    const B = matFromColumns(
        eastT,
        upT,
        [-northT[0], -northT[1], -northT[2]]
    );

    // Intrinsic Y-X-Z orientation inside the local frame.
    const R_yprm = matMul(matMul(rotY(yaw * DEG), rotX(pitch * DEG)), rotZ(roll * DEG));

    const R_local_to_tileY = matMul(B, R_yprm);
    const R_tileY_to_local = transpose(R_local_to_tileY);

    const rOrigin = matVec(R_tileY_to_local, originTileY);
    const rootPosition = [-rOrigin[0], -rOrigin[1], -rOrigin[2]];
    const rootRotation = quatFromMatrix(R_tileY_to_local);

    return {
        originTileY,
        R_local_to_tileY,
        R_tileY_to_local,
        rootPosition,
        rootRotation,
        enuBasisTileY: { east: eastT, north: northT, up: upT }
    };
}

/**
 * Convert a geodetic point to the frame's local space.
 * Exact at any distance — no small-step approximation.
 *
 * @param {object} frame - Result of createLocalFrame().
 * @param {{lon: number, lat: number, alt: number}} point - WGS84 degrees / metres.
 * @returns {{x:number, y:number, z:number}} Point in local space.
 */
function geodeticToLocal(frame, { lon, lat, alt = 0 }) {
    const p = ecefToTileY(geodeticToCartesian(lon, lat, alt));
    const R = frame.R_tileY_to_local;
    const o = frame.originTileY;
    const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2];
    return {
        x: R[0] * dx + R[1] * dy + R[2] * dz,
        y: R[3] * dx + R[4] * dy + R[5] * dz,
        z: R[6] * dx + R[7] * dy + R[8] * dz
    };
}

/**
 * Convert an ENU direction vector (east/north/up) at the frame's anchor into
 * local space. Directions only — no anchor translation. For city-scale scenes
 * the basis is exact at the anchor and ≤ sub-degree off at a few km away.
 *
 * @param {object} frame - Result of createLocalFrame().
 * @param {{e: number, n: number, u: number}} enu - ENU components in metres.
 * @returns {{x:number, y:number, z:number}} Direction in local space.
 */
function enuDirectionToLocal(frame, { e = 0, n = 0, u = 0 }) {
    const eT = frame.enuBasisTileY.east;
    const nT = frame.enuBasisTileY.north;
    const uT = frame.enuBasisTileY.up;
    const vT = [
        e * eT[0] + n * nT[0] + u * uT[0],
        e * eT[1] + n * nT[1] + u * uT[1],
        e * eT[2] + n * nT[2] + u * uT[2]
    ];
    const R = frame.R_tileY_to_local;
    return {
        x: R[0] * vT[0] + R[1] * vT[1] + R[2] * vT[2],
        y: R[3] * vT[0] + R[4] * vT[1] + R[5] * vT[2],
        z: R[6] * vT[0] + R[7] * vT[1] + R[8] * vT[2]
    };
}

/**
 * Inverse of `geodeticToLocal`: takes a point in the frame's local space and
 * returns its geodetic coordinates. Round-trip with `geodeticToLocal` is exact
 * to within IEEE-754 noise.
 *
 * Composed transform:
 *   local -> tile-Y :  tileY = originTileY + R_local_to_tileY · localPoint
 *   tile-Y -> geo   :  cartesianToGeodetic accepts tile-Y coords directly --
 *                      its `lon = atan2(-z, x)` / `p = sqrt(x^2 + z^2)`
 *                      formulas are tile-Y aware (see the file header for the
 *                      tile-Y vs ECEF axis remap).
 *
 * @param {object} frame - Result of createLocalFrame().
 * @param {{x:number, y:number, z:number}} point - Point in local space.
 * @returns {{lon:number, lat:number, alt:number}} WGS84 degrees / metres.
 */
function localToGeodetic(frame, { x, y, z }) {
    const R = frame.R_local_to_tileY;
    const o = frame.originTileY;
    const tx = o[0] + R[0] * x + R[1] * y + R[2] * z;
    const ty = o[1] + R[3] * x + R[4] * y + R[5] * z;
    const tz = o[2] + R[6] * x + R[7] * y + R[8] * z;
    const [lon, lat, alt] = cartesianToGeodetic(tx, ty, tz);
    return { lon, lat, alt };
}

export { createLocalFrame, geodeticToLocal, localToGeodetic, enuDirectionToLocal };
