const configSelect = document.getElementById('configSelect');
const newConfigBtn = document.getElementById('newConfig');
const deleteConfigBtn = document.getElementById('deleteConfig');
const configNameInput = document.getElementById('configName');
const themeToggleBtn = document.getElementById('themeToggle');
const runAllConfigsBtn = document.getElementById('runAllConfigs');
const configSummaryList = document.getElementById('configSummaryList');

const sourceList = document.getElementById('sourceList');
const addSourceBtn = document.getElementById('addSource');
const targetDirInput = document.getElementById('targetDir');
const pickTargetBtn = document.getElementById('pickTarget');

const scheduleType = document.getElementById('scheduleType');
const intervalRow = document.getElementById('intervalRow');
const dailyRow = document.getElementById('dailyRow');
const intervalMinutes = document.getElementById('intervalMinutes');
const dailyTime = document.getElementById('dailyTime');

const saveConfigBtn = document.getElementById('saveConfig');
const runNowBtn = document.getElementById('runNow');
const startScheduleBtn = document.getElementById('startSchedule');
const checkUpdatesBtn = document.getElementById('checkUpdates');
const installUpdateNowBtn = document.getElementById('installUpdateNow');
const stopBackupBtn = document.getElementById('stopBackup');
const stopScheduleBtn = document.getElementById('stopSchedule');
const stopAllBtn = document.getElementById('stopAll');
const log = document.getElementById('log');

let state = {
  configurations: [],
  activeConfigurationId: null
};
const sourceProgressByDir = new Map();
const sourceProgressElements = new Map();

const THEME_STORAGE_KEY = 'backup-disco-theme';

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function getPreferredTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') {
    return saved;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggleBtn.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
}

function initTheme() {
  applyTheme(getPreferredTheme());
  themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  });
}

function appendLog(message, level = 'info', timestamp = new Date().toISOString()) {
  const time = new Date(timestamp).toLocaleString();
  log.textContent += `[${time}] [${level.toUpperCase()}] ${message}\n`;
  log.scrollTop = log.scrollHeight;
}

function getProgressState(sourceDir) {
  return sourceProgressByDir.get(sourceDir) || {
    processed: 0,
    total: 0,
    discovered: 0,
    phase: 'idle',
    status: 'idle',
    percent: 0
  };
}

function progressText(progress) {
  if (progress.status === 'idle') {
    return 'In attesa';
  }
  if (progress.status === 'scanning' && progress.phase === 'scan-discovery') {
    return `Scansione (${progress.discovered || 0} file trovati)`;
  }
  if (progress.status === 'scanning' && progress.phase === 'scan-indexing') {
    return `Indicizzazione ${progress.processed}/${progress.total || 0}`;
  }
  if (progress.status === 'running') {
    return `${progress.processed}/${progress.total || 0} (${progress.percent}%)`;
  }
  if (progress.status === 'cancelled') {
    return `Interrotto ${progress.processed}/${progress.total || 0}`;
  }
  if (progress.total === 0) {
    return progress.status === 'done' ? 'Completato (0 file)' : 'Preparazione...';
  }
  return `${progress.processed}/${progress.total} (${progress.percent}%)`;
}

function applyProgressToRow(sourceDir) {
  const elements = sourceProgressElements.get(sourceDir);
  if (!elements) {
    return;
  }
  const progress = getProgressState(sourceDir);
  if (progress.status === 'scanning' && progress.phase === 'scan-discovery') {
    elements.bar.max = 1;
    elements.bar.removeAttribute('value');
  } else {
    const max = progress.total > 0 ? progress.total : 1;
    const value = progress.total > 0 ? progress.processed : (progress.status === 'done' ? 1 : 0);
    elements.bar.max = max;
    elements.bar.value = value;
  }
  elements.label.textContent = progressText(progress);
}

function updateSourceProgress(event) {
  if (!event?.sourceDir) {
    return;
  }

  const processed = Number(event.processed || 0);
  const total = Number(event.total || 0);
  const percent = total > 0
    ? Math.min(100, Math.round((processed / total) * 100))
    : (event.status === 'done' ? 100 : 0);

  sourceProgressByDir.set(event.sourceDir, {
    processed,
    total,
    discovered: Number(event.discovered || 0),
    phase: event.phase || 'sync',
    status: event.status || 'running',
    percent
  });

  applyProgressToRow(event.sourceDir);
}

function resetProgressForAllConfigs() {
  const allDirs = new Set();
  for (const cfg of state.configurations || []) {
    for (const dir of cfg.sourceDirs || []) {
      allDirs.add(dir);
    }
  }
  for (const dir of allDirs) {
    sourceProgressByDir.set(dir, { processed: 0, total: 0, discovered: 0, phase: 'idle', status: 'idle', percent: 0 });
    applyProgressToRow(dir);
  }
}

function resetProgressForActiveConfig() {
  const active = getActiveConfig();
  if (!active) {
    return;
  }
  for (const dir of active.sourceDirs || []) {
    sourceProgressByDir.set(dir, { processed: 0, total: 0, discovered: 0, phase: 'idle', status: 'idle', percent: 0 });
    applyProgressToRow(dir);
  }
}

function getActiveConfig() {
  return state.configurations.find((cfg) => cfg.id === state.activeConfigurationId) || null;
}

function readScheduleFromUI() {
  return {
    type: scheduleType.value,
    intervalMinutes: Number(intervalMinutes.value || 60),
    dailyTime: dailyTime.value || '22:00'
  };
}

function setScheduleVisibility() {
  const isInterval = scheduleType.value === 'interval';
  intervalRow.classList.toggle('hidden', !isInterval);
  dailyRow.classList.toggle('hidden', isInterval);
}

function renderConfigOptions() {
  configSelect.innerHTML = '';
  for (const cfg of state.configurations) {
    const option = document.createElement('option');
    option.value = cfg.id;
    option.textContent = cfg.name;
    configSelect.appendChild(option);
  }
  if (state.activeConfigurationId) {
    configSelect.value = state.activeConfigurationId;
  }
}

function scheduleLabel(schedule) {
  if (!schedule || schedule.type === 'interval') {
    return `Ogni ${Number(schedule?.intervalMinutes || 60)} min`;
  }
  return `Ogni giorno ${schedule.dailyTime || '22:00'}`;
}

function runStatusLabel(status) {
  if (status === 'success') {
    return 'OK';
  }
  if (status === 'failed') {
    return 'Errore';
  }
  if (status === 'cancelled') {
    return 'Interrotto';
  }
  if (status === 'skipped') {
    return 'Saltato';
  }
  return 'N/D';
}

function formatLastRun(lastRunAt) {
  if (!lastRunAt) {
    return 'Mai eseguita';
  }
  const dt = new Date(lastRunAt);
  if (Number.isNaN(dt.getTime())) {
    return 'Data non valida';
  }
  return dt.toLocaleString();
}

function renderConfigurationsSummary() {
  configSummaryList.innerHTML = '';
  if (!state.configurations?.length) {
    const li = document.createElement('li');
    li.className = 'summary-item';
    li.textContent = 'Nessuna configurazione';
    configSummaryList.appendChild(li);
    return;
  }

  for (const cfg of state.configurations) {
    const li = document.createElement('li');
    li.className = 'summary-item';

    const name = document.createElement('div');
    name.className = 'summary-name';
    name.textContent = cfg.name || 'Configurazione';

    const meta1 = document.createElement('div');
    meta1.className = 'summary-meta';
    meta1.textContent = `Sorgenti: ${(cfg.sourceDirs || []).length}`;

    const meta2 = document.createElement('div');
    meta2.className = 'summary-meta';
    meta2.textContent = cfg.targetDir ? `Dest: ${cfg.targetDir}` : 'Destinazione non impostata';

    const meta3 = document.createElement('div');
    meta3.className = 'summary-meta';
    meta3.textContent = `Sched: ${scheduleLabel(cfg.schedule)}`;

    const meta4 = document.createElement('div');
    meta4.className = 'summary-meta';
    meta4.textContent = `Ultima esecuzione: ${formatLastRun(cfg.lastRunAt)} (${runStatusLabel(cfg.lastRunStatus)})`;

    li.appendChild(name);
    li.appendChild(meta1);
    li.appendChild(meta2);
    li.appendChild(meta3);
    li.appendChild(meta4);

    if (cfg.id === state.activeConfigurationId) {
      const badge = document.createElement('span');
      badge.className = 'summary-active';
      badge.textContent = 'Attiva';
      li.appendChild(badge);
    }

    configSummaryList.appendChild(li);
  }
}

function renderSourceList() {
  sourceList.innerHTML = '';
  sourceProgressElements.clear();
  const active = getActiveConfig();
  if (!active || !active.sourceDirs.length) {
    const li = document.createElement('li');
    li.className = 'source-item';
    li.textContent = 'Nessuna cartella sorgente selezionata';
    sourceList.appendChild(li);
    return;
  }

  active.sourceDirs.forEach((dir, index) => {
    const li = document.createElement('li');
    li.className = 'source-item';

    const content = document.createElement('div');
    content.className = 'source-item-main';

    const pathSpan = document.createElement('span');
    pathSpan.className = 'source-item-path';
    pathSpan.textContent = dir;

    const progressWrap = document.createElement('div');
    progressWrap.className = 'source-progress';

    const progressBar = document.createElement('progress');
    progressBar.className = 'source-progress-bar';
    progressBar.max = 1;
    progressBar.value = 0;

    const progressLabel = document.createElement('span');
    progressLabel.className = 'source-progress-label';

    progressWrap.appendChild(progressBar);
    progressWrap.appendChild(progressLabel);
    content.appendChild(pathSpan);
    content.appendChild(progressWrap);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Rimuovi';
    removeBtn.className = 'danger';
    removeBtn.addEventListener('click', () => {
      active.sourceDirs.splice(index, 1);
      renderSourceList();
      renderConfigurationsSummary();
    });

    li.appendChild(content);
    li.appendChild(removeBtn);
    sourceList.appendChild(li);

    sourceProgressElements.set(dir, { bar: progressBar, label: progressLabel });
    applyProgressToRow(dir);
  });
}

function applyActiveConfigToUI() {
  const active = getActiveConfig();
  if (!active) {
    configNameInput.value = '';
    targetDirInput.value = '';
    scheduleType.value = 'interval';
    intervalMinutes.value = 60;
    dailyTime.value = '22:00';
    renderSourceList();
    renderConfigurationsSummary();
    return;
  }

  configNameInput.value = active.name || '';
  targetDirInput.value = active.targetDir || '';
  scheduleType.value = active.schedule?.type || 'interval';
  intervalMinutes.value = active.schedule?.intervalMinutes || 60;
  dailyTime.value = active.schedule?.dailyTime || '22:00';

  setScheduleVisibility();
  renderSourceList();
  renderConfigurationsSummary();
}

function loadState(newState) {
  state = newState;
  if (!state.configurations?.length) {
    const id = makeId();
    state = {
      configurations: [{
        id,
        name: 'Configurazione 1',
        sourceDirs: [],
        targetDir: '',
        lastRunAt: null,
        lastRunStatus: null,
        schedule: { type: 'interval', intervalMinutes: 60, dailyTime: '22:00' }
      }],
      activeConfigurationId: id
    };
  }

  renderConfigOptions();
  applyActiveConfigToUI();
}

function syncActiveConfigFromUI() {
  const active = getActiveConfig();
  if (!active) {
    return;
  }

  active.name = configNameInput.value?.trim() || active.name;
  active.targetDir = targetDirInput.value || '';
  active.schedule = readScheduleFromUI();
}

async function persistState() {
  syncActiveConfigFromUI();
  state = await window.backupApi.saveConfig(state);
  renderConfigOptions();
  applyActiveConfigToUI();
  appendLog('Configurazione salvata');
}

newConfigBtn.addEventListener('click', () => {
  syncActiveConfigFromUI();
  const nextNumber = state.configurations.length + 1;
  const newConfig = {
    id: makeId(),
    name: `Configurazione ${nextNumber}`,
    sourceDirs: [],
    targetDir: '',
    lastRunAt: null,
    lastRunStatus: null,
    schedule: { type: 'interval', intervalMinutes: 60, dailyTime: '22:00' }
  };

  state.configurations.push(newConfig);
  state.activeConfigurationId = newConfig.id;
  renderConfigOptions();
  applyActiveConfigToUI();
  appendLog(`Nuova configurazione creata: ${newConfig.name}`);
});

deleteConfigBtn.addEventListener('click', () => {
  (async () => {
    if (state.configurations.length <= 1) {
      appendLog('Devi mantenere almeno una configurazione.', 'warn');
      return;
    }

    const active = getActiveConfig();
    if (!active) {
      return;
    }

    await persistState();
    state = await window.backupApi.deleteConfig(active.id);
    renderConfigOptions();
    applyActiveConfigToUI();
    appendLog(`Configurazione eliminata: ${active.name}`);
  })().catch((error) => {
    appendLog(`Errore eliminazione configurazione: ${error.message}`, 'error');
  });
});

configSelect.addEventListener('change', () => {
  syncActiveConfigFromUI();
  state.activeConfigurationId = configSelect.value;
  applyActiveConfigToUI();
});

configNameInput.addEventListener('input', () => {
  const active = getActiveConfig();
  if (!active) {
    return;
  }
  active.name = configNameInput.value || active.name;
  renderConfigOptions();
  renderConfigurationsSummary();
});

addSourceBtn.addEventListener('click', async () => {
  const dir = await window.backupApi.pickDirectory();
  if (!dir) {
    return;
  }

  const active = getActiveConfig();
  if (!active) {
    return;
  }

  if (!active.sourceDirs.includes(dir)) {
    active.sourceDirs.push(dir);
    appendLog(`Sorgente aggiunta: ${dir}`);
    renderSourceList();
    renderConfigurationsSummary();
  } else {
    appendLog(`La sorgente e gia presente: ${dir}`, 'warn');
  }
});

pickTargetBtn.addEventListener('click', async () => {
  const dir = await window.backupApi.pickDirectory();
  if (dir) {
    targetDirInput.value = dir;
    renderConfigurationsSummary();
    appendLog(`Destinazione impostata: ${dir}`);
  }
});

scheduleType.addEventListener('change', () => {
  setScheduleVisibility();
  renderConfigurationsSummary();
});

saveConfigBtn.addEventListener('click', async () => {
  try {
    await persistState();
  } catch (error) {
    appendLog(`Errore salvataggio: ${error.message}`, 'error');
  }
});

runNowBtn.addEventListener('click', async () => {
  try {
    await persistState();
    resetProgressForActiveConfig();
    state = await window.backupApi.runBackupNow();
    renderConfigOptions();
    applyActiveConfigToUI();
  } catch (error) {
    appendLog(`Errore avvio backup: ${error.message}`, 'error');
  }
});

runAllConfigsBtn.addEventListener('click', async () => {
  try {
    await persistState();
    resetProgressForAllConfigs();
    state = await window.backupApi.runAllBackups();
    renderConfigOptions();
    applyActiveConfigToUI();
  } catch (error) {
    appendLog(`Errore esecuzione completa: ${error.message}`, 'error');
  }
});

startScheduleBtn.addEventListener('click', async () => {
  try {
    syncActiveConfigFromUI();
    state = await window.backupApi.startSchedule(state);
    resetProgressForActiveConfig();
    appendLog('Schedulazione avviata');
  } catch (error) {
    appendLog(`Errore schedulazione: ${error.message}`, 'error');
  }
});

checkUpdatesBtn.addEventListener('click', async () => {
  try {
    const result = await window.backupApi.checkUpdates();
    if (!result.ok) {
      appendLog(`Check aggiornamenti non eseguito: ${result.reason}`, 'warn');
    }
  } catch (error) {
    appendLog(`Errore check aggiornamenti: ${error.message}`, 'error');
  }
});

installUpdateNowBtn.addEventListener('click', async () => {
  try {
    const result = await window.backupApi.installUpdateNow();
    if (!result.ok) {
      appendLog(`Installazione update non eseguita: ${result.reason}`, 'warn');
      return;
    }
    appendLog('Installazione aggiornamento avviata. L app verra chiusa.', 'info');
  } catch (error) {
    appendLog(`Errore installazione update: ${error.message}`, 'error');
  }
});

stopScheduleBtn.addEventListener('click', async () => {
  try {
    await window.backupApi.stopSchedule();
  } catch (error) {
    appendLog(`Errore stop schedulazione: ${error.message}`, 'error');
  }
});

stopBackupBtn.addEventListener('click', async () => {
  try {
    await window.backupApi.stopBackup();
  } catch (error) {
    appendLog(`Errore stop backup: ${error.message}`, 'error');
  }
});

stopAllBtn.addEventListener('click', async () => {
  try {
    await window.backupApi.stopAllActivity();
  } catch (error) {
    appendLog(`Errore stop attivita: ${error.message}`, 'error');
  }
});

window.backupApi.onBackupEvent((event) => {
  if (event.eventType === 'config-last-run') {
    const cfg = state.configurations.find((item) => item.id === event.configId);
    if (cfg) {
      cfg.lastRunAt = event.lastRunAt;
      cfg.lastRunStatus = event.lastRunStatus;
      renderConfigurationsSummary();
    }
    return;
  }
  if (event.eventType === 'source-progress') {
    updateSourceProgress(event);
    return;
  }
  if (event.message) {
    appendLog(event.message, event.level, event.timestamp);
  }
});

(async function init() {
  try {
    initTheme();
    const loadedState = await window.backupApi.loadConfig();
    loadState(loadedState);
    appendLog('Applicazione pronta');
  } catch (error) {
    appendLog(`Errore inizializzazione: ${error.message}`, 'error');
  }
})();
