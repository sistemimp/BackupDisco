const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const APP_DIR = path.join(os.homedir(), '.backup-disco');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function defaultConfiguration() {
  return {
    id: newId(),
    name: 'Configurazione 1',
    sourceDirs: [],
    targetDir: '',
    lastRunAt: null,
    lastRunStatus: null,
    schedule: {
      type: 'interval',
      intervalMinutes: 60,
      dailyTime: '22:00'
    }
  };
}

function normalizeConfiguration(config, index) {
  const fallback = defaultConfiguration();
  return {
    id: config?.id || newId(),
    name: config?.name || `Configurazione ${index + 1}` || fallback.name,
    sourceDirs: Array.isArray(config?.sourceDirs)
      ? config.sourceDirs.filter(Boolean)
      : (config?.sourceDir ? [config.sourceDir] : []),
    targetDir: config?.targetDir || '',
    lastRunAt: config?.lastRunAt || null,
    lastRunStatus: config?.lastRunStatus || null,
    schedule: {
      type: config?.schedule?.type || 'interval',
      intervalMinutes: Number(config?.schedule?.intervalMinutes || 60),
      dailyTime: config?.schedule?.dailyTime || '22:00'
    }
  };
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    const single = defaultConfiguration();
    return {
      configurations: [single],
      activeConfigurationId: single.id
    };
  }

  const existingConfigurations = Array.isArray(raw.configurations)
    ? raw.configurations
    : [raw];

  const normalized = existingConfigurations
    .map((item, index) => normalizeConfiguration(item, index));

  if (normalized.length === 0) {
    const single = defaultConfiguration();
    normalized.push(single);
  }

  const activeExists = normalized.some((c) => c.id === raw.activeConfigurationId);
  return {
    configurations: normalized,
    activeConfigurationId: activeExists ? raw.activeConfigurationId : normalized[0].id
  };
}

async function ensureAppDir() {
  await fs.mkdir(APP_DIR, { recursive: true });
}

async function loadConfig() {
  await ensureAppDir();
  try {
    const content = await fs.readFile(CONFIG_PATH, 'utf8');
    return normalizeConfig(JSON.parse(content));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return normalizeConfig(null);
    }
    throw error;
  }
}

async function saveConfig(config) {
  await ensureAppDir();
  const normalized = normalizeConfig(config);
  await fs.writeFile(CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

module.exports = {
  loadConfig,
  saveConfig,
  normalizeConfig
};
