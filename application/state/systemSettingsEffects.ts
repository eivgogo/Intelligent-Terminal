import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  STORAGE_KEY_AUTO_UPDATE_ENABLED,
  STORAGE_KEY_GLOBAL_HOTKEY_ENABLED,
  STORAGE_KEY_TOGGLE_WINDOW_HOTKEY,
  STORAGE_KEY_WINDOW_OPACITY,
  STORAGE_KEY_HTTP_NETWORK_PROXY,
} from '../../infrastructure/config/storageKeys';
import {
  normalizeHttpNetworkProxySettings,
  type HttpNetworkProxySettings,
} from '../../domain/httpNetworkProxy';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  parseWindowOpacityRecord,
  serializeWindowOpacityRecord,
  shouldApplyWindowOpacityRecord,
  shouldBroadcastWindowOpacityChange,
  type WindowOpacityMutationSource,
  type WindowOpacityRecord,
} from './windowOpacitySync';

interface UseSystemSettingsEffectsParams {
  enabled?: boolean;
  toggleWindowHotkey: string;
  globalHotkeyEnabled: boolean;
  windowOpacityRecord: WindowOpacityRecord;
  windowOpacityMutationSourceRef: MutableRefObject<WindowOpacityMutationSource>;
  autoUpdateEnabled: boolean;
  httpNetworkProxy: HttpNetworkProxySettings;
  persistMountedRef: MutableRefObject<boolean>;
  setHotkeyRegistrationError: (error: string | null) => void;
  setAutoUpdateEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;
  notifySettingsChanged: (key: string, value: unknown) => void;
}

export function useSystemSettingsEffects({
  enabled = true,
  toggleWindowHotkey,
  globalHotkeyEnabled,
  windowOpacityRecord,
  windowOpacityMutationSourceRef,
  autoUpdateEnabled,
  httpNetworkProxy,
  persistMountedRef,
  setHotkeyRegistrationError,
  setAutoUpdateEnabled,
  notifySettingsChanged,
}: UseSystemSettingsEffectsParams) {

  // Persist and sync toggle window hotkey setting
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let didRegister = false;
    // Register/unregister the global hotkey in main process (needed on mount)
    const bridge = netcattyBridge.get();
    if (bridge?.registerGlobalHotkey) {
      if (toggleWindowHotkey && globalHotkeyEnabled) {
        setHotkeyRegistrationError(null);
        didRegister = true;
        bridge
          .registerGlobalHotkey(toggleWindowHotkey)
          .then((result) => {
            if (cancelled) return;
            if (result?.success === false) {
              console.warn('[GlobalHotkey] Hotkey registration failed:', result.error);
              setHotkeyRegistrationError(result.error || 'Failed to register hotkey');
            }
          })
          .catch((err) => {
            if (cancelled) return;
            console.warn('[GlobalHotkey] Failed to register hotkey:', err);
            setHotkeyRegistrationError(err?.message || 'Failed to register hotkey');
          });
      } else {
        setHotkeyRegistrationError(null);
        bridge.unregisterGlobalHotkey?.().catch((err) => {
          console.warn('[GlobalHotkey] Failed to unregister hotkey:', err);
        });
      }
    }
    localStorageAdapter.writeString(STORAGE_KEY_TOGGLE_WINDOW_HOTKEY, toggleWindowHotkey);
    // Skip settings-sync IPC on initial mount; still return cleanup below.
    if (persistMountedRef.current) {
      notifySettingsChanged(STORAGE_KEY_TOGGLE_WINDOW_HOTKEY, toggleWindowHotkey);
    }
    return () => {
      cancelled = true;
      // Drop Mount1's registration before Mount2 re-registers (StrictMode), and
      // release the accelerator on real unmount / disable transitions.
      if (didRegister) {
        bridge?.unregisterGlobalHotkey?.().catch((err) => {
          console.warn('[GlobalHotkey] Failed to unregister hotkey on cleanup', err);
        });
      }
    };
  }, [
    toggleWindowHotkey,
    enabled,
    globalHotkeyEnabled,
    notifySettingsChanged,
    persistMountedRef,
    setHotkeyRegistrationError,
  ]);

  // Persist global hotkey enabled setting
  useEffect(() => {
    if (!enabled) return;
    localStorageAdapter.writeString(STORAGE_KEY_GLOBAL_HOTKEY_ENABLED, globalHotkeyEnabled ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_GLOBAL_HOTKEY_ENABLED, globalHotkeyEnabled);
  }, [enabled, globalHotkeyEnabled, notifySettingsChanged, persistMountedRef]);

  // Persist and apply app-level HTTP(S) network proxy (cloud sync / AI)
  useEffect(() => {
    if (!enabled) return;
    const normalized = normalizeHttpNetworkProxySettings(httpNetworkProxy);
    localStorageAdapter.write(STORAGE_KEY_HTTP_NETWORK_PROXY, normalized);
    const bridge = netcattyBridge.get();
    if (bridge?.setHttpNetworkProxy) {
      // Apply to main process; empty custom is treated as system there.
      // Persist draft custom+empty so the URL field remains visible.
      bridge.setHttpNetworkProxy(normalized).catch((err) => {
        console.warn('[NetworkProxy] Failed to apply HTTP network proxy:', err);
      });
    }
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_HTTP_NETWORK_PROXY, normalized);
  }, [enabled, httpNetworkProxy, notifySettingsChanged, persistMountedRef]);

  // Persist and sync window opacity
  useEffect(() => {
    if (!enabled) return;
    const bridge = netcattyBridge.get();
    bridge?.setWindowOpacity?.(windowOpacityRecord.opacity).catch((err) => {
      console.warn('[WindowOpacity] Failed to apply window opacity:', err);
    });
    // Never let a stale effect overwrite a newer revision already on disk.
    const stored = parseWindowOpacityRecord(
      localStorageAdapter.readString(STORAGE_KEY_WINDOW_OPACITY),
    );
    if (
      shouldApplyWindowOpacityRecord(stored, windowOpacityRecord)
      || stored.version === windowOpacityRecord.version
    ) {
      localStorageAdapter.writeString(
        STORAGE_KEY_WINDOW_OPACITY,
        serializeWindowOpacityRecord(windowOpacityRecord),
      );
    }
    const decision = shouldBroadcastWindowOpacityChange(
      windowOpacityMutationSourceRef.current,
      persistMountedRef.current,
    );
    windowOpacityMutationSourceRef.current = decision.nextSource;
    if (!decision.shouldBroadcast) return;
    notifySettingsChanged(STORAGE_KEY_WINDOW_OPACITY, windowOpacityRecord);
  }, [
    enabled,
    windowOpacityRecord,
    windowOpacityMutationSourceRef,
    notifySettingsChanged,
    persistMountedRef,
  ]);

  // Hydrate auto-update state from the main-process preference file on mount.
  // This reconciles localStorage (renderer) with auto-update-pref.json (main)
  // in case localStorage was cleared or is stale.
  useEffect(() => {
    if (!enabled) return;
    const bridge = netcattyBridge.get();
    void bridge?.getAutoUpdate?.().then((result) => {
      if (result && typeof result.enabled === 'boolean') {
        setAutoUpdateEnabled((prev) => {
          if (prev === result.enabled) return prev;
          // Sync localStorage with the main-process truth
          localStorageAdapter.writeString(STORAGE_KEY_AUTO_UPDATE_ENABLED, result.enabled ? 'true' : 'false');
          return result.enabled;
        });
      }
    }).catch(() => { /* bridge unavailable */ });
  }, [enabled, setAutoUpdateEnabled]);

  // Persist auto-update enabled setting.
  // Initial mount still writes localStorage, but skips cross-window/main-process IPC.
  useEffect(() => {
    if (!enabled) return;
    localStorageAdapter.writeString(STORAGE_KEY_AUTO_UPDATE_ENABLED, autoUpdateEnabled ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_AUTO_UPDATE_ENABLED, autoUpdateEnabled);
    // Notify main process on user-initiated changes
    const bridge = netcattyBridge.get();
    bridge?.setAutoUpdate?.(autoUpdateEnabled).catch((err: unknown) => {
      console.warn('[AutoUpdate] Failed to set auto-update:', err);
    });
  }, [enabled, autoUpdateEnabled, notifySettingsChanged, persistMountedRef]);


}
