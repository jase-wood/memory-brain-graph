const { app, BrowserWindow, Menu, shell, net, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────
function loadConfig() {
  // When packaged, config.json sits beside the exe via extraResources
  const candidates = [
    path.join(path.dirname(process.execPath), 'config.json'),
    path.join(__dirname, 'config.json'),
  ];
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return {
    hosts: ['localhost'],
    port: 8080,
    dataPort: 3000,
    probePath: '/graph',
    windowTitle: 'Memory Brain',
    probeTimeoutMs: 3000,
  };
}

// ── Single-instance lock ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

app.setAppUserModelId('com.memorybrain.graphviewer');

// ── Host probe ──────────────────────────────────────────────────────────────
// Probes the data endpoint (:dataPort/probePath) — if the data API is up,
// the page will render correctly.
function probeHost(host, cfg) {
  return new Promise((resolve) => {
    const url = `http://${host}:${cfg.dataPort}${cfg.probePath}`;
    const req = net.request(url);
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { req.abort(); } catch {}
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), cfg.probeTimeoutMs);

    req.on('response', (res) => {
      clearTimeout(timer);
      finish(res.statusCode < 500);
    });
    req.on('error', () => { clearTimeout(timer); finish(false); });
    req.end();
  });
}

async function findReachableHost(cfg) {
  for (const host of cfg.hosts) {
    if (await probeHost(host, cfg)) return host;
  }
  return null;
}

// ── Window helpers ──────────────────────────────────────────────────────────
let mainWindow = null;

function buildMenu(win, cfg, host) {
  const template = [
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => restartApp(win, cfg),
        },
        {
          label: 'Toggle Fullscreen',
          accelerator: 'F11',
          click: () => win.setFullScreen(!win.isFullScreen()),
        },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open in Browser',
          enabled: !!host,
          click: () => {
            if (host) shell.openExternal(`http://${host}:${cfg.port}/graph.html`);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function loadErrorPage(win) {
  const errPath = app.isPackaged
    ? path.join(path.dirname(process.execPath), 'error.html')
    : path.join(__dirname, 'error.html');

  const fallback = path.join(__dirname, 'error.html');
  win.loadFile(fs.existsSync(errPath) ? errPath : fallback);
}

async function restartApp(win, cfg) {
  const host = await findReachableHost(cfg);
  buildMenu(win, cfg, host);
  if (host) {
    win.loadURL(`http://${host}:${cfg.port}/graph.html`);
  } else {
    loadErrorPage(win);
  }
}

// ── App lifecycle ───────────────────────────────────────────────────────────
async function createWindow() {
  const cfg = loadConfig();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: cfg.windowTitle || 'Memory Brain',
    backgroundColor: '#04030e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // F11 fullscreen via before-input-event (works even when menu is hidden)
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F11' && input.type === 'keyDown') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  const host = await findReachableHost(cfg);
  buildMenu(mainWindow, cfg, host);

  if (host) {
    mainWindow.loadURL(`http://${host}:${cfg.port}/graph.html`);
  } else {
    loadErrorPage(mainWindow);
  }

  mainWindow.webContents.on('did-fail-load', (_e, code) => {
    if (code === -3) return; // user-triggered abort
    console.warn(`Page load failed (code ${code}) — showing offline page`);
    loadErrorPage(mainWindow);
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Retry button in error.html re-probes via IPC
  ipcMain.on('retry-connection', () => {
    if (mainWindow) restartApp(mainWindow, cfg);
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
