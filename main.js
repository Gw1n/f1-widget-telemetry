const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const { OpenF1 } = require('./src/openf1');
const { Settings } = require('./src/settings');
const { setupOverlay } = require('./src/overlay');
const { LiveFeed } = require('./src/live');

// Playback is driven by timers in the main window; keep them running while
// the window is minimised or covered (the overlay may be the only thing visible).
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let mainWindow = null;

function createWindow(onClosed) {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 900,
    minWidth: 1180,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'F1 Telemetry',
    icon: path.join(__dirname, 'assets', 'icon.png'), // taskbar/window icon on Windows and Linux
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    onClosed();
  });
  return mainWindow;
}

app.whenReady().then(() => {
  const api = new OpenF1(path.join(app.getPath('userData'), 'cache'));
  const settings = new Settings(app.getPath('userData'), {});
  const overlay = setupOverlay({ getMainWindow: () => mainWindow, settings });

  // live data -------------------------------------------------------
  const live = new LiveFeed({
    api,
    send: (batch) => mainWindow?.webContents.send('live:rows', batch),
    onStatus: (status) => mainWindow?.webContents.send('live:status', status),
  });

  // the password is only ever stored encrypted with the OS keychain/DPAPI
  const saved = settings.get('openf1Account');
  if (saved && safeStorage.isEncryptionAvailable()) {
    try {
      api.setCredentials(saved.username, safeStorage.decryptString(Buffer.from(saved.password, 'base64')));
    } catch {
      settings.set('openf1Account', null);
    }
  }

  ipcMain.handle('live:account', () => ({ loggedIn: api.credentials !== null, username: api.username }));
  ipcMain.handle('live:login', async (_e, { username, password, remember }) => {
    try {
      await api.login(username, password);
    } catch (err) {
      return { ok: false, error: err.message, code: err.code, detail: err.detail };
    }
    const canStore = safeStorage.isEncryptionAvailable();
    settings.set('openf1Account', remember && canStore
      ? { username, password: safeStorage.encryptString(password).toString('base64') }
      : null);
    return { ok: true, remembered: Boolean(remember && canStore) };
  });
  ipcMain.handle('live:logout', () => {
    live.stop();
    api.logout();
    settings.set('openf1Account', null);
  });
  ipcMain.handle('live:start', (_e, opts) => live.start(opts));
  ipcMain.handle('live:stop', () => live.stop());
  app.on('will-quit', () => live.stop());

  ipcMain.handle('openf1:get', (_e, endpoint, params, opts) => api.get(endpoint, params, opts));
  ipcMain.handle('window:alwaysOnTop', (e, flag) => {
    BrowserWindow.fromWebContents(e.sender)?.setAlwaysOnTop(Boolean(flag), 'floating');
  });

  // closing the main window ends the session, so the overlay must not keep the app alive
  const open = () => createWindow(() => overlay.close());
  open();
  app.on('will-quit', () => overlay.dispose());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) open();
  });
});

app.on('window-all-closed', () => app.quit());
