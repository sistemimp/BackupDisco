const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const INDEX_FILE = '.backup-index.json';
const LOG_ROOT = path.join(os.homedir(), '.backup-disco', 'logs');
const FILE_OP_TIMEOUT_MS = 15000;

function createCancelledError() {
  const error = new Error('Backup interrotto');
  error.code = 'BACKUP_CANCELLED';
  return error;
}

function assertNotCancelled(shouldCancel) {
  if (typeof shouldCancel === 'function' && shouldCancel()) {
    throw createCancelledError();
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Timeout operazione file: ${label}`);
      error.code = 'FILE_OP_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(rootDir, onDiscover, shouldCancel) {
  const result = [];

  async function walk(current) {
    assertNotCancelled(shouldCancel);
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      assertNotCancelled(shouldCancel);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (entry.isFile()) {
        result.push(absolute);
        if (onDiscover) {
          onDiscover(result.length);
        }
      }
    }
  }

  await walk(rootDir);
  return result;
}

async function partialHash(filePath) {
  const stat = await withTimeout(fs.stat(filePath), FILE_OP_TIMEOUT_MS, `stat ${filePath}`);
  const size = stat.size;
  const hash = crypto.createHash('sha1');

  if (size === 0) {
    return 'empty';
  }

  const chunkSize = Math.min(65536, size);
  const fileHandle = await withTimeout(fs.open(filePath, 'r'), FILE_OP_TIMEOUT_MS, `open ${filePath}`);
  try {
    const startBuffer = Buffer.alloc(chunkSize);
    await withTimeout(fileHandle.read(startBuffer, 0, chunkSize, 0), FILE_OP_TIMEOUT_MS, `read-start ${filePath}`);
    hash.update(startBuffer);

    if (size > chunkSize) {
      const endBuffer = Buffer.alloc(chunkSize);
      await withTimeout(fileHandle.read(endBuffer, 0, chunkSize, size - chunkSize), FILE_OP_TIMEOUT_MS, `read-end ${filePath}`);
      hash.update(endBuffer);
    }

    return hash.digest('hex');
  } finally {
    await fileHandle.close();
  }
}

function buildSignature(stat, pHash) {
  return `${stat.size}|${Math.floor(stat.mtimeMs)}|${pHash}`;
}

function sourceKey(sourceDir) {
  const normalized = path.resolve(sourceDir).toLowerCase();
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10);
  const base = path.basename(sourceDir).replace(/[^a-zA-Z0-9._-]/g, '_') || 'source';
  return `${base}-${hash}`;
}

function runIdFromDate(date = new Date()) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

function formatIsoNow() {
  return new Date().toISOString();
}

async function createSourceRunLogger({ sourceDir, targetDir, runId }) {
  const key = sourceKey(sourceDir);
  const sourceLogDir = path.join(LOG_ROOT, key);
  await ensureDir(sourceLogDir);
  const logPath = path.join(sourceLogDir, `${runId}.log`);

  async function write(line) {
    await fs.appendFile(logPath, `${formatIsoNow()} ${line}\n`, 'utf8');
  }

  await write(`[RUN_START] source="${sourceDir}" target="${targetDir}" runId="${runId}"`);
  return { logPath, write };
}

async function buildFileMap(rootDir, progressInput) {
  const onProgress = typeof progressInput === 'function'
    ? progressInput
    : progressInput?.onProgress;
  const shouldCancel = progressInput?.shouldCancel;
  const onWarning = progressInput?.onWarning;
  let lastDiscoveryEmit = 0;
  const files = await walkFiles(rootDir, (discovered) => {
    if (!onProgress) {
      return;
    }
    if (discovered - lastDiscoveryEmit >= 25) {
      lastDiscoveryEmit = discovered;
      onProgress({
        phase: 'scan-discovery',
        discovered,
        processed: 0,
        total: 0
      });
    }
  });

  if (onProgress) {
    onProgress({
      phase: 'scan-discovery',
      discovered: files.length,
      processed: 0,
      total: 0
    });
  }

  const records = [];
  let indexed = 0;

  for (const absolute of files) {
    assertNotCancelled(shouldCancel);
    try {
      const relativePath = path.relative(rootDir, absolute);
      if (relativePath === INDEX_FILE) {
        indexed += 1;
        if (onProgress) {
          onProgress({
            phase: 'scan-indexing',
            discovered: files.length,
            processed: indexed,
            total: files.length
          });
        }
        continue;
      }

      const stat = await withTimeout(fs.stat(absolute), FILE_OP_TIMEOUT_MS, `stat ${absolute}`);
      const pHash = await partialHash(absolute);
      records.push({
        absolute,
        relativePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        signature: buildSignature(stat, pHash)
      });
    } catch (error) {
      if (onWarning) {
        onWarning({ filePath: absolute, error });
      }
    }

    indexed += 1;
    if (onProgress) {
      onProgress({
        phase: 'scan-indexing',
        discovered: files.length,
        processed: indexed,
        total: files.length
      });
    }
  }

  return records;
}

async function readBackupIndex(targetDir) {
  const indexPath = path.join(targetDir, INDEX_FILE);
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      bySource: parsed.bySource || {}
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { bySource: {} };
    }
    throw error;
  }
}

async function writeBackupIndex(targetDir, bySource) {
  const indexPath = path.join(targetDir, INDEX_FILE);
  await fs.writeFile(indexPath, JSON.stringify({ bySource }, null, 2), 'utf8');
}

async function copyFilePreserveTime(source, target, mtimeMs) {
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
  const time = new Date(mtimeMs);
  await fs.utimes(target, time, time);
}

async function moveFile(oldPath, newPath) {
  await ensureDir(path.dirname(newPath));
  await fs.rename(oldPath, newPath);
}

async function ensureUniquePath(filePath) {
  const parsed = path.parse(filePath);
  let candidate = filePath;
  let counter = 1;

  while (await pathExists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext}`);
    counter += 1;
  }

  return candidate;
}

function resolveTrashRoot(targetDir) {
  return path.join(path.resolve(targetDir), 'Cestino');
}

async function syncOneSource({ sourceDir, targetDir, index, onEvent, runId, shouldCancel }) {
  const key = sourceKey(sourceDir);
  const scopedTargetDir = path.join(targetDir, key);
  const trashSessionDir = path.join(resolveTrashRoot(targetDir), key, runId);
  await ensureDir(scopedTargetDir);
  const sourceLogger = await createSourceRunLogger({ sourceDir, targetDir, runId });

  onEvent({ level: 'info', message: `Scansione sorgente: ${sourceDir}` });
  await sourceLogger.write('[SCAN_SOURCE_START]');
  let sourceRecords;
  try {
    sourceRecords = await buildFileMap(sourceDir, {
      onProgress: (progress) => {
        onEvent({
          eventType: 'source-progress',
          sourceDir,
          processed: progress.processed,
          total: progress.total,
          discovered: progress.discovered,
          phase: progress.phase,
          status: 'scanning'
        });
      },
      onWarning: ({ filePath, error }) => {
        onEvent({
          level: 'warn',
          message: `File saltato in indicizzazione: ${filePath} (${error.code || error.message})`
        });
      },
      shouldCancel
    });
  } catch (error) {
    if (error.code === 'BACKUP_CANCELLED') {
      await sourceLogger.write('[RUN_END] status="cancelled" phase="scan-source"');
    }
    throw error;
  }
  assertNotCancelled(shouldCancel);
  onEvent({
    eventType: 'source-progress',
    sourceDir,
    processed: 0,
    total: sourceRecords.length,
    status: 'running'
  });
  await sourceLogger.write(`[SCAN_SOURCE_DONE] files=${sourceRecords.length}`);
  const totalFiles = sourceRecords.length;
  let processedFiles = 0;

  onEvent({
    eventType: 'source-progress',
    sourceDir,
    processed: 0,
    total: totalFiles,
    status: 'running'
  });

  onEvent({ level: 'info', message: `Scansione destinazione: ${scopedTargetDir}` });
  await sourceLogger.write(`[SCAN_TARGET_START] path="${scopedTargetDir}"`);
  let targetRecords;
  try {
    targetRecords = await buildFileMap(scopedTargetDir, { shouldCancel });
  } catch (error) {
    if (error.code === 'BACKUP_CANCELLED') {
      await sourceLogger.write('[RUN_END] status="cancelled" phase="scan-target"');
    }
    throw error;
  }
  await sourceLogger.write(`[SCAN_TARGET_DONE] files=${targetRecords.length}`);

  const previousBySignature = index.bySource[key] || {};
  const nextBySignature = {};

  const targetByPath = new Map();
  const targetBySignature = new Map();
  const sourceRelativePaths = new Set(sourceRecords.map((item) => item.relativePath));

  for (const file of targetRecords) {
    targetByPath.set(file.relativePath, file);
    if (!targetBySignature.has(file.signature)) {
      targetBySignature.set(file.signature, []);
    }
    targetBySignature.get(file.signature).push(file.relativePath);
  }

  let copied = 0;
  let updated = 0;
  let moved = 0;
  let skipped = 0;
  let trashed = 0;

  function emitProgress(status = 'running') {
    onEvent({
      eventType: 'source-progress',
      sourceDir,
      processed: processedFiles,
      total: totalFiles,
      status
    });
  }

  try {
    for (const targetFile of targetRecords) {
      assertNotCancelled(shouldCancel);
      if (sourceRelativePaths.has(targetFile.relativePath)) {
        continue;
      }

      const sourceAbsolute = path.join(scopedTargetDir, targetFile.relativePath);
      const trashDestination = await ensureUniquePath(path.join(trashSessionDir, targetFile.relativePath));
      await moveFile(sourceAbsolute, trashDestination);
      trashed += 1;
      await sourceLogger.write(`[TRASH] from="${targetFile.relativePath}" to="${trashDestination}"`);
      onEvent({
        level: 'info',
        message: `File rimosso dalla sorgente spostato nel Cestino: ${targetFile.relativePath}`
      });
    }

    for (const src of sourceRecords) {
      assertNotCancelled(shouldCancel);
      const targetAbsolute = path.join(scopedTargetDir, src.relativePath);
      const existingSamePath = targetByPath.get(src.relativePath);

      if (existingSamePath && existingSamePath.signature === src.signature) {
        skipped += 1;
        nextBySignature[src.signature] = src.relativePath;
        processedFiles += 1;
        emitProgress();
        continue;
      }

      const candidates = targetBySignature.get(src.signature) || [];
      const previouslyKnown = previousBySignature[src.signature];
      const moveCandidate = previouslyKnown && candidates.includes(previouslyKnown)
        ? previouslyKnown
        : candidates[0];

      if (moveCandidate && moveCandidate !== src.relativePath) {
        await moveFile(path.join(scopedTargetDir, moveCandidate), targetAbsolute);
        moved += 1;
        nextBySignature[src.signature] = src.relativePath;
        onEvent({ level: 'info', message: `File spostato: ${moveCandidate} -> ${src.relativePath} (${sourceDir})` });
        await sourceLogger.write(`[MOVE] from="${moveCandidate}" to="${src.relativePath}"`);
        processedFiles += 1;
        emitProgress();
        continue;
      }

      if (existingSamePath) {
        await copyFilePreserveTime(src.absolute, targetAbsolute, src.mtimeMs);
        updated += 1;
        nextBySignature[src.signature] = src.relativePath;
        onEvent({ level: 'info', message: `File aggiornato: ${src.relativePath} (${sourceDir})` });
        await sourceLogger.write(`[UPDATE] path="${src.relativePath}"`);
        processedFiles += 1;
        emitProgress();
        continue;
      }

      await copyFilePreserveTime(src.absolute, targetAbsolute, src.mtimeMs);
      copied += 1;
      nextBySignature[src.signature] = src.relativePath;
      onEvent({ level: 'info', message: `File copiato: ${src.relativePath} (${sourceDir})` });
      await sourceLogger.write(`[COPY] path="${src.relativePath}"`);
      processedFiles += 1;
      emitProgress();
    }

    emitProgress('done');
    await sourceLogger.write(`[SUMMARY] sourceFiles=${sourceRecords.length} copied=${copied} updated=${updated} moved=${moved} skipped=${skipped} trashed=${trashed}`);
    await sourceLogger.write('[RUN_END] status="ok"');
  } catch (error) {
    if (error.code === 'BACKUP_CANCELLED') {
      emitProgress('cancelled');
      await sourceLogger.write(`[SUMMARY] sourceFiles=${sourceRecords.length} copied=${copied} updated=${updated} moved=${moved} skipped=${skipped} trashed=${trashed}`);
      await sourceLogger.write('[RUN_END] status="cancelled" phase="sync"');
    }
    throw error;
  }

  index.bySource[key] = nextBySignature;

  return {
    copied,
    updated,
    moved,
    skipped,
    trashed,
    sourceFiles: sourceRecords.length,
    sourceDir,
    scopedTargetDir,
    logPath: sourceLogger.logPath
  };
}

async function runBackup({ sourceDirs, sourceDir, targetDir, onEvent = () => {}, shouldCancel = () => false }) {
  const runId = runIdFromDate();
  const normalizedSourceDirs = Array.isArray(sourceDirs)
    ? sourceDirs.filter(Boolean)
    : (sourceDir ? [sourceDir] : []);

  if (!normalizedSourceDirs.length || !targetDir) {
    throw new Error('Configurazione incompleta: almeno una cartella sorgente e targetDir sono obbligatori.');
  }

  for (const src of normalizedSourceDirs) {
    assertNotCancelled(shouldCancel);
    if (!(await pathExists(src))) {
      throw new Error(`Cartella sorgente non trovata: ${src}`);
    }
  }

  await ensureDir(targetDir);

  const index = await readBackupIndex(targetDir);
  const totals = { copied: 0, updated: 0, moved: 0, skipped: 0, trashed: 0, sourceFiles: 0 };

  for (const src of normalizedSourceDirs) {
    assertNotCancelled(shouldCancel);
    const partial = await syncOneSource({ sourceDir: src, targetDir, index, onEvent, runId, shouldCancel });
    totals.copied += partial.copied;
    totals.updated += partial.updated;
    totals.moved += partial.moved;
    totals.skipped += partial.skipped;
    totals.trashed += partial.trashed;
    totals.sourceFiles += partial.sourceFiles;
    onEvent({ level: 'info', message: `Log cartella salvato: ${partial.logPath}` });
  }

  await writeBackupIndex(targetDir, index.bySource);

  onEvent({
    level: 'info',
    message: `Backup completato. Sorgenti: ${normalizedSourceDirs.length}, Copiati: ${totals.copied}, Aggiornati: ${totals.updated}, Spostati: ${totals.moved}, Invariati: ${totals.skipped}, Nel Cestino: ${totals.trashed}`
  });

  return totals;
}

module.exports = {
  runBackup
};
