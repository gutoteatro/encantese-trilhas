import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { getDb, initializeDatabase } from './db.js';

const app = express();
const API_PORT = Number(process.env.API_PORT || 3001);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, '../dist');
const clientIndexPath = path.join(clientDistPath, 'index.html');

app.use(cors());
app.use(express.json());

function mapTrack(row) {
  return {
    id: row.id,
    name: row.name,
    duration: row.duration,
    url: row.url,
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
    const name = String(request.body?.name || '').trim();
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

    const db = getDb();
    const [themeRows] = await db.query('SELECT id FROM themes WHERE id = ? LIMIT 1', [themeId]);

    if (themeRows.length === 0) {
      response.status(404).json({ message: 'Tema não encontrado.' });
      return;
    }

    const [insertResult] = await db.query(
      `INSERT INTO tracks (theme_id, name, duration, url, drive_file_id, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [themeId, name, duration, url, driveFileId, source],
    );

    const [trackRows] = await db.query(
      `SELECT id, theme_id, name, duration, url, drive_file_id, source, added_at
       FROM tracks WHERE id = ? LIMIT 1`,
      [insertResult.insertId],
    );

    response.status(201).json(mapTrack(trackRows[0]));
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
