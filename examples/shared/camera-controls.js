// Shared desktop camera controllers for the terratile examples.
//
// Orbit + fly (WASD) camera controllers in one <script>-loadable file. Load it
// after the PlayCanvas engine; it attaches
// `window.terratileExamples.createCameraControls`.
//
// Local-space ENU convention (terratile local frame): +X east, +Y up, -Z north.
//
//   const controls = terratileExamples.createCameraControls({ camera, canvas });
//   controls.switchTo('orbit');                      // or 'fly'
//   app.on('update', (dt) => controls.tick(dt));     // fly needs the per-frame tick
//
// Orbit: left-drag pan, right-drag orbit, wheel zoom, two-finger pinch/twist.
// Fly:   click to pointer-lock, WASD horizontal, Space/Ctrl vertical, Shift sprint.

(function () {
    if (typeof pc === 'undefined') throw new Error('camera-controls: pc is not loaded');

    const deg2rad = (d) => d * Math.PI / 180;
    const rad2deg = (r) => r * 180 / Math.PI;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    // ENU helper: (east, north, up) -> PlayCanvas local (x, y, z).
    const localOffset = (e, n, u) => new pc.Vec3(e, u, -n);

    // ---- Orbit controller -----------------------------------------------
    const ORBIT_CAMERA_HEIGHT = 300;
    const ORBIT_CAMERA_BACK = 220;
    const ORBIT_CAMERA_RIGHT = 70;
    const ORBIT_LOOK_AHEAD = 30;
    const ORBIT_MIN_DISTANCE = 40;
    const ORBIT_MAX_DISTANCE = 6000;
    const ORBIT_MIN_PITCH = 8;
    const ORBIT_MAX_PITCH = 88;

    function createOrbitControls({ camera, canvas }) {
        const LOCAL_UP = new pc.Vec3(0, 1, 0);
        const LOCAL_NORTH = new pc.Vec3(0, 0, -1);

        const initialSouth = ORBIT_CAMERA_BACK + ORBIT_LOOK_AHEAD;
        const initialHoriz = Math.hypot(ORBIT_CAMERA_RIGHT, initialSouth);
        const nav = {
            target: localOffset(0, ORBIT_LOOK_AHEAD, 0),
            heading: rad2deg(Math.atan2(ORBIT_CAMERA_RIGHT, initialSouth)),
            pitch: rad2deg(Math.atan2(ORBIT_CAMERA_HEIGHT, initialHoriz)),
            distance: Math.hypot(initialHoriz, ORBIT_CAMERA_HEIGHT)
        };
        const ptr = { id: null, mode: null, x: 0, y: 0 };
        // Multi-touch: `pointers` tracks all active ids; `gesture` is non-null
        // only while exactly two are down (pinch-zoom + twist-yaw).
        const pointers = new Map();
        let gesture = null;
        let enabled = false;

        function gestureSnapshot() {
            const arr = [...pointers.values()];
            if (arr.length < 2) return null;
            const dx = arr[1].x - arr[0].x;
            const dy = arr[1].y - arr[0].y;
            return { dist: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
        }

        function updateCamera() {
            const h = deg2rad(nav.heading);
            const p = deg2rad(nav.pitch);
            const hd = Math.cos(p) * nav.distance;
            const vd = Math.sin(p) * nav.distance;
            const off = localOffset(Math.sin(h) * hd, -Math.cos(h) * hd, vd);
            camera.setPosition(nav.target.clone().add(off));
            camera.lookAt(nav.target);
        }

        function onPointerDown(ev) {
            if (!enabled) return;
            pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
            if (pointers.size === 1) {
                ptr.id = ev.pointerId;
                ptr.mode = ev.button === 2 ? 'orbit' : 'pan';
                ptr.x = ev.clientX;
                ptr.y = ev.clientY;
            } else if (pointers.size === 2) {
                ptr.id = null;
                ptr.mode = null;
                gesture = gestureSnapshot();
            }
        }
        function onPointerMove(ev) {
            if (!enabled || !pointers.has(ev.pointerId)) return;
            pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

            if (gesture && pointers.size === 2) {
                const snap = gestureSnapshot();
                if (snap.dist > 0 && gesture.dist > 0) {
                    nav.distance = clamp(nav.distance / (snap.dist / gesture.dist),
                        ORBIT_MIN_DISTANCE, ORBIT_MAX_DISTANCE);
                }
                let dAngle = snap.angle - gesture.angle;
                if (dAngle > Math.PI) dAngle -= 2 * Math.PI;
                if (dAngle < -Math.PI) dAngle += 2 * Math.PI;
                nav.heading -= rad2deg(dAngle);
                gesture = snap;
                updateCamera();
                return;
            }

            if (ptr.id !== ev.pointerId || !ptr.mode) return;
            const dx = ev.clientX - ptr.x;
            const dy = ev.clientY - ptr.y;
            ptr.x = ev.clientX;
            ptr.y = ev.clientY;
            if (ptr.mode === 'orbit') {
                nav.heading -= dx * 0.25;
                nav.pitch = clamp(nav.pitch - dy * 0.2, ORBIT_MIN_PITCH, ORBIT_MAX_PITCH);
            } else {
                const fwd = nav.target.clone().sub(camera.getPosition());
                fwd.y = 0;
                if (fwd.lengthSq() < 1e-6) fwd.copy(LOCAL_NORTH); else fwd.normalize();
                const right = new pc.Vec3().cross(fwd, LOCAL_UP).normalize();
                const scale = Math.max(0.5, nav.distance * 0.0025);
                nav.target.add(right.mulScalar(-dx * scale).add(fwd.mulScalar(dy * scale)));
            }
            updateCamera();
        }
        function onPointerClear(ev) {
            if (!pointers.has(ev.pointerId)) return;
            pointers.delete(ev.pointerId);
            try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
            if (pointers.size === 0) {
                ptr.id = null;
                ptr.mode = null;
                gesture = null;
            } else if (pointers.size === 1) {
                gesture = null;
                const [remId, rem] = [...pointers.entries()][0];
                ptr.id = remId;
                ptr.mode = 'pan';
                ptr.x = rem.x;
                ptr.y = rem.y;
            } else {
                gesture = gestureSnapshot();
            }
        }
        function onWheel(ev) {
            if (!enabled) return;
            ev.preventDefault();
            nav.distance = clamp(nav.distance * Math.exp(ev.deltaY * 0.0015),
                ORBIT_MIN_DISTANCE, ORBIT_MAX_DISTANCE);
            updateCamera();
        }

        function setEnabled(v) {
            if (enabled === v) return;
            enabled = v;
            if (v) {
                canvas.addEventListener('pointerdown', onPointerDown);
                canvas.addEventListener('pointermove', onPointerMove);
                canvas.addEventListener('pointerup', onPointerClear);
                canvas.addEventListener('pointercancel', onPointerClear);
                canvas.addEventListener('wheel', onWheel, { passive: false });
                updateCamera();
            } else {
                canvas.removeEventListener('pointerdown', onPointerDown);
                canvas.removeEventListener('pointermove', onPointerMove);
                canvas.removeEventListener('pointerup', onPointerClear);
                canvas.removeEventListener('pointercancel', onPointerClear);
                canvas.removeEventListener('wheel', onWheel);
                pointers.clear();
                gesture = null;
                ptr.id = null;
                ptr.mode = null;
            }
        }

        // Infer an orbit pose from the camera's current transform so switching
        // in from the fly controller doesn't jump the view.
        function seedFromCamera() {
            const f = camera.forward;
            nav.heading = rad2deg(Math.atan2(-f.x, -f.z));
            nav.pitch = clamp(rad2deg(Math.asin(-f.y)), ORBIT_MIN_PITCH, ORBIT_MAX_PITCH);
            const pos = camera.getPosition().clone();
            nav.target.copy(pos.add(f.clone().normalize().mulScalar(nav.distance)));
            if (enabled) updateCamera();
        }

        return {
            name: 'orbit',
            setEnabled,
            tick: () => {},
            seedFromCamera
        };
    }

    // ---- Fly controller -------------------------------------------------
    const FLY_DEFAULT_SPEED = 25;   // m/s, overridable via setSpeed()
    const FLY_SPRINT_MULT = 4;      // Shift multiplier
    const FLY_MOUSE_SENS = 0.15;    // degrees per pixel
    const FLY_MIN_PITCH = -89;
    const FLY_MAX_PITCH = 89;

    function createFlyControls({ camera, canvas }) {
        const keys = Object.create(null);
        let yaw = 0;
        let pitch = 0;
        let enabled = false;
        let pointerLockActive = false;
        let baseSpeed = FLY_DEFAULT_SPEED;

        function clearKeys() {
            for (const k of Object.keys(keys)) keys[k] = false;
        }
        function onKeyDown(ev) {
            if (!enabled) return;
            keys[ev.code] = true;
            if (ev.code === 'Space') ev.preventDefault();
        }
        function onKeyUp(ev) {
            if (!enabled) return;
            keys[ev.code] = false;
        }
        function onVisibilityChange() {
            if (document.hidden) clearKeys();
        }
        function onBlur() { clearKeys(); }

        function onMouseMove(ev) {
            if (!enabled || !pointerLockActive) return;
            yaw -= ev.movementX * FLY_MOUSE_SENS;
            pitch = clamp(pitch - ev.movementY * FLY_MOUSE_SENS, FLY_MIN_PITCH, FLY_MAX_PITCH);
            if (yaw > 180) yaw -= 360;
            else if (yaw < -180) yaw += 360;
            camera.setEulerAngles(pitch, yaw, 0);
        }
        function onCanvasClick() {
            if (!enabled || pointerLockActive) return;
            try { canvas.requestPointerLock(); } catch (e) { /* ignore */ }
        }
        function onPointerLockChange() {
            pointerLockActive = document.pointerLockElement === canvas;
            if (!pointerLockActive) clearKeys();
        }

        function tick(dt) {
            if (!enabled || !dt) return;
            const sprint = keys.ShiftLeft || keys.ShiftRight;
            const speed = sprint ? baseSpeed * FLY_SPRINT_MULT : baseSpeed;

            const fwdAxis = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
            const rightAxis = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
            const upAxis = (keys.Space ? 1 : 0) - ((keys.ControlLeft || keys.ControlRight) ? 1 : 0);
            if (fwdAxis === 0 && rightAxis === 0 && upAxis === 0) return;

            const pos = camera.getPosition().clone();
            if (fwdAxis !== 0 || rightAxis !== 0) {
                // Zero out Y so horizontal motion stays world-flat regardless of pitch.
                const f = camera.forward.clone();
                f.y = 0;
                if (f.lengthSq() > 1e-6) f.normalize();
                const r = camera.right.clone();
                r.y = 0;
                if (r.lengthSq() > 1e-6) r.normalize();
                pos.x += (f.x * fwdAxis + r.x * rightAxis) * speed * dt;
                pos.z += (f.z * fwdAxis + r.z * rightAxis) * speed * dt;
            }
            if (upAxis !== 0) pos.y += upAxis * baseSpeed * dt;
            camera.setPosition(pos);
        }

        function setEnabled(v) {
            if (enabled === v) return;
            enabled = v;
            if (v) {
                document.addEventListener('keydown', onKeyDown);
                document.addEventListener('keyup', onKeyUp);
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('pointerlockchange', onPointerLockChange);
                document.addEventListener('visibilitychange', onVisibilityChange);
                window.addEventListener('blur', onBlur);
                canvas.addEventListener('click', onCanvasClick);
            } else {
                document.removeEventListener('keydown', onKeyDown);
                document.removeEventListener('keyup', onKeyUp);
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('pointerlockchange', onPointerLockChange);
                document.removeEventListener('visibilitychange', onVisibilityChange);
                window.removeEventListener('blur', onBlur);
                canvas.removeEventListener('click', onCanvasClick);
                if (document.pointerLockElement === canvas) {
                    try { document.exitPointerLock(); } catch (e) { /* ignore */ }
                }
                clearKeys();
            }
        }

        function seedFromCamera() {
            const f = camera.forward;
            yaw = rad2deg(Math.atan2(-f.x, -f.z));
            pitch = clamp(rad2deg(Math.asin(f.y)), FLY_MIN_PITCH, FLY_MAX_PITCH);
            camera.setEulerAngles(pitch, yaw, 0);
        }

        function setSpeed(v) {
            if (Number.isFinite(v) && v > 0) baseSpeed = v;
        }

        return {
            name: 'fly',
            setEnabled,
            tick,
            seedFromCamera,
            setSpeed
        };
    }

    // ---- Registry -------------------------------------------------------
    // One controller active at a time. `switchTo` seeds the incoming
    // controller from the current camera pose so the view doesn't jump.
    function createCameraControls({ camera, canvas }) {
        const all = {
            orbit: createOrbitControls({ camera, canvas }),
            fly: createFlyControls({ camera, canvas })
        };
        let activeName = null;
        let active = null;

        function switchTo(name) {
            if (activeName === name) return;
            const next = all[name];
            if (!next) throw new Error(`camera-controls: unknown controller '${name}'`);
            const firstSwitch = active === null;
            if (active) active.setEnabled(false);
            if (!firstSwitch) next.seedFromCamera();
            next.setEnabled(true);
            active = next;
            activeName = name;
        }

        function tick(dt) {
            if (active && active.tick) active.tick(dt);
        }

        return {
            all,
            switchTo,
            tick,
            get activeName() { return activeName; }
        };
    }

    window.terratileExamples = window.terratileExamples || {};
    window.terratileExamples.createCameraControls = createCameraControls;
})();
