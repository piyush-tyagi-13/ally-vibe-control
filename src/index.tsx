import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  SliderField,
  ToggleField,
} from "@decky/ui";
import { callable, definePlugin } from "@decky/api";

// SP_REACT and SP_REACTDOM are globals injected by the Steam/Decky runtime.
// We do NOT import react — that would leave an `import` statement in the bundle
// which Decky loads as a plain script, not an ES module.
declare const SP_REACT: any;
const { useState, useRef, useEffect, useCallback } = SP_REACT;

// SteamClient is a global injected by the Steam client runtime. We use it to
// subscribe to resume-from-suspend events so we can re-apply intensity on wake.
declare const SteamClient: any;

// Module-level cache: survives component remounts within the same plugin session.
// Decky unmounts the panel component each time the user closes the QAM, so
// useState(50) would re-initialize every visit without this cache.
let _cache: { left: number; right: number } | null = null;

// ------------------------------------------------------------------ //
// Backend callables
// ------------------------------------------------------------------ //

const getIntensity = callable<[], { left: number; right: number }>(
  "get_intensity"
);

const setIntensityLinked = callable<[value: number], { success: boolean; left: number; right: number }>(
  "set_intensity_linked"
);

const setIntensity = callable<[left: number, right: number], { success: boolean; left: number; right: number }>(
  "set_intensity"
);

const resetToDefault = callable<[], { success: boolean; left: number; right: number }>(
  "reset_to_default"
);

const getSysfsPath = callable<[], { path: string | null; found: boolean }>(
  "get_sysfs_path"
);

const testVibration = callable<[duration_ms: number], { success: boolean; error?: string }>(
  "test_vibration"
);

const reapplyIntensity = callable<[], { success: boolean; left: number; right: number }>(
  "reapply_intensity"
);

// ------------------------------------------------------------------ //
// Styles
// ------------------------------------------------------------------ //

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 0",
  },
  dot: (ok: boolean) => ({
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    backgroundColor: ok ? "#4ade80" : "#f87171",
    flexShrink: 0,
  }),
  statusText: (ok: boolean) => ({
    fontSize: "11px",
    color: ok ? "#4ade80" : "#f87171",
    fontFamily: "monospace",
    wordBreak: "break-all" as const,
  }),
  valueTag: {
    fontSize: "13px",
    fontWeight: "bold",
    color: "#fff",
    background: "rgba(255,255,255,0.1)",
    borderRadius: "4px",
    padding: "1px 6px",
    fontFamily: "monospace",
  },
  warningBox: {
    background: "rgba(251,191,36,0.15)",
    border: "1px solid rgba(251,191,36,0.4)",
    borderRadius: "6px",
    padding: "8px 10px",
    fontSize: "11px",
    color: "rgba(251,191,36,0.9)",
    lineHeight: "1.5",
    marginTop: "4px",
  },
};

// ------------------------------------------------------------------ //
// Main component
// ------------------------------------------------------------------ //

const AllyVibeControl = () => {
  const [leftVal, setLeftVal] = useState<number>(_cache?.left ?? 50);
  const [rightVal, setRightVal] = useState<number>(_cache?.right ?? 50);
  const [linked, setLinked] = useState<boolean>(
    _cache ? _cache.left === _cache.right : true
  );
  const [sysfsPath, setSysfsPath] = useState<string | null>(null);
  const [sysfsFound, setSysfsFound] = useState<boolean>(false);
  // Skip loading spinner when we already have cached values to show immediately.
  const [loading, setLoading] = useState<boolean>(_cache === null);
  const [applying, setApplying] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const linkedTimer = useRef<ReturnType<typeof setTimeout>>();
  const splitTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const init = async () => {
      try {
        const [intensity, sysfs] = await Promise.all([
          getIntensity(),
          getSysfsPath(),
        ]);
        _cache = { left: intensity.left, right: intensity.right };
        setLeftVal(intensity.left);
        setRightVal(intensity.right);
        setLinked(intensity.left === intensity.right);
        setSysfsPath(sysfs.path);
        setSysfsFound(sysfs.found);
      } catch (e) {
        console.error("[ally-vibe] init error", e);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, []);

  const applyLinked = useCallback(async (val: number) => {
    setApplying(true);
    try {
      const res = await setIntensityLinked(val);
      _cache = { left: res.left, right: res.right };
      setLeftVal(res.left);
      setRightVal(res.right);
    } finally {
      setApplying(false);
    }
  }, []);

  const applySplit = useCallback(async (l: number, r: number) => {
    setApplying(true);
    try {
      const res = await setIntensity(l, r);
      _cache = { left: res.left, right: res.right };
      setLeftVal(res.left);
      setRightVal(res.right);
    } finally {
      setApplying(false);
    }
  }, []);

  const handleReset = useCallback(async () => {
    setApplying(true);
    try {
      const res = await resetToDefault();
      _cache = { left: res.left, right: res.right };
      setLeftVal(res.left);
      setRightVal(res.right);
      setLinked(true);
    } finally {
      setApplying(false);
    }
  }, []);

  const handleTestVibration = useCallback(async () => {
    setTesting(true);
    try {
      await testVibration(500);
    } finally {
      setTesting(false);
    }
  }, []);

  const handleLinkedChange = useCallback((val: boolean) => {
    setLinked(val);
    if (val && leftVal !== rightVal) {
      void applySplit(leftVal, leftVal);
    }
  }, [leftVal, rightVal, applySplit]);

  if (loading) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <span>Loading...</span>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <div style={styles.container}>
      <PanelSection title="Driver Status">
        <PanelSectionRow>
          <div style={styles.statusRow}>
            <div style={styles.dot(sysfsFound)} />
            <span style={styles.statusText(sysfsFound)}>
              {sysfsFound
                ? sysfsPath ?? "Found"
                : "asus_ally_hid driver not found"}
            </span>
          </div>
        </PanelSectionRow>
        {!sysfsFound && (
          <PanelSectionRow>
            <div style={styles.warningBox}>
              The asus_ally_hid sysfs endpoint was not detected. Make sure your
              kernel includes the driver (SteamOS 3.7+ on Ally hardware).
            </div>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Vibration Intensity">
        <PanelSectionRow>
          <ToggleField
            label="Link both motors"
            description="Control left and right motors together"
            checked={linked}
            onChange={handleLinkedChange}
          />
        </PanelSectionRow>

        {linked ? (
          <PanelSectionRow>
            <SliderField
              label="Intensity"
              description={
                <span>
                  Both motors: <span style={styles.valueTag}>{leftVal}%</span>
                </span>
              }
              value={leftVal}
              min={0}
              max={100}
              step={5}
              disabled={applying}
              onChange={(val: number) => {
                setLeftVal(val);
                setRightVal(val);
                clearTimeout(linkedTimer.current);
                linkedTimer.current = setTimeout(() => void applyLinked(val), 200);
              }}
            />
          </PanelSectionRow>
        ) : (
          <>
            <PanelSectionRow>
              <SliderField
                label="Left motor"
                description={
                  <span>
                    Left grip: <span style={styles.valueTag}>{leftVal}%</span>
                  </span>
                }
                value={leftVal}
                min={0}
                max={100}
                step={5}
                disabled={applying}
                onChange={(val: number) => {
                  setLeftVal(val);
                  clearTimeout(splitTimer.current);
                  splitTimer.current = setTimeout(() => void applySplit(val, rightVal), 200);
                }}
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <SliderField
                label="Right motor"
                description={
                  <span>
                    Right grip: <span style={styles.valueTag}>{rightVal}%</span>
                  </span>
                }
                value={rightVal}
                min={0}
                max={100}
                step={5}
                disabled={applying}
                onChange={(val: number) => {
                  setRightVal(val);
                  clearTimeout(splitTimer.current);
                  splitTimer.current = setTimeout(() => void applySplit(leftVal, val), 200);
                }}
              />
            </PanelSectionRow>
          </>
        )}
      </PanelSection>

      <PanelSection title="Actions">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={handleTestVibration}
            disabled={applying || testing}
          >
            {testing ? "Vibrating..." : "Test Vibration (0.5s)"}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={handleReset}
            disabled={applying || testing}
          >
            Reset to 50% (default)
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() => void applySplit(0, 0)}
            disabled={applying || testing}
          >
            Disable vibration (0%)
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() => void applyLinked(100)}
            disabled={applying || testing}
          >
            Full intensity (100%)
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Notes">
        <PanelSectionRow>
          <div style={styles.warningBox}>
            Trigger (impulse) vibration cannot be controlled via sysfs at this
            time — this is a known kernel limitation tracked in Valve issue
            #12673. Only the grip motors are affected by these sliders.
            Settings persist across reboots and are re-applied automatically
            after waking from sleep.
          </div>
        </PanelSectionRow>
      </PanelSection>
    </div>
  );
};

// ------------------------------------------------------------------ //
// Plugin entry point
// ------------------------------------------------------------------ //

// Subscribe to resume-from-suspend. Newer Steam clients (mid-2026) removed
// SteamClient.System.RegisterForOnResumeFromSuspend; the replacement signal is
// SteamClient.User.RegisterForResumeSuspendedGamesProgress, which fires
// (possibly several times) while Steam resumes after wake, so debounce it.
const registerForResume = (
  callback: () => void
): { unregister?: () => void } | null => {
  const system = SteamClient?.System;
  if (system?.RegisterForOnResumeFromSuspend) {
    return system.RegisterForOnResumeFromSuspend(callback);
  }
  const user = SteamClient?.User;
  if (user?.RegisterForResumeSuspendedGamesProgress) {
    let lastFired = 0;
    return user.RegisterForResumeSuspendedGamesProgress(() => {
      const now = Date.now();
      if (now - lastFired < 5000) return;
      lastFired = now;
      callback();
    });
  }
  console.error("[ally-vibe] no resume-from-suspend API available");
  return null;
};

export default definePlugin(() => {
  // On resume from suspend the device re-enumerates and the asus_ally_hid
  // driver resets vibration_intensity to its default (max). The saved settings
  // and the UI are unaffected, so the motors silently run at full strength
  // until the value is re-written. Re-apply it automatically on wake.
  //
  // Registered here at the plugin root (not inside the panel component) so it
  // stays active even when the Quick Access Menu is closed and the panel has
  // unmounted.
  const resumeRegistration = registerForResume(() => {
    reapplyIntensity().catch((e) =>
      console.error("[ally-vibe] resume reapply failed", e)
    );
  });

  return {
    name: "Ally Vibe Control",
    titleView: <span>Ally Vibe Control</span>,
    content: <AllyVibeControl />,
    icon: <span>📳</span>,
    onDismount() {
      resumeRegistration?.unregister?.();
    },
  };
});
