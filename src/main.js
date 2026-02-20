const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const { runBackup } = require('./services/backupService');
const { loadConfig, saveConfig, normalizeConfig } = require('./utils/configStore');

const LOG_ROOT = path.join(os.homedir(), '.backup-disco', 'logs');
const APP_ICON_PATH = path.join(__dirname, 'img', 'icona.ico');

let mainWindow;
let currentState = normalizeConfig(null);
let tray = null;
let isQuitting = false;

const scheduleTimers = new Map();
let runningBackup = false;
let activeBackupControl = null;
let autoUpdateInitialized = false;

function emitBackupEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backup:event', {
      timestamp: new Date().toISOString(),
      ...payload
    });
  }
}

function emitUpdateInfo(message, extra = {}) {
  emitBackupEvent({
    eventType: 'update-status',
    level: 'info',
    message,
    ...extra
  });
}

function setupAutoUpdater() {
  if (autoUpdateInitialized) {
    return;
  }
  autoUpdateInitialized = true;

  const feedUrl = process.env.UPDATE_FEED_URL;
  if (feedUrl) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    emitUpdateInfo('Controllo aggiornamenti in corso...');
  });

  autoUpdater.on('update-available', (info) => {
    emitUpdateInfo(`Aggiornamento disponibile: ${info?.version || 'nuova versione'}. Download in corso...`);
  });

  autoUpdater.on('update-not-available', () => {
    emitUpdateInfo('Nessun aggiornamento disponibile.');
  });

  autoUpdater.on('error', (error) => {
    emitBackupEvent({
      eventType: 'update-status',
      level: 'warn',
      message: `Errore aggiornamento automatico: ${error.message}`
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    emitBackupEvent({
      eventType: 'update-progress',
      level: 'info',
      message: `Download aggiornamento: ${Math.round(progress.percent || 0)}%`,
      percent: progress.percent || 0
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    emitUpdateInfo(
      `Aggiornamento scaricato (${info?.version || 'nuova versione'}). Verra installato alla chiusura dell'app.`
    );
  });
}

function sourceKey(sourceDir) {
  const normalized = path.resolve(sourceDir).toLowerCase();
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10);
  const base = path.basename(sourceDir).replace(/[^a-zA-Z0-9._-]/g, '_') || 'source';
  return `${base}-${hash}`;
}

async function removeConfigTraces(config) {
  for (const dir of config?.sourceDirs || []) {
    const key = sourceKey(dir);
    const logDir = path.join(LOG_ROOT, key);
    await fs.rm(logDir, { recursive: true, force: true });
  }
}

function makeCancelledError() {
  const error = new Error('Attivita interrotta');
  error.code = 'BACKUP_CANCELLED';
  return error;
}

function assertNotCancelled(control) {
  if (control?.cancelled) {
    throw makeCancelledError();
  }
}

function getActiveConfig() {
  return currentState.configurations.find((cfg) => cfg.id === currentState.activeConfigurationId) || currentState.configurations[0];
}

function getConfigById(configId) {
  return currentState.configurations.find((cfg) => cfg.id === configId) || null;
}

async function setLastRunForConfig(configId, status) {
  const cfg = currentState.configurations.find((item) => item.id === configId);
  if (!cfg) {
    return;
  }

  cfg.lastRunAt = new Date().toISOString();
  cfg.lastRunStatus = status;
  currentState = await saveConfig(currentState);

  emitBackupEvent({
    eventType: 'config-last-run',
    configId,
    lastRunAt: cfg.lastRunAt,
    lastRunStatus: status
  });
}

function parseDailyTime(value) {
  const [h, m] = String(value || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) {
    return { hour: 22, minute: 0 };
  }
  return { hour: h, minute: m };
}

function getDelayToNextDailyRun(time) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(time.hour, time.minute, 0, 0);

  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}

function requestBackupStop() {
  if (!runningBackup || !activeBackupControl) {
    emitBackupEvent({ level: 'info', message: 'Nessun backup in esecuzione da fermare.' });
    return { stopped: false, reason: 'not-running' };
  }

  activeBackupControl.cancelled = true;
  emitBackupEvent({ level: 'warn', message: 'Richiesta di stop backup inviata.' });
  return { stopped: true, reason: 'requested' };
}

async function runConfiguration(config, control) {
  assertNotCancelled(control);

  if (!config?.sourceDirs?.length || !config?.targetDir) {
    emitBackupEvent({ level: 'warn', message: `Configurazione "${config?.name || 'Sconosciuta'}" incompleta, salto esecuzione.` });
    if (config?.id) {
      await setLastRunForConfig(config.id, 'skipped');
    }
    return { skipped: true };
  }

  emitBackupEvent({ level: 'info', message: `Avvio backup: ${config.name}` });
  try {
    await runBackup({
      sourceDirs: config.sourceDirs,
      targetDir: config.targetDir,
      onEvent: emitBackupEvent,
      shouldCancel: () => control.cancelled
    });
    await setLastRunForConfig(config.id, 'success');
    emitBackupEvent({ level: 'info', message: `Backup configurazione completato: ${config.name}` });
    return { skipped: false };
  } catch (error) {
    if (error.code === 'BACKUP_CANCELLED') {
      await setLastRunForConfig(config.id, 'cancelled');
    } else {
      await setLastRunForConfig(config.id, 'failed');
    }
    throw error;
  }
}

async function runBackupGuarded() {
  const active = getActiveConfig();
  if (!active) {
    emitBackupEvent({ level: 'error', message: 'Nessuna configurazione disponibile.' });
    return;
  }

  await runConfigurationGuardedById(active.id, 'manuale');
}

async function runConfigurationGuardedById(configId, origin = 'manuale') {
  if (runningBackup) {
    const cfg = getConfigById(configId);
    const name = cfg?.name || 'configurazione sconosciuta';
    emitBackupEvent({ level: 'warn', message: `Backup gia in esecuzione, richiesta ${origin} ignorata per "${name}".` });
    return;
  }

  const config = getConfigById(configId);
  if (!config) {
    emitBackupEvent({ level: 'warn', message: `Configurazione non trovata: ${configId}` });
    return;
  }

  runningBackup = true;
  const control = { cancelled: false, mode: 'single', configId: config.id };
  activeBackupControl = control;

  try {
    await runConfiguration(config, control);
  } catch (error) {
    if (error.code === 'BACKUP_CANCELLED') {
      emitBackupEvent({ level: 'warn', message: 'Backup interrotto su richiesta utente.' });
    } else {
      emitBackupEvent({ level: 'error', message: `Errore backup: ${error.message}` });
    }
  } finally {
    if (activeBackupControl === control) {
      activeBackupControl = null;
    }
    runningBackup = false;
  }
}

async function runAllBackupsGuarded() {
  if (runningBackup) {
    emitBackupEvent({ level: 'warn', message: 'Backup gia in esecuzione, richiesta ignorata.' });
    return;
  }

  const configs = currentState.configurations || [];
  if (!configs.length) {
    emitBackupEvent({ level: 'error', message: 'Nessuna configurazione disponibile.' });
    return;
  }

  runningBackup = true;
  const control = { cancelled: false, mode: 'all', configId: null };
  activeBackupControl = control;

  let completed = 0;
  let failed = 0;
  let skipped = 0;

  emitBackupEvent({ level: 'info', message: `Avvio esecuzione completa: ${configs.length} configurazioni` });

  try {
    for (const cfg of configs) {
      control.configId = cfg.id;
      assertNotCancelled(control);
      try {
        const result = await runConfiguration(cfg, control);
        if (result.skipped) {
          skipped += 1;
        } else {
          completed += 1;
        }
      } catch (error) {
        if (error.code === 'BACKUP_CANCELLED') {
          throw error;
        }
        failed += 1;
        emitBackupEvent({ level: 'error', message: `Errore configurazione "${cfg.name}": ${error.message}` });
      }
    }

    emitBackupEvent({ level: 'info', message: `Esecuzione completa terminata. Completate: ${completed}, Saltate: ${skipped}, Fallite: ${failed}` });
  } catch (error) {
    if (error.code === 'BACKUP_CANCELLED') {
      emitBackupEvent({ level: 'warn', message: `Esecuzione completa interrotta. Completate: ${completed}, Saltate: ${skipped}, Fallite: ${failed}` });
    } else {
      emitBackupEvent({ level: 'error', message: `Errore esecuzione completa: ${error.message}` });
    }
  } finally {
    if (activeBackupControl === control) {
      activeBackupControl = null;
    }
    runningBackup = false;
  }
}

function clearSchedule() {
  for (const [configId, timer] of scheduleTimers.entries()) {
    if (timer.type === 'daily') {
      clearTimeout(timer.handle);
    } else {
      clearInterval(timer.handle);
    }
    scheduleTimers.delete(configId);
  }
}

function clearScheduleForConfig(configId) {
  const timer = scheduleTimers.get(configId);
  if (!timer) {
    return;
  }
  if (timer.type === 'daily') {
    clearTimeout(timer.handle);
  } else {
    clearInterval(timer.handle);
  }
  scheduleTimers.delete(configId);
}

function scheduleConfig(config) {
  if (!config?.id) {
    return;
  }
  clearScheduleForConfig(config.id);

  const schedule = config.schedule || {};
  if (schedule.type === 'daily') {
    const time = parseDailyTime(schedule.dailyTime);
    const delay = getDelayToNextDailyRun(time);
    const handle = setTimeout(async () => {
      await runConfigurationGuardedById(config.id, 'schedulata');
      const updatedConfig = getConfigById(config.id);
      if (updatedConfig) {
        scheduleConfig(updatedConfig);
      }
    }, delay);
    scheduleTimers.set(config.id, { type: 'daily', handle });
    emitBackupEvent({ level: 'info', message: `Schedulazione giornaliera attiva per "${config.name}" alle ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}` });
    return;
  }

  const intervalMinutes = Math.max(1, Number(schedule.intervalMinutes || 60));
  const delay = intervalMinutes * 60 * 1000;

  const handle = setInterval(async () => {
    await runConfigurationGuardedById(config.id, 'schedulata');
  }, delay);
  scheduleTimers.set(config.id, { type: 'interval', handle });

  emitBackupEvent({ level: 'info', message: `Schedulazione a intervallo attiva per "${config.name}": ogni ${intervalMinutes} minuti` });
}

function scheduleAllConfigurations() {
  clearSchedule();
  for (const config of currentState.configurations || []) {
    scheduleConfig(config);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  if (tray) {
    return;
  }

  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip('Backup Disco');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Apri Backup Disco',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createWindow();
        }
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: 'Esci',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    }
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  currentState = await loadConfig();
  createWindow();
  createTray();
  scheduleAllConfigurations();
  setupAutoUpdater();

  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((error) => {
        emitBackupEvent({
          eventType: 'update-status',
          level: 'warn',
          message: `Check aggiornamenti fallito: ${error.message}`
        });
      });
    }, 15000);

    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 6 * 60 * 60 * 1000);
  } else {
    emitUpdateInfo('Auto-update attivo solo in app pacchettizzata.');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

ipcMain.handle('config:load', async () => {
  currentState = await loadConfig();
  return currentState;
});

ipcMain.handle('config:save', async (_, state) => {
  currentState = await saveConfig(state);
  scheduleAllConfigurations();
  return currentState;
});

ipcMain.handle('config:delete', async (_, configId) => {
  const toDelete = currentState.configurations.find((cfg) => cfg.id === configId);
  if (!toDelete) {
    return currentState;
  }

  const isActive = currentState.activeConfigurationId === configId;
  clearScheduleForConfig(configId);
  emitBackupEvent({ level: 'info', message: `Schedulazione rimossa per configurazione eliminata: ${toDelete.name}` });

  if (runningBackup && activeBackupControl && (activeBackupControl.mode === 'all' || activeBackupControl.configId === configId)) {
    activeBackupControl.cancelled = true;
    emitBackupEvent({ level: 'warn', message: `Backup interrotto per eliminazione configurazione: ${toDelete.name}` });
  }

  currentState.configurations = currentState.configurations.filter((cfg) => cfg.id !== configId);
  if (isActive || !currentState.configurations.some((cfg) => cfg.id === currentState.activeConfigurationId)) {
    currentState.activeConfigurationId = currentState.configurations[0]?.id || null;
  }

  await removeConfigTraces(toDelete);
  currentState = await saveConfig(currentState);
  emitBackupEvent({ level: 'info', message: `Configurazione eliminata con tracce locali rimosse: ${toDelete.name}` });

  return currentState;
});

ipcMain.handle('dialog:pickDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });

  if (result.canceled || !result.filePaths?.length) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('backup:runNow', async () => {
  await runBackupGuarded();
  return currentState;
});

ipcMain.handle('backup:runAll', async () => {
  await runAllBackupsGuarded();
  return currentState;
});

ipcMain.handle('backup:stop', async () => {
  return requestBackupStop();
});

ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) {
    return { ok: false, reason: 'not-packaged' };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
});

ipcMain.handle('update:installNow', async () => {
  if (!app.isPackaged) {
    return { ok: false, reason: 'not-packaged' };
  }
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
});

ipcMain.handle('schedule:start', async (_, state) => {
  currentState = await saveConfig(state);
  scheduleAllConfigurations();
  return currentState;
});

ipcMain.handle('schedule:stop', async () => {
  clearSchedule();
  emitBackupEvent({ level: 'info', message: 'Schedulazione fermata.' });
  return { ok: true };
});

ipcMain.handle('activity:stopAll', async () => {
  clearSchedule();
  requestBackupStop();
  emitBackupEvent({ level: 'warn', message: 'Stop attivita richiesto (backup + schedulazione).' });
  return { ok: true };
});
