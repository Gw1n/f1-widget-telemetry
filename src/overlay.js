const { BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');

const ASPECT = 0.92; // overlay height / width (the info card needs room under the map)
const LOCK_SHORTCUT = 'CommandOrControl+Alt+L';
const DEFAULTS = { width: 480, opacity: 0.95, background: true, locked: false, bounds: null, locale: 'en' };

/**
 * The overlay is a second, transparent, always-on-top window that shows the
 * track map. The main window owns playback and streams frames to it through
 * this process.
 */
function setupOverlay({ getMainWindow, settings }) {
  let win = null;
  let lastSession = null; // replayed to the overlay when it opens after the session loaded
  let saveTimer = null;

  const cfg = () => ({ ...DEFAULTS, ...settings.get('overlay') });
  const status = () => ({ open: win !== null, ...cfg() });
  const notify = () => getMainWindow()?.webContents.send('overlay:status', status());

  function defaultBounds(width) {
    const { workArea } = screen.getPrimaryDisplay();
    const height = Math.round(width * ASPECT);
    return { width, height, x: workArea.x + workArea.width - width - 24, y: workArea.y + 24 };
  }

  /** Keep a saved position only if it is still on some display (monitors get unplugged). */
  function usableBounds(c) {
    const b = c.bounds;
    if (!b) return defaultBounds(c.width);
    const visible = screen.getAllDisplays().some(({ workArea: a }) => (
      b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
    ));
    return visible ? b : defaultBounds(c.width);
  }

  function saveBounds() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win) return;
      const bounds = win.getBounds();
      settings.set('overlay', { ...cfg(), bounds, width: bounds.width });
      notify();
    }, 300);
  }

  function applyLock() {
    if (!win) return;
    win.setIgnoreMouseEvents(cfg().locked, { forward: true });
    win.webContents.send('overlay:settings', cfg());
  }

  function open() {
    const c = cfg();
    win = new BrowserWindow({
      ...usableBounds(c),
      show: false,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload-overlay.js'),
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    // 'screen-saver' level keeps it above full-screen apps and videos
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setOpacity(c.opacity);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

    win.webContents.once('did-finish-load', () => {
      if (lastSession) win.webContents.send('overlay:session', lastSession);
      applyLock();
      win.showInactive();
    });
    win.on('move', saveBounds);
    win.on('resize', saveBounds);
    win.on('closed', () => {
      clearTimeout(saveTimer);
      win = null;
      notify();
    });
    notify();
  }

  function configure(patch = {}) {
    const next = { ...cfg() };
    for (const key of ['locked', 'opacity', 'width', 'background', 'locale']) {
      if (key in patch) next[key] = patch[key];
    }
    settings.set('overlay', next);

    if (win) {
      if ('opacity' in patch) win.setOpacity(next.opacity);
      if ('width' in patch) {
        const { x, y } = win.getBounds();
        win.setBounds({ x, y, width: next.width, height: Math.round(next.width * ASPECT) });
      }
      if ('locked' in patch || 'background' in patch || 'locale' in patch) applyLock();
    }
    notify();
    return status();
  }

  ipcMain.handle('overlay:toggle', () => {
    if (win) win.close(); else open();
  });
  ipcMain.handle('overlay:configure', (_e, patch) => configure(patch));
  ipcMain.on('overlay:session', (_e, session) => {
    lastSession = session;
    win?.webContents.send('overlay:session', session);
  });
  ipcMain.on('overlay:frame', (_e, frame) => win?.webContents.send('overlay:frame', frame));

  // the overlay is click-through when locked, so it needs a keyboard way back
  globalShortcut.register(LOCK_SHORTCUT, () => {
    if (win) configure({ locked: !cfg().locked });
  });

  return {
    close: () => win?.close(),
    dispose: () => globalShortcut.unregister(LOCK_SHORTCUT),
  };
}

module.exports = { setupOverlay, LOCK_SHORTCUT };
