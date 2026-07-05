import decky
import os
import glob
import asyncio
import struct
import fcntl
from settings import SettingsManager

# ------------------------------------------------------------------ #
# Constants
# ------------------------------------------------------------------ #

# Primary sysfs path (hidraw node - can shift between reboots)
HIDRAW_GLOB = "/sys/class/hidraw/*/device/vibration_intensity"

# Stable driver-bound path (preferred, survives hidraw node re-numbering)
DRIVER_GLOB = (
    "/sys/module/hid_asus_ally/drivers/hid:asus_rog_ally/"
    "*/vibration_intensity"
)

DEFAULT_INTENSITY = 50  # 0-100 on each motor
SETTINGS_KEY_LEFT = "intensity_left"
SETTINGS_KEY_RIGHT = "intensity_right"

settings = SettingsManager(
    name="settings",
    settings_directory=decky.DECKY_PLUGIN_SETTINGS_DIR,
)

# Force-feedback ioctl numbers (Linux x86-64, sizeof(ff_effect) == 48)
# EVIOCGBIT(EV_FF=0x15, 32 bytes) → check which FF effect types are supported
_EVIOCGBIT_FF  = 0x80204535
# EVIOCSFF → upload an ff_effect struct; kernel writes back the assigned id
_EVIOCSFF      = 0x40304580
# EVIOCRMFF → remove an effect by id (id passed by value, not by pointer)
_EVIOCRMFF     = 0x40044581
_EV_FF         = 0x15
_FF_RUMBLE     = 0x50


# ------------------------------------------------------------------ #
# Helpers
# ------------------------------------------------------------------ #

def _find_ff_device() -> str | None:
    """Return the first /dev/input/eventX that advertises FF_RUMBLE capability."""
    for path in sorted(glob.glob('/dev/input/event*')):
        try:
            with open(path, 'rb') as fh:
                bits = bytearray(32)
                fcntl.ioctl(fh.fileno(), _EVIOCGBIT_FF, bits)
                if bits[_FF_RUMBLE // 8] & (1 << (_FF_RUMBLE % 8)):
                    decky.logger.info(f"[ally-vibe] FF device: {path}")
                    return path
        except Exception:
            pass
    return None


def _find_sysfs_path() -> str | None:
    """
    Return the first matching vibration_intensity sysfs path.
    Prefer the stable driver path; fall back to hidraw glob.
    """
    for pattern in (DRIVER_GLOB, HIDRAW_GLOB):
        matches = glob.glob(pattern)
        if matches:
            decky.logger.info(f"[ally-vibe] sysfs path: {matches[0]}")
            return matches[0]
    decky.logger.warning("[ally-vibe] No vibration_intensity sysfs path found")
    return None


def _clamp(value: int, lo: int = 0, hi: int = 100) -> int:
    return max(lo, min(hi, value))


def _write_intensity(left: int, right: int) -> bool:
    """
    Write 'LEFT RIGHT' to the sysfs endpoint.
    Must run as root (plugin.json flags: ["root"]).
    Returns True on success.
    """
    path = _find_sysfs_path()
    if path is None:
        decky.logger.error("[ally-vibe] sysfs path not found - write aborted")
        return False

    payload = f"{left} {right}\n"
    try:
        with open(path, "w") as f:
            f.write(payload)
        decky.logger.info(f"[ally-vibe] wrote '{payload.strip()}' -> {path}")
        return True
    except OSError as exc:
        decky.logger.error(f"[ally-vibe] write failed: {exc}")
        return False


# ------------------------------------------------------------------ #
# Plugin class
# ------------------------------------------------------------------ #

class Plugin:

    # ---- lifecycle ------------------------------------------------ #

    async def _main(self):
        """Called once when the plugin loads. Restore saved intensity."""
        settings.read()
        left = settings.getSetting(SETTINGS_KEY_LEFT, DEFAULT_INTENSITY)
        right = settings.getSetting(SETTINGS_KEY_RIGHT, DEFAULT_INTENSITY)
        decky.logger.info(
            f"[ally-vibe] startup - restoring L={left} R={right}"
        )
        _write_intensity(_clamp(left), _clamp(right))

    async def _unload(self):
        decky.logger.info("[ally-vibe] unloaded")

    async def reapply_intensity(self) -> dict:
        """
        Re-write the saved intensity to the hardware.

        Called from the frontend on resume from suspend. On wake the device
        re-enumerates and the asus_ally_hid driver resets vibration_intensity
        to its default (max), while our saved settings are untouched. The UI
        still shows the saved value but the motors are running at full strength
        until something re-writes the sysfs endpoint. This restores it.

        The hidraw node may take a moment to re-enumerate after wake, so retry
        a few times before giving up.
        """
        settings.read()
        left = _clamp(settings.getSetting(SETTINGS_KEY_LEFT, DEFAULT_INTENSITY))
        right = _clamp(settings.getSetting(SETTINGS_KEY_RIGHT, DEFAULT_INTENSITY))

        ok = False
        for attempt in range(5):
            ok = _write_intensity(left, right)
            if ok:
                break
            decky.logger.info(
                f"[ally-vibe] reapply attempt {attempt + 1} failed, retrying"
            )
            await asyncio.sleep(1.0)

        decky.logger.info(
            f"[ally-vibe] resume reapply - L={left} R={right} ok={ok}"
        )
        return {"success": ok, "left": left, "right": right}

    # ---- RPC surface (called from TypeScript) --------------------- #

    async def get_intensity(self) -> dict:
        """Return current saved intensities."""
        settings.read()
        return {
            "left": settings.getSetting(SETTINGS_KEY_LEFT, DEFAULT_INTENSITY),
            "right": settings.getSetting(SETTINGS_KEY_RIGHT, DEFAULT_INTENSITY),
        }

    async def set_intensity(self, left: int, right: int) -> dict:
        """
        Set vibration intensity for both motors.
        Values are 0-100 (percentage).
        """
        left = _clamp(int(left))
        right = _clamp(int(right))

        # Save the user's intent before writing to hardware so the preference
        # persists even when the driver is temporarily unavailable.
        settings.setSetting(SETTINGS_KEY_LEFT, left)
        settings.setSetting(SETTINGS_KEY_RIGHT, right)
        settings.commit()

        ok = _write_intensity(left, right)
        return {"success": ok, "left": left, "right": right}

    async def set_intensity_linked(self, value: int) -> dict:
        """Set both motors to the same value (linked/single-slider mode)."""
        return await self.set_intensity(value, value)

    async def get_sysfs_path(self) -> dict:
        """Expose discovered sysfs path for diagnostics."""
        path = _find_sysfs_path()
        return {"path": path, "found": path is not None}

    async def reset_to_default(self) -> dict:
        """Reset both motors to 50%."""
        return await self.set_intensity(DEFAULT_INTENSITY, DEFAULT_INTENSITY)

    async def test_vibration(self, duration_ms: int = 500) -> dict:
        """
        Fire a short rumble so the user can feel the current intensity.

        Uses the Linux evdev force-feedback interface (FF_RUMBLE).
        strong_magnitude → left (grip) motor, scaled to the saved left intensity.
        weak_magnitude   → right (grip) motor, scaled to the saved right intensity.
        The sysfs vibration_intensity value further scales whatever the driver applies.
        """
        settings.read()
        left  = _clamp(settings.getSetting(SETTINGS_KEY_LEFT,  DEFAULT_INTENSITY))
        right = _clamp(settings.getSetting(SETTINGS_KEY_RIGHT, DEFAULT_INTENSITY))
        duration = max(100, min(2000, int(duration_ms)))

        strong_mag = int(0xFFFF * left  / 100)
        weak_mag   = int(0xFFFF * right / 100)

        ff_path = _find_ff_device()
        if ff_path is None:
            decky.logger.warning("[ally-vibe] test_vibration: no FF device found")
            return {"success": False, "error": "No rumble-capable input device found"}

        try:
            fd = os.open(ff_path, os.O_RDWR)
            try:
                # Build ff_effect (48 bytes) for FF_RUMBLE:
                #   H  type             FF_RUMBLE
                #   h  id               -1 (kernel assigns)
                #   H  direction        0
                #   HH trigger          button=0, interval=0
                #   HH replay           length=duration_ms, delay=0
                #   xx 2 pad bytes      (align union to 8-byte boundary)
                #   H  strong_magnitude left motor
                #   H  weak_magnitude   right motor
                #   28x union padding
                effect_buf = bytearray(struct.pack(
                    '<HhHHHHHxxHH28x',
                    _FF_RUMBLE, -1, 0,
                    0, 0,
                    duration, 0,
                    strong_mag, weak_mag,
                ))
                fcntl.ioctl(fd, _EVIOCSFF, effect_buf)
                effect_id = struct.unpack_from('<h', effect_buf, 2)[0]

                import time
                def _input_event(ev_type: int, code: int, value: int) -> bytes:
                    t = time.time()
                    return struct.pack('<qqHHi', int(t), int((t % 1) * 1e6),
                                      ev_type, code, value)

                os.write(fd, _input_event(_EV_FF, effect_id, 1))   # play
                await asyncio.sleep(duration / 1000.0)
                os.write(fd, _input_event(_EV_FF, effect_id, 0))   # stop
                # EVIOCRMFF takes the effect id as the ioctl argument value
                # itself, not a pointer to it — passing a packed buffer makes
                # the kernel read the buffer address as the id and fail EINVAL.
                fcntl.ioctl(fd, _EVIOCRMFF, effect_id)

                decky.logger.info(
                    f"[ally-vibe] test_vibration: L={left}% R={right}% "
                    f"duration={duration}ms via {ff_path}"
                )
                return {"success": True}
            finally:
                os.close(fd)
        except Exception as exc:
            decky.logger.error(f"[ally-vibe] test_vibration failed: {exc}")
            return {"success": False, "error": str(exc)}
