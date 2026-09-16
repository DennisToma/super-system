import { app, BrowserWindow, dialog, Menu, session, shell, type MenuItemConstructorOptions } from 'electron';
import { fileURLToPath } from 'node:url';
import { externalWebUrl, isWorkspaceNavigation, parseAppUrl, rendererPreferences } from './security.js';

app.setName('Super System');
app.enableSandbox();

// Local development shares the root configuration. Packaged applications never
// search arbitrary working directories for credentials or executable settings.
if (!app.isPackaged) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Could not read the local workspace configuration.');
    }
  }
}

const configuredUrl = process.argv.find((argument) => argument.startsWith('--server-url='))?.slice('--server-url='.length)
  ?? process.env.SUPER_SYSTEM_URL
  ?? 'http://127.0.0.1:5173';

let workspace: URL;
try {
  workspace = parseAppUrl(configuredUrl);
} catch (error) {
  dialog.showErrorBox('Invalid workspace URL', `${(error as Error).message}\n\nSet SUPER_SYSTEM_URL or use --server-url=https://your-workspace.example.com.`);
  app.exit(1);
  throw error;
}

let mainWindow: BrowserWindow | null = null;
let showingConnectionError = false;

async function openWebLink(value: string): Promise<void> {
  const url = externalWebUrl(value);
  if (!url) return;
  try {
    await shell.openExternal(url, { activate: true });
  } catch {
    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error', title: 'Could not open link',
        message: 'Your default browser could not open this web link.',
      });
    }
  }
}

async function loadWorkspace(): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  try {
    await window.loadURL(workspace.href);
  } catch {
    if (showingConnectionError || window.isDestroyed()) return;
    showingConnectionError = true;
    window.show();
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Workspace unavailable',
      message: 'Super System could not reach your workspace.',
      detail: `Check that the application API is running and that your network can reach ${workspace.origin}.\n\nFor local development, run “pnpm dev” first. To connect to your hosted application, set SUPER_SYSTEM_URL. Your agent continues running independently on its server.`,
      buttons: ['Retry', 'Close window'], defaultId: 0, cancelId: 1,
      noLink: true,
    });
    showingConnectionError = false;
    if (window.isDestroyed()) return;
    if (result.response === 0) void loadWorkspace();
    else window.close();
  }
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 390, minHeight: 560,
    title: 'Super System', backgroundColor: '#f6f5f1',
    show: false,
    webPreferences: { ...rendererPreferences, partition: 'persist:super-system', spellcheck: true },
  });
  mainWindow = window;
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });

  // The renderer has no preload or IPC API. Every native operation lives here.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWorkspaceNavigation(url, workspace)) {
      void window.loadURL(url).catch(() => undefined);
    } else {
      void openWebLink(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => {
    if (!isWorkspaceNavigation(event.url, workspace)) {
      event.preventDefault();
      void openWebLink(event.url);
    }
  });
  window.webContents.on('will-frame-navigate', (event) => {
    if (!isWorkspaceNavigation(event.url, workspace)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event) => {
    if (!isWorkspaceNavigation(event.url, workspace)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', () => {
    if (!window.isDestroyed()) void loadWorkspace();
  });
  void loadWorkspace();
}

function createMenu(): void {
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File', submenu: [
        { label: 'Open workspace', accelerator: 'CmdOrCtrl+Shift+N', click: createWindow },
        { label: 'Open in browser', click: () => { void openWebLink(workspace.href); } },
        { type: 'separator' },
        { role: mac ? 'close' : 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View', submenu: [
        { label: 'Reload workspace', accelerator: 'CmdOrCtrl+R', click: () => { void loadWorkspace(); } },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    createWindow();
  });
  void app.whenReady().then(() => {
    const workspaceSession = session.fromPartition('persist:super-system');
    workspaceSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    workspaceSession.setPermissionCheckHandler(() => false);
    workspaceSession.on('will-download', (event) => event.preventDefault());
    createMenu();
    createWindow();
    app.on('activate', createWindow);
  });
  app.on('window-all-closed', () => {
    // No provider sessions or child API process are owned by this application.
    if (process.platform !== 'darwin') app.quit();
  });
}
