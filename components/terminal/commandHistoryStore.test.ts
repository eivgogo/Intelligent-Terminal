import assert from "node:assert/strict";
import test from "node:test";

type LocalStorageMock = {
  clear(): void;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type StorageListener = (event: StorageEvent) => void;

const STORAGE_KEY = "netcatty:commandHistory";

function installLocalStorage(): LocalStorageMock {
  const store = new Map<string, string>();
  const localStorage: LocalStorageMock = {
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorage,
    configurable: true,
  });
  return localStorage;
}

const storageListeners = new Set<StorageListener>();

Object.defineProperty(globalThis, "window", {
  value: {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type !== "storage") return;
      storageListeners.add(listener as StorageListener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type !== "storage") return;
      storageListeners.delete(listener as StorageListener);
    },
  },
  configurable: true,
});

const localStorage = installLocalStorage();

const {
  clearHistory,
  flushCommandHistoryStore,
  queryHistory,
  recordCommand,
  removeCommandHistoryEntry,
} = await import("./autocomplete/commandHistoryStore.ts");

function emitStorageEvent(key: string, newValue: string | null): void {
  const event = {
    key,
    newValue,
    storageArea: localStorage,
  } as StorageEvent;
  for (const listener of storageListeners) {
    listener(event);
  }
}

/** Simulate another window rewriting command history in localStorage. */
function writeExternalHistory(entries: Array<{
  command: string;
  hostId: string;
  os?: "linux" | "windows" | "macos";
  frequency?: number;
  lastUsedAt?: number;
  createdAt?: number;
}>): void {
  const now = Date.now();
  const payload = {
    version: 1,
    entries: entries.map((entry) => ({
      command: entry.command,
      hostId: entry.hostId,
      os: entry.os ?? "linux",
      frequency: entry.frequency ?? 1,
      lastUsedAt: entry.lastUsedAt ?? now,
      createdAt: entry.createdAt ?? now,
    })),
  };
  const serialized = JSON.stringify(payload);
  localStorage.setItem(STORAGE_KEY, serialized);
  emitStorageEvent(STORAGE_KEY, serialized);
}

test.beforeEach(() => {
  localStorage.clear();
  clearHistory();
  flushCommandHistoryStore();
});

test("cross-window storage changes invalidate stale autocomplete history cache", () => {
  recordCommand("legacy-command", "host-1");
  flushCommandHistoryStore();

  assert.equal(
    queryHistory("legacy", { hostId: "host-1" }).some((entry) => entry.command === "legacy-command"),
    true,
  );

  // Another window deleted the entry and persisted the empty store.
  writeExternalHistory([]);

  assert.equal(
    queryHistory("legacy", { hostId: "host-1" }).some((entry) => entry.command === "legacy-command"),
    false,
  );
});

test("pending debounced saves do not resurrect entries deleted in another window", async () => {
  recordCommand("do-not-resurrect", "host-1");
  flushCommandHistoryStore();

  // Schedule a debounced save that still holds the deleted entry in memory.
  recordCommand("keep-me", "host-1");

  writeExternalHistory([
    {
      command: "keep-me",
      hostId: "host-1",
    },
  ]);

  await new Promise((resolve) => setTimeout(resolve, 600));

  const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as {
    entries?: Array<{ command: string }>;
  };
  assert.equal(
    (persisted.entries ?? []).some((entry) => entry.command === "do-not-resurrect"),
    false,
  );
  assert.equal(
    queryHistory("do-not", { hostId: "host-1" }).some((entry) => entry.command === "do-not-resurrect"),
    false,
  );
});

test("removeCommandHistoryEntry still deletes the local autocomplete entry", () => {
  recordCommand("bad-command --flag", "host-1");
  recordCommand("bad-command --flag", "host-2");

  assert.equal(removeCommandHistoryEntry("bad-command --flag", "host-1"), true);

  assert.equal(
    queryHistory("bad-command", { hostId: "host-1" }).some(
      (entry) => entry.command === "bad-command --flag",
    ),
    false,
  );
  assert.equal(
    queryHistory("bad-command", { hostId: "host-2" }).some(
      (entry) => entry.command === "bad-command --flag",
    ),
    true,
  );
});
