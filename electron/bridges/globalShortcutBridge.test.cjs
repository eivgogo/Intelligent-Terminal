const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

function withPatchedTimers(run) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let nextTimerId = 1;
  const timers = new Map();

  global.setTimeout = (fn, _delay, ...args) => {
    const id = nextTimerId++;
    timers.set(id, () => fn(...args));
    return id;
  };

  global.clearTimeout = (id) => {
    timers.delete(id);
  };

  const flushNextTimer = () => {
    const nextEntry = timers.entries().next().value;
    if (!nextEntry) return false;
    const [id, fn] = nextEntry;
    timers.delete(id);
    fn();
    return true;
  };

  const getPendingTimerCount = () => timers.size;

  return Promise.resolve()
    .then(() => run({ flushNextTimer, getPendingTimerCount }))
    .finally(() => {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    });
}

function loadBridge() {
  const bridgePath = require.resolve("./globalShortcutBridge.cjs");
  delete require.cache[bridgePath];
  return require("./globalShortcutBridge.cjs");
}

function createElectronStub() {
  return {
    Menu: {
      buildFromTemplate(template) {
        return { template };
      },
    },
    BrowserWindow: {
      getAllWindows() {
        return [];
      },
    },
    globalShortcut: {
      register() {
        return true;
      },
      unregister() {},
    },
    app: {
      dock: {
        menu: null,
        setMenu(menu) {
          this.menu = menu;
        },
      },
      getAppPath() {
        return process.cwd();
      },
      focus() {},
      quit() {},
    },
  };
}

function createIpcMainStub() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
}

class FakeWindow extends EventEmitter {
  constructor({ fullscreen = false } = {}) {
    super();
    this.fullscreen = fullscreen;
    this.hideCalls = 0;
    this.showCalls = 0;
    this.focusCalls = 0;
    this.restoreCalls = 0;
    this.setFullScreenCalls = [];
    this.destroyed = false;
    this.minimized = false;
    this.visible = true;
    this.focused = true;
  }

  isDestroyed() {
    return this.destroyed;
  }

  isFullScreen() {
    return this.fullscreen;
  }

  setFullScreen(nextValue) {
    this.setFullScreenCalls.push(nextValue);
    if (nextValue) {
      this.fullscreen = true;
    }
  }

  isMinimized() {
    return this.minimized;
  }

  restore() {
    this.restoreCalls += 1;
    this.minimized = false;
  }

  isVisible() {
    return this.visible;
  }

  isFocused() {
    return this.focused;
  }

  hide() {
    this.hideCalls += 1;
    this.visible = false;
    this.focused = false;
  }

  show() {
    this.showCalls += 1;
    this.visible = true;
    this.emit("show");
  }

  focus() {
    this.focusCalls += 1;
    this.focused = true;
  }
}

async function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

/**
 * Init the bridge with a registered global toggle hotkey and return a trigger
 * for its handler. The system tray was removed, so the bridge only exercises
 * the global hotkey (Quake mode) and the macOS Dock menu.
 */
function setupHotkeyBridge({ electronModule = createElectronStub(), win = null, deps = {} } = {}) {
  const bridge = loadBridge();
  let toggleWindow = null;
  electronModule.globalShortcut.register = (_accelerator, handler) => {
    toggleWindow = handler;
    return true;
  };
  if (win) {
    electronModule.BrowserWindow.getAllWindows = () => [win];
    deps.getMainWindow = deps.getMainWindow || (() => win);
  }
  bridge.init({ electronModule, ...deps });
  const ipcMain = createIpcMainStub();
  bridge.registerHandlers(ipcMain);
  // Register a hotkey through the IPC handler so toggleWindowVisibility is wired.
  ipcMain.handlers.get("netcatty:globalHotkey:register")(null, { hotkey: "Ctrl + `" });
  return {
    bridge,
    ipcMain,
    electronModule,
    toggleWindow: () => toggleWindow(),
  };
}

// ---- Global hotkey (Quake mode) -------------------------------------------

test("toggleWindowVisibility show path delegates to showAndFocusMainWindow on win32", async () => {
  await withPlatform("win32", async () => {
    const windowManagerPath = require.resolve("./windowManager.cjs");
    const actualWindowManager = require(windowManagerPath);
    const showCalls = [];
    let appFocusCalls = 0;

    require.cache[windowManagerPath].exports = {
      ...actualWindowManager,
      showAndFocusMainWindow(win) {
        showCalls.push(win);
        return true;
      },
    };

    try {
      const electronModule = createElectronStub();
      electronModule.app.focus = () => {
        appFocusCalls += 1;
      };
      const win = new FakeWindow();
      win.visible = false;
      win.focused = false;
      const { toggleWindow } = setupHotkeyBridge({ electronModule, win });

      toggleWindow();

      assert.equal(showCalls.length, 1);
      assert.equal(showCalls[0], win);
      assert.equal(appFocusCalls, 1);
      assert.equal(win.showCalls, 0, "should not call bare win.show()");
      assert.equal(win.focusCalls, 0, "should not call bare win.focus()");
    } finally {
      require.cache[windowManagerPath].exports = actualWindowManager;
    }
  });
});

test("toggleWindowVisibility focuses visible-but-unfocused windows via showAndFocusMainWindow", async () => {
  await withPlatform("win32", async () => {
    const windowManagerPath = require.resolve("./windowManager.cjs");
    const actualWindowManager = require(windowManagerPath);
    const showCalls = [];

    require.cache[windowManagerPath].exports = {
      ...actualWindowManager,
      showAndFocusMainWindow(win) {
        showCalls.push(win);
        return true;
      },
    };

    try {
      const electronModule = createElectronStub();
      const win = new FakeWindow();
      win.visible = true;
      win.focused = false;
      const { toggleWindow } = setupHotkeyBridge({ electronModule, win });

      toggleWindow();

      assert.equal(showCalls.length, 1);
      assert.equal(win.hideCalls, 0);
    } finally {
      require.cache[windowManagerPath].exports = actualWindowManager;
    }
  });
});

test("toggleWindowVisibility hides a focused window (Quake hide path)", async () => {
  await withPlatform("darwin", async () => {
    const win = new FakeWindow(); // visible + focused
    const { toggleWindow } = setupHotkeyBridge({ win });

    toggleWindow();

    assert.equal(win.hideCalls, 1);
  });
});

// ---- Fullscreen-aware hide (used by the global hotkey) --------------------

test("hotkey hide on a mac fullscreen window defers until after leave-full-screen and the trailing show", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const win = new FakeWindow({ fullscreen: true }); // visible + focused
      const { toggleWindow } = setupHotkeyBridge({ win });

      toggleWindow(); // focused + visible + fullscreen -> deferred hide

      assert.deepEqual(win.setFullScreenCalls, [false]);
      assert.equal(win.hideCalls, 0);
      assert.equal(getPendingTimerCount(), 1);
      assert.equal(win.listenerCount("show"), 0);

      // Spurious early show (mid-animation) does nothing.
      win.emit("show");
      assert.equal(win.hideCalls, 0);
      assert.equal(getPendingTimerCount(), 1);

      // leave-full-screen arrives; arm the trailing-show listener + fallback.
      win.fullscreen = false;
      win.emit("leave-full-screen");
      assert.equal(win.hideCalls, 0);
      assert.equal(getPendingTimerCount(), 1);
      assert.equal(win.listenerCount("show"), 1);

      // Trailing show finalizes the space transition -> hide.
      win.emit("show");
      assert.equal(win.hideCalls, 1);
      assert.equal(win.listenerCount("show"), 0);
      assert.equal(win.listenerCount("leave-full-screen"), 0);
      assert.equal(win.listenerCount("closed"), 0);
      assert.equal(getPendingTimerCount(), 0);
    });
  });
});

test("fallback timer hides the window when the trailing show never arrives", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const win = new FakeWindow({ fullscreen: true });
      const { toggleWindow } = setupHotkeyBridge({ win });

      toggleWindow();
      win.fullscreen = false;
      win.emit("leave-full-screen");

      assert.equal(getPendingTimerCount(), 1);
      assert.equal(win.hideCalls, 0);
      assert.equal(win.listenerCount("show"), 1);

      flushNextTimer();

      assert.equal(win.hideCalls, 1);
      assert.equal(win.listenerCount("show"), 0);
      assert.equal(getPendingTimerCount(), 0);
    });
  });
});

test("watchdog forces the hide path if leave-full-screen never arrives", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const win = new FakeWindow({ fullscreen: true });
      const { toggleWindow } = setupHotkeyBridge({ win });

      toggleWindow();
      assert.equal(getPendingTimerCount(), 1);

      // Watchdog fires (simulates 5s with no leave-full-screen). It forces
      // the leave path — which arms the trailing-show listener + fallback.
      flushNextTimer();
      assert.equal(win.hideCalls, 0);
      assert.equal(getPendingTimerCount(), 1);
      assert.equal(win.listenerCount("show"), 1);

      // Trailing-show fallback fires -> hide.
      flushNextTimer();
      assert.equal(win.hideCalls, 1);
      assert.equal(getPendingTimerCount(), 0);
    });
  });
});

test("clearPendingFullscreenHide cancels a pending hotkey hide", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const win = new FakeWindow({ fullscreen: true });
      const { bridge, toggleWindow } = setupHotkeyBridge({ win });

      toggleWindow();
      assert.equal(getPendingTimerCount(), 1);

      bridge.clearPendingFullscreenHide(win);

      assert.equal(getPendingTimerCount(), 0);
      assert.equal(win.listenerCount("leave-full-screen"), 0);
      assert.equal(win.listenerCount("closed"), 0);
      assert.equal(flushNextTimer(), false);
      assert.equal(win.hideCalls, 0);
    });
  });
});

test("closing the window clears a pending hotkey hide", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const win = new FakeWindow({ fullscreen: true });
      const { toggleWindow } = setupHotkeyBridge({ win });

      toggleWindow();
      assert.equal(getPendingTimerCount(), 1);
      assert.equal(win.listenerCount("leave-full-screen"), 1);
      assert.equal(win.listenerCount("closed"), 1);

      win.destroyed = true;
      win.emit("closed");

      assert.equal(getPendingTimerCount(), 0);
      assert.equal(win.listenerCount("leave-full-screen"), 0);
      assert.equal(win.listenerCount("closed"), 0);
      assert.equal(flushNextTimer(), false);
      assert.equal(win.hideCalls, 0);
    });
  });
});

// ---- macOS Dock menu ------------------------------------------------------

test("mac dock menu lists saved hosts and forwards connect actions", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];
    const win = new FakeWindow();
    win.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [win];

    bridge.init({
      electronModule,
      getMainWindow: () => win,
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      hosts: [
        { id: "plain", label: "Plain Host", hostname: "plain.example" },
        { id: "pinned", label: "Pinned Host", hostname: "pinned.example", pinned: true },
        { id: "recent", label: "Recent Host", hostname: "recent.example", lastConnectedAt: 20 },
      ],
    });

    const dockTemplate = electronModule.app.dock.menu?.template ?? [];
    const connectionMenu = dockTemplate.find((item) => item.label === "New Connection");

    assert.ok(connectionMenu, "dock menu should expose a new connection submenu");
    assert.deepEqual(
      connectionMenu.submenu.map((item) => item.label),
      ["Pinned Host", "Recent Host", "Plain Host"],
    );

    await connectionMenu.submenu[0].click();

    assert.deepEqual(sentMessages, [["netcatty:trayPanel:connectToHost", "pinned"]]);
  });
});

test("mac dock host click creates a main window when none exists", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];
    const createdWin = new FakeWindow();
    createdWin.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [];
    let createCalls = 0;

    bridge.init({
      electronModule,
      ensureMainWindow: async () => {
        createCalls += 1;
        return createdWin;
      },
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      hosts: [
        { id: "target", label: "Target Host", hostname: "target.example" },
      ],
    });

    const dockTemplate = electronModule.app.dock.menu?.template ?? [];
    const connectionMenu = dockTemplate.find((item) => item.label === "New Connection");

    await connectionMenu.submenu[0].click();

    assert.equal(createCalls, 1);
    assert.deepEqual(sentMessages, [["netcatty:trayPanel:connectToHost", "target"]]);
  });
});

test("mac dock host click waits for a newly created main window to be ready", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];
    const createdWin = new FakeWindow();
    createdWin.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [];
    let releaseReady;

    bridge.init({
      electronModule,
      ensureMainWindow: async () => createdWin,
      sendWhenRendererReady: async (win, channel, payload) => {
        assert.equal(win, createdWin);
        await new Promise((resolve) => {
          releaseReady = resolve;
        });
        win.webContents.send(channel, payload);
        return { success: true };
      },
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      hosts: [
        { id: "target", label: "Target Host", hostname: "target.example" },
      ],
    });

    const dockTemplate = electronModule.app.dock.menu?.template ?? [];
    const connectionMenu = dockTemplate.find((item) => item.label === "New Connection");
    const clickPromise = connectionMenu.submenu[0].click();

    for (let i = 0; i < 5 && !releaseReady; i += 1) {
      await Promise.resolve();
    }
    assert.deepEqual(sentMessages, []);

    releaseReady();
    await clickPromise;

    assert.deepEqual(sentMessages, [["netcatty:trayPanel:connectToHost", "target"]]);
  });
});

test("mac dock host click waits for a tracked main window to be ready", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];
    const win = new FakeWindow();
    win.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [win];
    let releaseReady;
    let createCalls = 0;

    bridge.init({
      electronModule,
      getMainWindow: () => win,
      ensureMainWindow: async () => {
        createCalls += 1;
        return win;
      },
      sendWhenRendererReady: async (target, channel, payload) => {
        assert.equal(target, win);
        await new Promise((resolve) => {
          releaseReady = resolve;
        });
        target.webContents.send(channel, payload);
        return { success: true };
      },
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      hosts: [
        { id: "target", label: "Target Host", hostname: "target.example" },
      ],
    });

    const dockTemplate = electronModule.app.dock.menu?.template ?? [];
    const connectionMenu = dockTemplate.find((item) => item.label === "New Connection");
    const clickPromise = connectionMenu.submenu[0].click();

    for (let i = 0; i < 5 && !releaseReady; i += 1) {
      await Promise.resolve();
    }
    assert.equal(createCalls, 0);
    assert.deepEqual(sentMessages, []);

    releaseReady();
    await clickPromise;

    assert.deepEqual(sentMessages, [["netcatty:trayPanel:connectToHost", "target"]]);
  });
});

test("mac dock open main window creates a main window when none exists", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const createdWin = new FakeWindow();
    electronModule.BrowserWindow.getAllWindows = () => [];
    let createCalls = 0;

    bridge.init({
      electronModule,
      ensureMainWindow: async () => {
        createCalls += 1;
        return createdWin;
      },
    });

    const dockTemplate = electronModule.app.dock.menu?.template ?? [];
    const openMainItem = dockTemplate.find((item) => item.label === "Open Main Window");

    await openMainItem.click();

    assert.equal(createCalls, 1);
    assert.equal(createdWin.showCalls, 1);
  });
});

// ---- openMainWindow (external MCP / CLI host-open) -------------------------

test("openMainWindow delegates to showAndFocusMainWindow on win32", async () => {
  await withPlatform("win32", async () => {
    const windowManagerPath = require.resolve("./windowManager.cjs");
    const actualWindowManager = require(windowManagerPath);
    const showCalls = [];

    require.cache[windowManagerPath].exports = {
      ...actualWindowManager,
      showAndFocusMainWindow(win) {
        showCalls.push(win);
        return true;
      },
    };

    try {
      const bridge = loadBridge();
      const electronModule = createElectronStub();
      const win = new FakeWindow();
      win.visible = false;
      electronModule.BrowserWindow.getAllWindows = () => [win];
      bridge.init({ electronModule, getMainWindow: () => win });
      const ipcMain = createIpcMainStub();
      bridge.registerHandlers(ipcMain);

      await ipcMain.handlers.get("netcatty:trayPanel:openMainWindow")();

      assert.equal(showCalls.length, 1);
      assert.equal(showCalls[0], win);
      assert.equal(win.showCalls, 0);
      assert.equal(win.focusCalls, 0);
    } finally {
      require.cache[windowManagerPath].exports = actualWindowManager;
    }
  });
});
