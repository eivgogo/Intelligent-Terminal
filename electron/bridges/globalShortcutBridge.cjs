/**
 * Global Shortcut Bridge - Handles global keyboard shortcuts (Quake mode /
 * drop-down terminal) and the macOS Dock menu. The system tray icon and its
 * tray panel were removed; this module only serves the global hotkey and the
 * Dock "New Connection" menu.
 */

let electronModule = null;
let ensureMainWindow = null;
let sendWhenRendererReady = null;
let getSystemMenuMainWindow = null;
let currentHotkey = null;
let hotkeyEnabled = false;

// Dynamic Dock menu host data (synced from renderer)
let trayMenuData = {
  sessions: [],        // { id, label, hostLabel, status }
  portForwardRules: [], // { id, label, type, localPort, remoteHost, remotePort, status, hostId, canStop }
  hosts: [],           // { id, label, hostname, group, pinned, lastConnectedAt }
};
// Watchdog: if `leave-full-screen` never arrives (edge case / stuck transition)
// we eventually give up and force a hide attempt. Better a visible window than
// a stuck hide path.
const FULLSCREEN_LEAVE_WATCHDOG_MS = 5000;
// After `leave-full-screen` fires, macOS emits a trailing `show` event while
// the native space transition finishes. Calling `win.hide()` before that show
// causes the window to pop back on screen. We wait for the trailing show, or
// fall back on this timeout — whichever comes first.
const FULLSCREEN_TRAILING_SHOW_FALLBACK_MS = 300;
const pendingFullscreenHideByWindow = new WeakMap();

function clearPendingFullscreenHide(win) {
  if (!win || typeof win !== "object") return;
  const pending = pendingFullscreenHideByWindow.get(win);
  if (!pending) return;

  if (pending.watchdogTimer) {
    clearTimeout(pending.watchdogTimer);
    pending.watchdogTimer = null;
  }
  if (pending.trailingShowTimer) {
    clearTimeout(pending.trailingShowTimer);
    pending.trailingShowTimer = null;
  }

  try {
    if (pending.onLeaveFullScreen) {
      win.removeListener?.("leave-full-screen", pending.onLeaveFullScreen);
    }
    if (pending.onClosed) {
      win.removeListener?.("closed", pending.onClosed);
    }
    if (pending.onTrailingShow) {
      win.removeListener?.("show", pending.onTrailingShow);
    }
  } catch {
    // ignore
  }

  pendingFullscreenHideByWindow.delete(win);
}

function performPendingFullscreenHide(win) {
  const pending = pendingFullscreenHideByWindow.get(win);
  if (!pending) return "cancelled";
  if (!win || win.isDestroyed?.()) {
    clearPendingFullscreenHide(win);
    return "cancelled";
  }

  clearPendingFullscreenHide(win);

  try {
    const windowManager = require("./windowManager.cjs");
    windowManager.notifyWindowWillHide?.(win);
    win.hide();
    return "hidden";
  } catch (err) {
    console.warn("[GlobalShortcut] Error hiding window after leaving fullscreen:", err);
    return "failed";
  }
}

function handleLeaveFullScreenForPendingHide(win) {
  const pending = pendingFullscreenHideByWindow.get(win);
  if (!pending) return;
  if (!win || win.isDestroyed?.()) {
    clearPendingFullscreenHide(win);
    return;
  }

  pending.leaveFullScreenFired = true;

  if (pending.watchdogTimer) {
    clearTimeout(pending.watchdogTimer);
    pending.watchdogTimer = null;
  }

  // Wait for the trailing `show` that macOS emits as the space transition
  // finishes, then hide on top of it. If it never fires within the fallback
  // window, hide anyway.
  pending.onTrailingShow = () => {
    pending.onTrailingShow = null;
    if (pending.trailingShowTimer) {
      clearTimeout(pending.trailingShowTimer);
      pending.trailingShowTimer = null;
    }
    performPendingFullscreenHide(win);
  };
  try {
    win.once?.("show", pending.onTrailingShow);
  } catch {
    // ignore
  }

  pending.trailingShowTimer = setTimeout(() => {
    pending.trailingShowTimer = null;
    if (pending.onTrailingShow) {
      try {
        win.removeListener?.("show", pending.onTrailingShow);
      } catch {
        // ignore
      }
      pending.onTrailingShow = null;
    }
    performPendingFullscreenHide(win);
  }, FULLSCREEN_TRAILING_SHOW_FALLBACK_MS);
}

function startPendingFullscreenHideWatchdog(win) {
  const pending = pendingFullscreenHideByWindow.get(win);
  if (!pending) return;

  pending.watchdogTimer = setTimeout(() => {
    pending.watchdogTimer = null;
    if (!pendingFullscreenHideByWindow.has(win)) return;
    if (!win || win.isDestroyed?.()) {
      clearPendingFullscreenHide(win);
      return;
    }
    if (pending.leaveFullScreenFired) return;

    console.warn("[GlobalShortcut] Timed out waiting for leave-full-screen before hiding window; forcing hide");
    // Give up and hide anyway. Simulate the leave path so the trailing-show
    // wait still applies (defence in depth against spurious show events).
    handleLeaveFullScreenForPendingHide(win);
  }, FULLSCREEN_LEAVE_WATCHDOG_MS);
}

function bringMainWindowToForeground(win) {
  if (!win || win.isDestroyed?.()) return false;
  clearPendingFullscreenHide(win);
  const windowManager = require("./windowManager.cjs");
  const focused = windowManager.showAndFocusMainWindow?.(win) ?? false;
  try {
    electronModule?.app?.focus?.({ steal: true });
  } catch {
    // ignore
  }
  return focused;
}

function getTrackedMainWindow() {
  if (typeof getSystemMenuMainWindow === "function") {
    const win = getSystemMenuMainWindow();
    if (win && !win.isDestroyed?.()) return win;
  }
  try {
    const windowManager = require("./windowManager.cjs");
    const tracked = windowManager.getMainWindow?.();
    if (tracked && !tracked.isDestroyed?.()) return tracked;
  } catch {
    // ignore
  }
  return null;
}

async function getOrCreateMainWindow() {
  const tracked = getTrackedMainWindow();
  if (tracked) {
    return { win: tracked, created: false };
  }
  if (typeof ensureMainWindow === "function") {
    const win = await ensureMainWindow();
    return { win, created: true };
  }
  return { win: null, created: false };
}

async function openMainWindowReady() {
  const { win } = await getOrCreateMainWindow();
  bringMainWindowToForeground(win);
  return win;
}

async function sendToMainWindow(channel, payload, { focus = true, createIfMissing = true } = {}) {
  const { win } = createIfMissing
    ? await getOrCreateMainWindow()
    : { win: getTrackedMainWindow() };
  if (!win) return false;
  if (focus) {
    bringMainWindowToForeground(win);
  }
  try {
    if (typeof sendWhenRendererReady === "function") {
      const result = await sendWhenRendererReady(win, channel, payload, { timeoutMs: 8000 });
      if (!result?.success) {
        console.warn(
          `[GlobalShortcut] Failed to deliver ${channel} to main window:`,
          result?.error || result?.reason || "unknown",
        );
      }
      return result?.success === true;
    }
    win.webContents?.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

async function connectToHostFromSystemMenu(hostId) {
  if (!hostId) return;
  await sendToMainWindow("netcatty:trayPanel:connectToHost", hostId);
}

/**
 * Initialize the bridge with dependencies
 */
function init(deps) {
  electronModule = deps.electronModule;
  ensureMainWindow = deps.ensureMainWindow || null;
  sendWhenRendererReady = deps.sendWhenRendererReady || null;
  getSystemMenuMainWindow = deps.getMainWindow || null;
  updateDockMenu();
}

/**
 * Get the main window reference
 * Uses windowManager's tracked mainWindow for reliability
 */
function getMainWindow() {
  // Prefer the explicitly tracked main window from windowManager
  const windowManager = require("./windowManager.cjs");
  const tracked = windowManager.getMainWindow?.();
  if (tracked && !tracked.isDestroyed?.()) {
    return tracked;
  }
  // Fallback: first non-destroyed window
  const { BrowserWindow } = electronModule;
  const wins = BrowserWindow.getAllWindows();
  const mainWins = wins.filter((w) => !w.isDestroyed?.());
  return mainWins && mainWins.length ? mainWins[0] : null;
}

function hideWindowRespectingMacFullscreen(win) {
  if (!win || win.isDestroyed?.()) return false;

  clearPendingFullscreenHide(win);

  if (process.platform === "darwin" && win.isFullScreen?.()) {
    // Hiding a native-fullscreen window on macOS (used by the global hotkey
    // toggle) has two traps:
    //
    // 1. `isFullScreen()` can flip to false BEFORE the exit animation
    //    completes. Polling it and calling `win.hide()` at that moment
    //    hides the window mid-transition, which macOS then undoes when
    //    the animation finishes.
    // 2. Right after the real `leave-full-screen` event, macOS emits an
    //    internal `show` event as part of finalizing the space transition
    //    — this show undoes any earlier hide.
    //
    // Strategy: wait for `leave-full-screen`, then wait for the trailing
    // `show` that follows it (or a short timeout), and only then hide.
    // All legitimate "bring the window back" entry points
    // (toggleWindowVisibility, app.on("activate"), closed) explicitly call
    // clearPendingFullscreenHide so we never race with genuine user intent.
    const pending = {
      watchdogTimer: null,
      trailingShowTimer: null,
      leaveFullScreenFired: false,
      onLeaveFullScreen: null,
      onClosed: null,
      onTrailingShow: null,
    };
    pending.onLeaveFullScreen = () => {
      handleLeaveFullScreenForPendingHide(win);
    };
    pending.onClosed = () => {
      clearPendingFullscreenHide(win);
    };

    try {
      pendingFullscreenHideByWindow.set(win, pending);
      win.once?.("leave-full-screen", pending.onLeaveFullScreen);
      win.once?.("closed", pending.onClosed);
      startPendingFullscreenHideWatchdog(win);
      win.setFullScreen(false);
      return true;
    } catch (err) {
      clearPendingFullscreenHide(win);
      console.warn("[GlobalShortcut] Error leaving fullscreen before hiding window:", err);
    }
  }

  try {
    const windowManager = require("./windowManager.cjs");
    windowManager.notifyWindowWillHide?.(win);
    win.hide();
    return true;
  } catch (err) {
    console.warn("[GlobalShortcut] Error hiding window:", err);
    return false;
  }
}

/**
 * Convert a hotkey string from frontend format to Electron accelerator format
 * e.g., "⌘ + Space" -> "CommandOrControl+Space"
 *       "Ctrl + `" -> "CommandOrControl+`"
 *       "Alt + Space" -> "Alt+Space"
 */
function toElectronAccelerator(hotkeyStr) {
  if (!hotkeyStr || hotkeyStr === "Disabled" || hotkeyStr === "") {
    return null;
  }

  // Parse the hotkey string
  const parts = hotkeyStr.split("+").map((p) => p.trim());

  // Convert each part to Electron accelerator format
  const acceleratorParts = parts.map((part) => {
    // Mac symbols to Electron format
    if (part === "⌘" || part === "Cmd" || part === "Command") {
      return "CommandOrControl";
    }
    if (part === "⌃" || part === "Ctrl" || part === "Control") {
      return "Control";
    }
    if (part === "⌥" || part === "Alt" || part === "Option") {
      return "Alt";
    }
    if (part === "Shift") {
      return "Shift";
    }
    if (part === "Win" || part === "Super" || part === "Meta") {
      return "Super";
    }
    // Arrow symbols
    if (part === "↑") return "Up";
    if (part === "↓") return "Down";
    if (part === "←") return "Left";
    if (part === "→") return "Right";
    // Special keys
    if (part === "↵" || part === "Enter" || part === "Return") return "Return";
    if (part === "⇥" || part === "Tab") return "Tab";
    if (part === "⌫" || part === "Backspace") return "Backspace";
    if (part === "Del" || part === "Delete") return "Delete";
    if (part === "Esc" || part === "Escape") return "Escape";
    if (part === "Space") return "Space";
    // Backtick/grave accent
    if (part === "`" || part === "~") return "`";
    // Function keys
    if (/^F\d+$/i.test(part)) return part.toUpperCase();
    // Single character - keep as-is
    return part;
  });

  return acceleratorParts.join("+");
}

/**
 * Toggle the main window visibility
 */
function toggleWindowVisibility() {
  const win = getMainWindow();
  if (!win) return;

  try {
    // Check if window is minimized first - minimized windows may still report isVisible() = true
    if (win.isMinimized()) {
      bringMainWindowToForeground(win);
    } else if (win.isVisible()) {
      if (win.isFocused()) {
        // Window is visible and focused - hide it
        hideWindowRespectingMacFullscreen(win);
      } else {
        // Window is visible but not focused - focus it
        bringMainWindowToForeground(win);
      }
    } else {
      // Window is hidden - show and focus it
      bringMainWindowToForeground(win);
    }
  } catch (err) {
    console.warn("[GlobalShortcut] Error toggling window visibility:", err);
  }
}

/**
 * Register the global toggle hotkey
 */
function registerGlobalHotkey(hotkeyStr) {
  const { globalShortcut } = electronModule;

  // Unregister existing hotkey first
  unregisterGlobalHotkey();

  if (!hotkeyStr || hotkeyStr === "Disabled" || hotkeyStr === "") {
    hotkeyEnabled = false;
    currentHotkey = null;
    return { success: true, enabled: false };
  }

  const accelerator = toElectronAccelerator(hotkeyStr);
  if (!accelerator) {
    hotkeyEnabled = false;
    currentHotkey = null;
    return { success: false, error: "Invalid hotkey format" };
  }

  try {
    const registered = globalShortcut.register(accelerator, toggleWindowVisibility);
    if (registered) {
      hotkeyEnabled = true;
      currentHotkey = hotkeyStr;
      console.log(`[GlobalShortcut] Registered hotkey: ${accelerator}`);
      return { success: true, enabled: true, accelerator };
    } else {
      console.warn(`[GlobalShortcut] Failed to register hotkey: ${accelerator}`);
      return { success: false, error: "Hotkey may be in use by another application" };
    }
  } catch (err) {
    console.error("[GlobalShortcut] Error registering hotkey:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Unregister the global toggle hotkey
 */
function unregisterGlobalHotkey() {
  if (!hotkeyEnabled || !currentHotkey) return;

  const { globalShortcut } = electronModule;
  const accelerator = toElectronAccelerator(currentHotkey);

  if (accelerator) {
    try {
      globalShortcut.unregister(accelerator);
      console.log(`[GlobalShortcut] Unregistered hotkey: ${accelerator}`);
    } catch (err) {
      console.warn("[GlobalShortcut] Error unregistering hotkey:", err);
    }
  }

  hotkeyEnabled = false;
  currentHotkey = null;
}

function getDockHostLabel(host) {
  const label = typeof host?.label === "string" ? host.label.trim() : "";
  if (label) return label;
  const hostname = typeof host?.hostname === "string" ? host.hostname.trim() : "";
  return hostname || "Untitled Host";
}

function getDockHostLastConnectedAt(host) {
  const value = Number(host?.lastConnectedAt);
  return Number.isFinite(value) ? value : 0;
}

function getDockMenuHosts() {
  return (Array.isArray(trayMenuData.hosts) ? trayMenuData.hosts : [])
    .filter((host) => host && typeof host.id === "string" && host.id.length > 0)
    .slice()
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      const recentDiff = getDockHostLastConnectedAt(b) - getDockHostLastConnectedAt(a);
      if (recentDiff !== 0) return recentDiff;
      return getDockHostLabel(a).localeCompare(getDockHostLabel(b), undefined, { sensitivity: "base" });
    });
}

function buildDockMenuTemplate() {
  const hostItems = getDockMenuHosts().map((host) => ({
    label: getDockHostLabel(host),
    click: async () => {
      await connectToHostFromSystemMenu(host.id);
    },
  }));

  return [
    {
      label: "Open Main Window",
      click: async () => {
        await openMainWindowReady();
      },
    },
    { type: "separator" },
    {
      label: "New Connection",
      enabled: hostItems.length > 0,
      submenu: hostItems.length > 0
        ? hostItems
        : [{ label: "No Saved Hosts", enabled: false }],
    },
  ];
}

function updateDockMenu() {
  if (!electronModule || process.platform !== "darwin") return;
  const { Menu, app } = electronModule;
  if (!Menu || !app?.dock?.setMenu) return;

  try {
    app.dock.setMenu(Menu.buildFromTemplate(buildDockMenuTemplate()));
  } catch {
    // ignore
  }
}

/**
 * Update Dock menu data from renderer
 */
function setTrayMenuData(data) {
  if (data.sessions !== undefined) {
    trayMenuData.sessions = data.sessions;
  }
  if (data.portForwardRules !== undefined) {
    trayMenuData.portForwardRules = data.portForwardRules;
  }
  if (data.hosts !== undefined) {
    trayMenuData.hosts = data.hosts;
  }
  // Rebuild the Dock menu with new data
  updateDockMenu();
}

/**
 * Get current hotkey status
 */
function getHotkeyStatus() {
  return {
    enabled: hotkeyEnabled,
    hotkey: currentHotkey,
  };
}

/**
 * Register IPC handlers
 */
function registerHandlers(ipcMain) {
  // Register global toggle hotkey
  ipcMain.handle("netcatty:globalHotkey:register", async (_event, { hotkey }) => {
    return registerGlobalHotkey(hotkey);
  });

  // Unregister global toggle hotkey
  ipcMain.handle("netcatty:globalHotkey:unregister", async () => {
    unregisterGlobalHotkey();
    return { success: true };
  });

  // Get current hotkey status
  ipcMain.handle("netcatty:globalHotkey:status", async () => {
    return getHotkeyStatus();
  });

  // Update Dock menu data (used by the macOS Dock "New Connection" menu)
  ipcMain.handle("netcatty:tray:updateMenuData", async (_event, data) => {
    setTrayMenuData(data);
    return { success: true };
  });

  // Open / focus the main window (used by external MCP/CLI host-open)
  ipcMain.handle("netcatty:trayPanel:openMainWindow", async () => {
    await openMainWindowReady();
    return { success: true };
  });

  console.log("[GlobalShortcut] IPC handlers registered");
}

/**
 * Cleanup on app quit
 */
function cleanup() {
  unregisterGlobalHotkey();
  if (electronModule?.app?.dock?.setMenu) {
    try {
      electronModule.app.dock.setMenu(null);
    } catch {
      // ignore
    }
  }
}

module.exports = {
  init,
  registerHandlers,
  clearPendingFullscreenHide,
  cleanup,
};
