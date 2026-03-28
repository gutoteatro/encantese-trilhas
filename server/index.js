import 'dotenv/config';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { getDb, initializeDatabase } from './db.js';

const app = express();
const API_PORT = Number(process.env.API_PORT || 3001);
const MAX_AUDIO_UPLOAD_BYTES = Number(process.env.MAX_AUDIO_UPLOAD_BYTES || 100 * 1024 * 1024);
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const PUBLIC_UPLOAD_ROUTE = '/uploads';
const DUPLICATE_GUARD_WINDOW_SECONDS = Number(process.env.DUPLICATE_GUARD_WINDOW_SECONDS || 45);
const DUPLICATE_GUARD_WINDOW_MS = Math.max(5, DUPLICATE_GUARD_WINDOW_SECONDS) * 1000;
const duplicateTrackGuardCache = new Map();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, '../dist');
const clientIndexPath = path.join(clientDistPath, 'index.html');

app.use(cors());
app.use(express.json());
mkdirSync(UPLOAD_DIR, { recursive: true });
app.use(PUBLIC_UPLOAD_ROUTE, express.static(UPLOAD_DIR));

const ALLOWED_AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave']);
const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav']);

const uploadStorage = multer.diskStorage({
  destination: (_request, _file, callback) => {
    callback(null, UPLOAD_DIR);
  },
  filename: (_request, file, callback) => {
    const extension = path.extname(String(file.originalname || '')).toLowerCase();
    const safeExtension = ALLOWED_AUDIO_EXTENSIONS.has(extension) ? extension : '.mp3';
    callback(null, `${Date.now()}-${randomUUID()}${safeExtension}`);
  },
});

function isAllowedAudioUpload(file) {
  const extension = path.extname(String(file?.originalname || '')).toLowerCase();
  const mimeType = String(file?.mimetype || '').toLowerCase();
  return ALLOWED_AUDIO_EXTENSIONS.has(extension) && ALLOWED_AUDIO_MIME_TYPES.has(mimeType);
}

const uploadTrackFile = multer({
  storage: uploadStorage,
  limits: {
    fileSize: MAX_AUDIO_UPLOAD_BYTES,
  },
  fileFilter: (_request, file, callback) => {
    if (isAllowedAudioUpload(file)) {
      callback(null, true);
      return;
    }

    callback(new Error('Formato inválido. Envie apenas arquivos MP3 ou WAV.'));
  },
});

function mapTrack(row) {
  const normalizedUrl = String(row.url || '').trim();
  const normalizedSource = String(row.source || '').trim().toLowerCase();
  const isLocalUpload = normalizedSource === 'local-upload' || normalizedUrl.toLowerCase().startsWith('/uploads/');

  return {
    id: row.id,
    name: row.name,
    duration: row.duration,
    url: normalizedUrl,
    publicUrl: isLocalUpload ? '' : normalizedUrl,
    driveFileId: row.drive_file_id,
    source: row.source,
    addedAt: row.added_at,
  };
}

function mapTheme(row, tracksByTheme) {
  return {
    id: row.id,
    title: row.title,
    tracks: tracksByTheme.get(row.id) || [],
  };
}

async function safeRemoveUploadedFile(filePath) {
  if (!filePath) {
    return;
  }

  try {
    await unlink(filePath);
  } catch {
    // ignore file cleanup errors
  }
}

function buildTrackNameFromInput(rawName, originalFileName) {
  const provided = String(rawName || '').trim();
  if (provided) {
    return provided.toUpperCase();
  }

  const fallbackName = path.parse(String(originalFileName || '')).name.trim();
  if (fallbackName) {
    return fallbackName.toUpperCase();
  }

  return 'TRILHA';
}

function resolveLocalUploadPath(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input.startsWith(`${PUBLIC_UPLOAD_ROUTE}/`)) {
    return null;
  }

  const fileName = decodeURIComponent(path.basename(input));
  if (!fileName || fileName === '.' || fileName === '..') {
    return null;
  }

  return path.join(UPLOAD_DIR, fileName);
}

function buildRecentDuplicateThresholdDate() {
  return new Date(Date.now() - DUPLICATE_GUARD_WINDOW_MS);
}

function pruneDuplicateTrackGuardCache() {
  const now = Date.now();
  for (const [key, entry] of duplicateTrackGuardCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      duplicateTrackGuardCache.delete(key);
    }
  }
}

function readDuplicateTrackGuard(key) {
  pruneDuplicateTrackGuardCache();
  return duplicateTrackGuardCache.get(key) || null;
}

function setDuplicateTrackGuardPending(key) {
  pruneDuplicateTrackGuardCache();
  duplicateTrackGuardCache.set(key, {
    state: 'pending',
    trackId: null,
    expiresAt: Date.now() + DUPLICATE_GUARD_WINDOW_MS,
  });
}

function setDuplicateTrackGuardCommitted(key, trackId = null) {
  pruneDuplicateTrackGuardCache();
  duplicateTrackGuardCache.set(key, {
    state: 'done',
    trackId: Number.isFinite(trackId) ? trackId : null,
    expiresAt: Date.now() + DUPLICATE_GUARD_WINDOW_MS,
  });
}

function clearDuplicateTrackGuard(key) {
  duplicateTrackGuardCache.delete(key);
}

function normalizeTrackName(name) {
  return String(name || '').trim().toUpperCase();
}

function normalizeTrackUrlFingerprint(rawUrl, explicitDriveFileId) {
  const driveFileId = explicitDriveFileId || extractDriveFileId(rawUrl);
  if (driveFileId) {
    return `drive:${driveFileId}`;
  }

  try {
    const parsed = new URL(String(rawUrl || '').trim());
    parsed.hash = '';
    parsed.searchParams.sort();
    return `url:${parsed.toString().toLowerCase()}`;
  } catch {
    return `url:${String(rawUrl || '').trim().toLowerCase()}`;
  }
}

function buildDuplicateGuardKey(parts) {
  return parts.map((part) => String(part || '').trim().toLowerCase()).join('|');
}

async function computeFileHashSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', (error) => {
      reject(error);
    });
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

async function loadTrackById(db, trackId) {
  if (!Number.isFinite(trackId) || trackId <= 0) {
    return null;
  }

  const [rows] = await db.query(
    `SELECT id, theme_id, name, duration, url, drive_file_id, source, added_at
     FROM tracks WHERE id = ? LIMIT 1`,
    [trackId],
  );

  return rows[0] || null;
}

function sendDuplicateTrackResponse(response, message, trackRow = null) {
  response.status(409).json({
    message,
    duplicateTrack: trackRow ? mapTrack(trackRow) : null,
  });
}

function extractDriveFileId(rawValue) {
  const input = String(rawValue || '').trim();
  if (!input) {
    return null;
  }

  if (/^[a-zA-Z0-9_-]{10,}$/.test(input)) {
    return input;
  }

  try {
    const parsedUrl = new URL(input);
    const byPath = parsedUrl.pathname.match(/\/file\/d\/([^/]+)/);
    if (byPath?.[1]) {
      return byPath[1];
    }

    const byQuery = parsedUrl.searchParams.get('id');
    if (byQuery) {
      return byQuery;
    }

    return null;
  } catch {
    return null;
  }
}

function buildDriveCandidates(fileId) {
  return [
    `https://drive.usercontent.google.com/download?id=${fileId}&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${fileId}`,
    `https://docs.google.com/uc?export=download&id=${fileId}`,
    `https://drive.google.com/uc?export=view&id=${fileId}`,
  ];
}

async function requestDriveUrl(url, range) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 EncanteseTrilhas/1.0',
    Accept: '*/*',
  };

  if (range) {
    headers.Range = range;
  }

  return fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers,
  });
}

function extractConfirmToken(html) {
  const match = html.match(/[?&]confirm=([0-9A-Za-z_-]+)/);
  return match?.[1] || null;
}

async function resolveDriveStream(fileId, rangeHeader) {
  const candidates = buildDriveCandidates(fileId);

  for (const candidate of candidates) {
    const response = await requestDriveUrl(candidate, rangeHeader);

    if (!response.ok) {
      continue;
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      const html = await response.text();
      const token = extractConfirmToken(html);

      if (!token) {
        continue;
      }

      const confirmedUrl = `https://drive.google.com/uc?export=download&confirm=${token}&id=${fileId}`;
      const confirmedResponse = await requestDriveUrl(confirmedUrl, rangeHeader);
      if (confirmedResponse.ok) {
        return confirmedResponse;
      }

      continue;
    }

    return response;
  }

  return null;
}

function sanitizeFileName(name) {
  return String(name || 'trilha.mp3')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .replace(/\s+/g, '_') || 'trilha.mp3';
}

function mirrorStreamHeaders(upstream, response, shouldDownload, filename) {
  const forwardedHeaders = [
    'content-type',
    'content-length',
    'accept-ranges',
    'content-range',
    'etag',
    'last-modified',
    'cache-control',
  ];

  for (const header of forwardedHeaders) {
    const value = upstream.headers.get(header);
    if (value) {
      response.setHeader(header, value);
    }
  }

  if (shouldDownload) {
    response.setHeader('content-disposition', `attachment; filename="${sanitizeFileName(filename)}"`);
    return;
  }

  const originalDisposition = upstream.headers.get('content-disposition');
  if (originalDisposition) {
    response.setHeader('content-disposition', originalDisposition);
  }
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true });
});

app.get('/api/themes', async (_request, response, next) => {
  try {
    const db = getDb();
    const [themeRows] = await db.query(
      'SELECT id, title, created_at FROM themes ORDER BY created_at DESC, id DESC',
    );

    const [trackRows] = await db.query(
      `SELECT id, theme_id, name, duration, url, drive_file_id, source, added_at
       FROM tracks
       ORDER BY added_at DESC, id DESC`,
    );

    const tracksByTheme = new Map();
    for (const row of trackRows) {
      const currentTrackList = tracksByTheme.get(row.theme_id) || [];
      currentTrackList.push(mapTrack(row));
      tracksByTheme.set(row.theme_id, currentTrackList);
    }

    const payload = themeRows.map((row) => mapTheme(row, tracksByTheme));
    response.json(payload);
  } catch (error) {
    next(error);
  }
});

app.post('/api/themes', async (request, response, next) => {
  try {
    const title = String(request.body?.title || '').trim();

    if (!title) {
      response.status(400).json({ message: 'Nome do tema é obrigatório.' });
      return;
    }

    const db = getDb();
    const [insertResult] = await db.query('INSERT INTO themes (title) VALUES (?)', [title]);
    const themeId = insertResult.insertId;

    response.status(201).json({
      id: themeId,
      title,
      tracks: [],
    });
  } catch (error) {
    next(error);
  }
});

app.put('/api/themes/:themeId', async (request, response, next) => {
  try {
    const themeId = Number(request.params.themeId);
    const title = String(request.body?.title || '').trim();

    if (!Number.isFinite(themeId) || themeId <= 0) {
      response.status(400).json({ message: 'Tema inválido.' });
      return;
    }

    if (!title) {
      response.status(400).json({ message: 'Nome do tema é obrigatório.' });
      return;
    }

    const db = getDb();
    const [updateResult] = await db.query('UPDATE themes SET title = ? WHERE id = ?', [title, themeId]);

    if (updateResult.affectedRows === 0) {
      response.status(404).json({ message: 'Tema não encontrado.' });
      return;
    }

    response.json({ id: themeId, title });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/themes/:themeId', async (request, response, next) => {
  try {
    const themeId = Number(request.params.themeId);

    if (!Number.isFinite(themeId) || themeId <= 0) {
      response.status(400).json({ message: 'Tema inválido.' });
      return;
    }

    const db = getDb();
    const [deleteResult] = await db.query('DELETE FROM themes WHERE id = ?', [themeId]);

    if (deleteResult.affectedRows === 0) {
      response.status(404).json({ message: 'Tema não encontrado.' });
      return;
    }

    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/themes/:themeId/tracks', async (request, response, next) => {
  try {
    const themeId = Number(request.params.themeId);
    const name = normalizeTrackName(request.body?.name || '');
    const url = String(request.body?.url || '').trim();
    const duration = String(request.body?.duration || '--:--').trim() || '--:--';
    const driveFileId = request.body?.driveFileId ? String(request.body.driveFileId) : null;
    const source = String(request.body?.source || 'drive-link').trim() || 'drive-link';

    if (!Number.isFinite(themeId) || themeId <= 0) {
      response.status(400).json({ message: 'Tema inválido.' });
      return;
    }

    if (!name || !url) {
      response.status(400).json({ message: 'Nome da trilha e URL são obrigatórios.' });
      return;
    }

    const urlFingerprint = normalizeTrackUrlFingerprint(url, driveFileId);
    const duplicateGuardKey = buildDuplicateGuardKey(['create-url', themeId, name, urlFingerprint]);
    const duplicateGuardEntry = readDuplicateTrackGuard(duplicateGuardKey);
    if (duplicateGuardEntry) {
      const db = getDb();
      const duplicateTrack = duplicateGuardEntry.trackId
        ? await loadTrackById(db, duplicateGuardEntry.trackId)
        : null;

      sendDuplicateTrackResponse(
        response,
        duplicateGuardEntry.state === 'pending'
          ? 'Esta trilha já está sendo incluída. Aguarde a conclusão do envio.'
          : `Trilha duplicada detectada. Aguarde ${DUPLICATE_GUARD_WINDOW_SECONDS}s antes de reenviar.`,
        duplicateTrack,
      );
      return;
    }

    setDuplicateTrackGuardPending(duplicateGuardKey);
    let shouldClearDuplicateGuard = true;

    const db = getDb();
    try {
      const [themeRows] = await db.query('SELECT id FROM themes WHERE id = ? LIMIT 1', [themeId]);

      if (themeRows.length === 0) {
        response.status(404).json({ message: 'Tema não encontrado.' });
        return;
      }

      const recentThreshold = buildRecentDuplicateThresholdDate();
      const [duplicateRows] = await db.query(
        `SELECT id, theme_id, name, duration, url, drive_file_id, source, added_at
         FROM tracks
         WHERE theme_id = ?
           AND UPPER(name) = ?
           AND added_at >= ?
           AND (
             (? IS NOT NULL AND drive_file_id = ?)
             OR LOWER(url) = LOWER(?)
           )
         ORDER BY id DESC
         LIMIT 1`,
        [themeId, name, recentThreshold, driveFileId, driveFileId, url],
      );

      if (duplicateRows.length > 0) {
        setDuplicateTrackGuardCommitted(duplicateGuardKey, duplicateRows[0].id);
        shouldClearDuplicateGuard = false;
        sendDuplicateTrackResponse(
          response,
          `Trilha duplicada detectada neste tema nos últimos ${DUPLICATE_GUARD_WINDOW_SECONDS}s.`,
          duplicateRows[0],
        );
        return;
      }

      const [insertResult] = await db.query(
        `INSERT INTO tracks (theme_id, name, duration, url, drive_file_id, source, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [themeId, name, duration, url, driveFileId, source],
      );

      const [trackRows] = await db.query(
        `SELECT id, theme_id, name, duration, url, drive_file_id, source, added_at
         FROM tracks WHERE id = ? LIMIT 1`,
        [insertResult.insertId],
      );

      setDuplicateTrackGuardCommitted(duplicateGuardKey, insertResult.insertId);
      shouldClearDuplicateGuard = false;
      response.status(201).json(mapTrack(trackRows[0]));
    } finally {
      if (shouldClearDuplicateGuard) {
        clearDuplicateTrackGuard(duplicateGuardKey);
      }
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/themes/:themeId/tracks/upload', (request, response, next) => {
  uploadTrackFile.single('file')(request, response, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
        response.status(400).json({ message: 'Arquivo excede o limite de 100 MB.' });
        return;
      }

      response.status(400).json({
        message: uploadError.message || 'Não foi possível enviar o arquivo.',
      });
      return;
    }

    const uploadedFile = request.file;
    if (!uploadedFile) {
      response.status(400).json({ message: 'Selecione um arquivo de áudio para enviar.' });
      return;
    }

    const themeId = Number(request.params.themeId);
    if (!Number.isFinite(themeId) || themeId <= 0) {
      await safeRemoveUploadedFile(uploadedFile.path);
      response.status(400).json({ message: 'Tema inválido.' });
      return;
    }

    const providedTrackName = String(request.body?.name || '').trim();
    if (!providedTrackName) {
      await safeRemoveUploadedFile(uploadedFile.path);
      response.status(400).json({ message: 'Nome da trilha é obrigatório para upload de arquivo.' });
      return;
    }

    const trackName = buildTrackNameFromInput(providedTrackName, uploadedFile.originalname);
    const trackUrl = `${PUBLIC_UPLOAD_ROUTE}/${uploadedFile.filename}`;
    const duplicateNameKey = buildDuplicateGuardKey([
      'create-upload-name',
      themeId,
      trackName,
      uploadedFile.size,
      uploadedFile.originalname,
    ]);
    const duplicateNameGuardEntry = readDuplicateTrackGuard(duplicateNameKey);
    if (duplicateNameGuardEntry) {
      await safeRemoveUploadedFile(uploadedFile.path);
      let duplicateTrack = null;
      if (duplicateNameGuardEntry.trackId) {
        try {
          const db = getDb();
          duplicateTrack = await loadTrackById(db, duplicateNameGuardEntry.trackId);
        } catch {
          duplicateTrack = null;
        }
      }
      sendDuplicateTrackResponse(
        response,
        duplicateNameGuardEntry.state === 'pending'
          ? 'Este upload já está em andamento. Aguarde concluir antes de enviar novamente.'
          : `Trilha duplicada detectada. Aguarde ${DUPLICATE_GUARD_WINDOW_SECONDS}s antes de reenviar.`,
        duplicateTrack,
      );
      return;
    }
    setDuplicateTrackGuardPending(duplicateNameKey);

    let fileHash = '';
    try {
      fileHash = await computeFileHashSha256(uploadedFile.path);
    } catch {
      clearDuplicateTrackGuard(duplicateNameKey);
      await safeRemoveUploadedFile(uploadedFile.path);
      response.status(500).json({ message: 'Não foi possível processar o arquivo enviado.' });
      return;
    }

    const duplicateHashKey = buildDuplicateGuardKey(['create-upload-hash', themeId, trackName, fileHash]);
    const duplicateHashGuardEntry = readDuplicateTrackGuard(duplicateHashKey);
    if (duplicateHashGuardEntry) {
      setDuplicateTrackGuardCommitted(duplicateNameKey, duplicateHashGuardEntry.trackId || null);
      await safeRemoveUploadedFile(uploadedFile.path);
      let duplicateTrack = null;
      if (duplicateHashGuardEntry.trackId) {
        try {
          const db = getDb();
          duplicateTrack = await loadTrackById(db, duplicateHashGuardEntry.trackId);
        } catch {
          duplicateTrack = null;
        }
      }
      sendDuplicateTrackResponse(
        response,
        duplicateHashGuardEntry.state === 'pending'
          ? 'Este upload já está em andamento. Aguarde concluir antes de enviar novamente.'
          : `Trilha duplicada detectada. Aguarde ${DUPLICATE_GUARD_WINDOW_SECONDS}s antes de reenviar.`,
        duplicateTrack,
      );
      return;
    }
    setDuplicateTrackGuardPending(duplicateHashKey);

    try {
      const db = getDb();
      const [themeRows] = await db.query('SELECT id FROM themes WHERE id = ? LIMIT 1', [themeId]);

      if (themeRows.length === 0) {
        clearDuplicateTrackGuard(duplicateNameKey);
        clearDuplicateTrackGuard(duplicateHashKey);
        await safeRemoveUploadedFile(uploadedFile.path);
        response.status(404).json({ message: 'Tema não encontrado.' });
        return;
      }

      const recentThreshold = buildRecentDuplicateThresholdDate();
      const [duplicateRows] = await db.query(
        `SELECT id, theme_id, name, duration, url, drive_file_id, source, added_at
         FROM tracks
         WHERE theme_id = ?
           AND added_at >= ?
           AND (
             (content_hash IS NOT NULL AND content_hash = ?)
             OR (UPPER(name) = ? AND source = 'local-upload')
           )
         ORDER BY id DESC
         LIMIT 1`,
        [themeId, recentThreshold, fileHash, trackName],
      );

      if (duplicateRows.length > 0) {
        setDuplicateTrackGuardCommitted(duplicateNameKey, duplicateRows[0].id);
        setDuplicateTrackGuardCommitted(duplicateHashKey, duplicateRows[0].id);
        await safeRemoveUploadedFile(uploadedFile.path);
        sendDuplicateTrackResponse(
          response,
          `Upload duplicado detectado neste tema nos últimos ${DUPLICATE_GUARD_WINDOW_SECONDS}s.`,
          duplicateRows[0],
        );
        return;
      }

      const [insertResult] = await db.query(
        `INSERT INTO tracks (theme_id, name, duration, url, drive_file_id, source, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [themeId, trackName, '--:--', trackUrl, null, 'local-upload', fileHash],
      );

      const [trackRows] = await db.query(
        `SELECT id, theme_id, name, duration, url, drive_file_id, source, added_at
         FROM tracks WHERE id = ? LIMIT 1`,
        [insertResult.insertId],
      );

      setDuplicateTrackGuardCommitted(duplicateNameKey, insertResult.insertId);
      setDuplicateTrackGuardCommitted(duplicateHashKey, insertResult.insertId);
      response.status(201).json(mapTrack(trackRows[0]));
    } catch (error) {
      clearDuplicateTrackGuard(duplicateNameKey);
      clearDuplicateTrackGuard(duplicateHashKey);
      await safeRemoveUploadedFile(uploadedFile.path);
      next(error);
    }
  });
});

function handleUpdateTrackUpload(request, response, next) {
  uploadTrackFile.single('file')(request, response, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
        response.status(400).json({ message: 'Arquivo excede o limite de 100 MB.' });
        return;
      }

      response.status(400).json({
        message: uploadError.message || 'Não foi possível enviar o arquivo.',
      });
      return;
    }

    const uploadedFile = request.file;
    if (!uploadedFile) {
      response.status(400).json({ message: 'Selecione um arquivo de áudio para enviar.' });
      return;
    }

    const trackId = Number(request.params.trackId);
    if (!Number.isFinite(trackId) || trackId <= 0) {
      await safeRemoveUploadedFile(uploadedFile.path);
      response.status(400).json({ message: 'Trilha inválida.' });
      return;
    }

    const providedTrackName = String(request.body?.name || '').trim();
    if (!providedTrackName) {
      await safeRemoveUploadedFile(uploadedFile.path);
      response.status(400).json({ message: 'Nome da trilha é obrigatório para upload de arquivo.' });
      return;
    }

    const trackName = buildTrackNameFromInput(providedTrackName, uploadedFile.originalname);
    const trackUrl = `${PUBLIC_UPLOAD_ROUTE}/${uploadedFile.filename}`;
    let fileHash = '';
    try {
      fileHash = await computeFileHashSha256(uploadedFile.path);
    } catch {
      await safeRemoveUploadedFile(uploadedFile.path);
      response.status(500).json({ message: 'Não foi possível processar o arquivo enviado.' });
      return;
    }

    try {
      const db = getDb();
      const [existingRows] = await db.query(
        'SELECT id, url, source FROM tracks WHERE id = ? LIMIT 1',
        [trackId],
      );

      if (existingRows.length === 0) {
        await safeRemoveUploadedFile(uploadedFile.path);
        response.status(404).json({ message: 'Trilha não encontrada.' });
        return;
      }

      const existingTrack = existingRows[0];
      const previousLocalPath = existingTrack.source === 'local-upload'
        ? resolveLocalUploadPath(existingTrack.url)
        : null;

      const [updateResult] = await db.query(
        `UPDATE tracks
         SET name = ?, duration = ?, url = ?, drive_file_id = NULL, source = ?, content_hash = ?
         WHERE id = ?`,
        [trackName, '--:--', trackUrl, 'local-upload', fileHash, trackId],
      );

      if (updateResult.affectedRows === 0) {
        await safeRemoveUploadedFile(uploadedFile.path);
        response.status(404).json({ message: 'Trilha não encontrada.' });
        return;
      }

      const [trackRows] = await db.query(
        `SELECT id, theme_id, name, duration, url, drive_file_id, source, added_at
         FROM tracks WHERE id = ? LIMIT 1`,
        [trackId],
      );

      if (previousLocalPath && previousLocalPath !== uploadedFile.path) {
        await safeRemoveUploadedFile(previousLocalPath);
      }

      response.json(mapTrack(trackRows[0]));
    } catch (error) {
      await safeRemoveUploadedFile(uploadedFile.path);
      next(error);
    }
  });
}

app.put('/api/tracks/:trackId/upload', handleUpdateTrackUpload);
app.post('/api/tracks/:trackId/upload', handleUpdateTrackUpload);

async function handleUpdateTrack(request, response, next) {
  try {
    const trackId = Number(request.params.trackId);
    const name = normalizeTrackName(request.body?.name || '');
    const url = String(request.body?.url || '').trim();
    const driveFileId = request.body?.driveFileId ? String(request.body.driveFileId) : null;

    if (!Number.isFinite(trackId) || trackId <= 0) {
      response.status(400).json({ message: 'Trilha inválida.' });
      return;
    }

    if (!name || !url) {
      response.status(400).json({ message: 'Nome da trilha e URL são obrigatórios.' });
      return;
    }

    const db = getDb();
    const [updateResult] = await db.query(
      `UPDATE tracks
       SET name = ?, url = ?, drive_file_id = ?, content_hash = NULL
       WHERE id = ?`,
      [name, url, driveFileId, trackId],
    );

    if (updateResult.affectedRows === 0) {
      response.status(404).json({ message: 'Trilha não encontrada.' });
      return;
    }

    const [trackRows] = await db.query(
      `SELECT id, theme_id, name, duration, url, drive_file_id, source, added_at
       FROM tracks WHERE id = ? LIMIT 1`,
      [trackId],
    );

    response.json(mapTrack(trackRows[0]));
  } catch (error) {
    next(error);
  }
}

app.put('/api/tracks/:trackId', handleUpdateTrack);
app.post('/api/tracks/:trackId/update', handleUpdateTrack);

async function handleDeleteTrack(request, response, next) {
  try {
    const trackId = Number(request.params.trackId);

    if (!Number.isFinite(trackId) || trackId <= 0) {
      response.status(400).json({ message: 'Trilha inválida.' });
      return;
    }

    const db = getDb();
    const [deleteResult] = await db.query('DELETE FROM tracks WHERE id = ?', [trackId]);

    if (deleteResult.affectedRows === 0) {
      response.status(404).json({ message: 'Trilha não encontrada.' });
      return;
    }

    response.status(204).end();
  } catch (error) {
    next(error);
  }
}

app.delete('/api/tracks/:trackId', handleDeleteTrack);
app.post('/api/tracks/:trackId/delete', handleDeleteTrack);

app.put('/api/tracks/:trackId/duration', async (request, response, next) => {
  try {
    const trackId = Number(request.params.trackId);
    const duration = String(request.body?.duration || '').trim();

    if (!Number.isFinite(trackId) || trackId <= 0) {
      response.status(400).json({ message: 'Trilha inválida.' });
      return;
    }

    if (!/^\d{2,}:[0-5]\d$/.test(duration)) {
      response.status(400).json({ message: 'Duração inválida. Use o formato MM:SS.' });
      return;
    }

    const db = getDb();
    const [updateResult] = await db.query('UPDATE tracks SET duration = ? WHERE id = ?', [
      duration,
      trackId,
    ]);

    if (updateResult.affectedRows === 0) {
      response.status(404).json({ message: 'Trilha não encontrada.' });
      return;
    }

    response.json({ id: trackId, duration });
  } catch (error) {
    next(error);
  }
});

app.get('/api/drive/:fileId', async (request, response, next) => {
  try {
    const pathFileId = extractDriveFileId(request.params.fileId);
    const queryFileId = extractDriveFileId(request.query.url);
    const fileId = pathFileId || queryFileId;

    if (!fileId) {
      response.status(400).json({
        message: 'ID do arquivo do Google Drive inválido.',
      });
      return;
    }

    const upstream = await resolveDriveStream(fileId, request.headers.range);
    if (!upstream) {
      response.status(502).json({
        message: 'Não foi possível acessar este arquivo no Google Drive.',
      });
      return;
    }

    const shouldDownload = String(request.query.download || '') === '1';
    const filename = request.query.filename || 'trilha.mp3';

    response.status(upstream.status);
    mirrorStreamHeaders(upstream, response, shouldDownload, filename);

    if (!upstream.body) {
      response.end();
      return;
    }

    Readable.fromWeb(upstream.body).pipe(response);
  } catch (error) {
    next(error);
  }
});

if (existsSync(clientIndexPath)) {
  app.use(express.static(clientDistPath));

  app.get(/^(?!\/api).*/, (_request, response) => {
    response.sendFile(clientIndexPath);
  });
}

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ message: 'Erro interno no servidor.' });
});

async function startServer() {
  try {
    await initializeDatabase();
    app.listen(API_PORT, () => {
      console.log(`[api] running on http://localhost:${API_PORT}`);
    });
  } catch (error) {
    console.error('[api] failed to start', error);
    process.exit(1);
  }
}

startServer();
