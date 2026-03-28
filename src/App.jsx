import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Layout from './components/Layout';
import AudioPlayer from './components/AudioPlayer';
import {
  Download,
  Plus,
  Pause,
  Pencil,
  Play,
  Search as SearchIcon,
  Trash2,
} from 'lucide-react';

const API_BASE = '/api';
const UPLOAD_PASSWORD = '1234';
const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;
const ALLOWED_AUDIO_UPLOAD_EXTENSIONS = ['.mp3', '.wav'];
const ALLOWED_AUDIO_UPLOAD_MIME_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave']);

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const rawText = await response.text();
  let payload = {};

  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload?.message || `Falha na comunicação com o banco de dados (HTTP ${response.status}).`);
  }

  return payload;
}

async function apiUploadRequest(path, formData, method = 'POST', onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `${API_BASE}${path}`, true);

    if (typeof onProgress === 'function') {
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) {
          return;
        }
        const percent = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
        onProgress(percent);
      };
    }

    xhr.onload = () => {
      const rawText = String(xhr.responseText || '');
      let payload = {};

      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        payload = {};
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        const endpointMissing = xhr.status === 404 && /Cannot (POST|PUT|PATCH|DELETE)/i.test(rawText);
        if (endpointMissing) {
          reject(new Error('Upload indisponível na API atual. Atualize e reinicie o backend no servidor.'));
          return;
        }

        reject(new Error(payload?.message || `Falha no upload (HTTP ${xhr.status}).`));
        return;
      }

      if (typeof onProgress === 'function') {
        onProgress(100);
      }
      resolve(payload);
    };

    xhr.onerror = () => {
      reject(new Error('Falha de rede durante o upload. Tente novamente.'));
    };

    xhr.send(formData);
  });
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function isKnownDurationLabel(value) {
  return /^\d{2,}:[0-5]\d$/.test(String(value || '').trim());
}

function extractDriveFileId(rawUrl) {
  try {
    const parsedUrl = new URL(rawUrl);
    const pathMatch = parsedUrl.pathname.match(/\/file\/d\/([^/]+)/);

    if (pathMatch?.[1]) {
      return pathMatch[1];
    }

    const idFromQuery = parsedUrl.searchParams.get('id');
    if (idFromQuery) {
      return idFromQuery;
    }

    return null;
  } catch {
    return null;
  }
}

function normalizeAudioUrl(rawUrl) {
  const sanitizedUrl = rawUrl.trim();

  try {
    const parsedUrl = new URL(sanitizedUrl);
    const host = parsedUrl.hostname.replace('www.', '');

    if (host === 'drive.google.com' || host === 'docs.google.com') {
      const fileId = extractDriveFileId(sanitizedUrl);

      if (fileId) {
        return `https://drive.googleusercontent.com/uc?id=${fileId}&export=download`;
      }
    }

    return parsedUrl.toString();
  } catch {
    return '';
  }
}

function isAllowedAudioFile(file) {
  const fileName = String(file?.name || '').toLowerCase();
  const fileType = String(file?.type || '').toLowerCase();
  const hasValidExtension = ALLOWED_AUDIO_UPLOAD_EXTENSIONS.some((extension) => fileName.endsWith(extension));
  const hasValidMimeType = !fileType || ALLOWED_AUDIO_UPLOAD_MIME_TYPES.has(fileType);
  return hasValidExtension && hasValidMimeType;
}

function getCurrentTrackFileLabel(track) {
  if (!track) {
    return '';
  }

  const rawUrl = String(track.url || '').trim();
  if (!rawUrl) {
    return track.name || 'Sem arquivo identificado';
  }

  const safeUrl = rawUrl.split('?')[0].split('#')[0];
  let fileName = '';

  try {
    fileName = decodeURIComponent(safeUrl.split('/').pop() || '').trim();
  } catch {
    fileName = String(safeUrl.split('/').pop() || '').trim();
  }

  if (fileName) {
    return fileName;
  }

  const driveFileId = track.driveFileId || extractDriveFileId(rawUrl);
  if (driveFileId) {
    return `Google Drive (${driveFileId})`;
  }

  return track.name || 'Arquivo atual';
}

function buildDriveProxyUrl(fileId, options = {}) {
  if (!fileId) {
    return '';
  }

  const query = new URLSearchParams();
  if (options.download) {
    query.set('download', '1');
  }

  if (options.filename) {
    query.set('filename', options.filename);
  }

  const queryString = query.toString();
  return `/api/drive/${encodeURIComponent(fileId)}${queryString ? `?${queryString}` : ''}`;
}

function getTrackSourceCandidates(track) {
  if (!track) {
    return [];
  }

  const driveFileId = track.driveFileId || extractDriveFileId(track.url);
  if (!driveFileId) {
    return track.url ? [track.url] : [];
  }

  return [
    buildDriveProxyUrl(driveFileId),
    `https://drive.googleusercontent.com/uc?id=${driveFileId}&export=download`,
    `https://drive.google.com/uc?export=download&id=${driveFileId}`,
    `https://docs.google.com/uc?export=download&id=${driveFileId}`,
  ];
}

function probeAudioDuration(url, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    let settled = false;

    const clearSource = () => {
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch {
        // ignore teardown errors from detached audio element
      }
    };

    const finish = (value, hasError = false) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      audio.removeEventListener('loadedmetadata', handleDurationReady);
      audio.removeEventListener('durationchange', handleDurationReady);
      audio.removeEventListener('canplay', handleDurationReady);
      audio.removeEventListener('error', handleError);
      clearSource();

      if (hasError) {
        reject(value);
        return;
      }

      resolve(value);
    };

    const handleDurationReady = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        return;
      }

      finish(audio.duration, false);
    };

    const handleError = () => {
      finish(new Error('Erro ao carregar metadados da trilha.'), true);
    };

    const timeoutId = setTimeout(() => {
      finish(new Error('Tempo limite ao carregar metadados da trilha.'), true);
    }, timeoutMs);

    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', handleDurationReady);
    audio.addEventListener('durationchange', handleDurationReady);
    audio.addEventListener('canplay', handleDurationReady);
    audio.addEventListener('error', handleError);
    audio.src = url;
    audio.load();
  });
}

async function resolveTrackDurationLabel(track) {
  const candidates = getTrackSourceCandidates(track);

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const seconds = await probeAudioDuration(candidate);
      const label = formatTime(seconds);
      if (isKnownDurationLabel(label)) {
        return label;
      }
    } catch {
      // try next candidate
    }
  }

  return '';
}

function buildDownloadFileName(trackName) {
  const baseName = (trackName || 'trilha')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .replace(/\s+/g, '_');

  return `${baseName || 'trilha'}.mp3`;
}

function getTrackDownloadUrl(track) {
  if (!track) {
    return '';
  }

  const driveFileId = track.driveFileId || extractDriveFileId(track.url);
  if (driveFileId) {
    return buildDriveProxyUrl(driveFileId, {
      download: true,
      filename: buildDownloadFileName(track.name),
    });
  }

  return track.url || '';
}

export default function App() {
  const [shows, setShows] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dbError, setDbError] = useState('');
  const [view, setView] = useState('dashboard');
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentSourceIndex, setCurrentSourceIndex] = useState(0);
  const [isRepeatEnabled, setIsRepeatEnabled] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [toast, setToast] = useState(null);
  const [isAddThemeOpen, setIsAddThemeOpen] = useState(false);
  const [isAddTrackModalOpen, setIsAddTrackModalOpen] = useState(false);
  const [isThemePickerOpen, setIsThemePickerOpen] = useState(false);
  const [themePickerSearch, setThemePickerSearch] = useState('');
  const [manageThemeQuery, setManageThemeQuery] = useState('');
  const [manageThemeId, setManageThemeId] = useState('');
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [isClosePlayerDialogOpen, setIsClosePlayerDialogOpen] = useState(false);
  const [themePendingRename, setThemePendingRename] = useState(null);
  const [themePendingDelete, setThemePendingDelete] = useState(null);
  const [trackPendingEdit, setTrackPendingEdit] = useState(null);
  const [trackPendingDelete, setTrackPendingDelete] = useState(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [newShowTitle, setNewShowTitle] = useState('');
  const [newTrackNameInput, setNewTrackNameInput] = useState('');
  const [newTrackUrlInput, setNewTrackUrlInput] = useState('');
  const [newTrackFile, setNewTrackFile] = useState(null);
  const [isAddTrackFileDragActive, setIsAddTrackFileDragActive] = useState(false);
  const [isTrackModalSubmitting, setIsTrackModalSubmitting] = useState(false);
  const [isTrackUploadInProgress, setIsTrackUploadInProgress] = useState(false);
  const [trackUploadProgress, setTrackUploadProgress] = useState(0);
  const [renameThemeInput, setRenameThemeInput] = useState('');

  const audioRef = useRef(null);
  const sourceCandidatesRef = useRef([]);
  const sourceIndexRef = useRef(0);
  const passwordInputRef = useRef(null);
  const toastTimeoutRef = useRef(null);
  const durationProbeAttemptedRef = useRef(new Set());
  const durationProbeRunningRef = useRef(false);
  const addTrackDropDepthRef = useRef(0);
  const addTrackFileInputRef = useRef(null);
  const trackModalSubmitLockRef = useRef(false);

  const allTracks = useMemo(
    () =>
      shows.flatMap((show) =>
        (show.tracks || []).map((track) => ({
          ...track,
          showId: show.id,
          showTitle: show.title,
        })),
      ),
    [shows],
  );

  const currentTrackIndex = useMemo(() => {
    if (!currentTrack) {
      return -1;
    }

    return allTracks.findIndex((track) => track.id === currentTrack.id);
  }, [allTracks, currentTrack]);

  const progressPercent = useMemo(() => {
    if (!duration) {
      return 0;
    }

    return Math.min((currentTime / duration) * 100, 100);
  }, [currentTime, duration]);

  const trackSourceCandidates = useMemo(
    () => getTrackSourceCandidates(currentTrack),
    [currentTrack],
  );

  const currentSourceUrl = trackSourceCandidates[currentSourceIndex] || '';

  const filteredShows = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return shows.filter((show) => {
      if (!normalizedSearch) {
        return true;
      }

      const matchesShow = show.title.toLowerCase().includes(normalizedSearch);
      const matchesTrack = (show.tracks || []).some((track) =>
        track.name.toLowerCase().includes(normalizedSearch),
      );

      return matchesShow || matchesTrack;
    });
  }, [searchTerm, shows]);

  const filteredManageThemes = useMemo(() => {
    const normalizedSearch = themePickerSearch.trim().toLowerCase();

    if (!normalizedSearch) {
      return shows;
    }

    return shows.filter((show) => show.title.toLowerCase().includes(normalizedSearch));
  }, [shows, themePickerSearch]);

  const activeManageTheme = useMemo(() => {
    const selected = shows.find((show) => String(show.id) === manageThemeId);
    if (selected) {
      return selected;
    }

    return shows[0] || null;
  }, [manageThemeId, shows]);

  const themePendingRenameTracks = useMemo(() => {
    if (!themePendingRename) {
      return [];
    }

    const selectedTheme = shows.find((show) => show.id === themePendingRename.id);
    return selectedTheme?.tracks || [];
  }, [shows, themePendingRename]);

  const isTrackEditMode = Boolean(trackPendingEdit);

  const showToast = useCallback((type, message, duration = 3200) => {
    if (!message) {
      return;
    }

    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }

    const toastId = Date.now();
    setToast({ id: toastId, type, message });

    toastTimeoutRef.current = setTimeout(() => {
      setToast((currentValue) => (currentValue?.id === toastId ? null : currentValue));
      toastTimeoutRef.current = null;
    }, duration);
  }, []);

  const handleUppercaseFieldChange = useCallback((event, setValue) => {
    const inputElement = event.target;
    const rawValue = inputElement.value;
    const nextValue = rawValue.toUpperCase();
    const { selectionStart, selectionEnd } = inputElement;

    setValue(nextValue);

    requestAnimationFrame(() => {
      if (document.activeElement !== inputElement) {
        return;
      }

      const nextSelectionStart = Number.isInteger(selectionStart) ? selectionStart : nextValue.length;
      const nextSelectionEnd = Number.isInteger(selectionEnd) ? selectionEnd : nextSelectionStart;
      inputElement.setSelectionRange(nextSelectionStart, nextSelectionEnd);
    });
  }, []);

  const applyTrackDuration = useCallback((trackId, nextDurationLabel) => {
    if (!Number.isFinite(Number(trackId)) || !isKnownDurationLabel(nextDurationLabel)) {
      return;
    }

    setCurrentTrack((currentValue) =>
      currentValue && Number(currentValue.id) === Number(trackId)
        ? {
            ...currentValue,
            duration: nextDurationLabel,
          }
        : currentValue,
    );

    setShows((currentShows) =>
      currentShows.map((show) => ({
        ...show,
        tracks: (show.tracks || []).map((track) =>
          Number(track.id) === Number(trackId) && track.duration !== nextDurationLabel
            ? {
                ...track,
                duration: nextDurationLabel,
              }
            : track,
        ),
      })),
    );

    apiRequest(`/tracks/${trackId}/duration`, {
      method: 'PUT',
      body: { duration: nextDurationLabel },
    }).catch(() => {});
  }, []);

  const loadThemes = useCallback(async () => {
    setIsLoading(true);
    setDbError('');

    try {
      const data = await apiRequest('/themes');
      setShows(Array.isArray(data) ? data : []);
    } catch (error) {
      setDbError(error.message || 'Não foi possível carregar os dados do banco MySQL.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const playTrackByIndex = useCallback(
    (index) => {
      if (!allTracks.length) {
        return;
      }

      const wrappedIndex = (index + allTracks.length) % allTracks.length;
      setCurrentTrack(allTracks[wrappedIndex]);
      setCurrentSourceIndex(0);
      setIsPlaying(true);
      setCurrentTime(0);
      setDuration(0);
      setAudioError('');
    },
    [allTracks],
  );

  const playNextTrack = useCallback(() => {
    if (currentTrackIndex === -1) {
      playTrackByIndex(0);
      return;
    }

    playTrackByIndex(currentTrackIndex + 1);
  }, [currentTrackIndex, playTrackByIndex]);

  const playPreviousTrack = useCallback(() => {
    if (currentTrackIndex === -1) {
      playTrackByIndex(0);
      return;
    }

    playTrackByIndex(currentTrackIndex - 1);
  }, [currentTrackIndex, playTrackByIndex]);

  const handlePlayTrack = (track, showTitle, showId) => {
    const selectedTrack = { ...track, showTitle, showId };

    if (currentTrack?.id === selectedTrack.id) {
      setIsPlaying((currentValue) => !currentValue);
      return;
    }

    setCurrentTrack(selectedTrack);
    setCurrentSourceIndex(0);
    setIsPlaying(true);
    setCurrentTime(0);
    setDuration(0);
    setAudioError('');
  };

  const togglePlayback = () => {
    if (!currentTrack) {
      if (allTracks.length > 0) {
        playTrackByIndex(0);
      }
      return;
    }

    if (!currentSourceUrl) {
      setAudioError('Essa trilha não possui URL de áudio configurada.');
      return;
    }

    setIsPlaying((currentValue) => !currentValue);
  };

  const handleChangeView = useCallback(
    (nextView) => {
      if (nextView !== 'upload') {
        setView(nextView);
        return;
      }

      if (view === 'upload') {
        return;
      }

      setPasswordInput('');
      setPasswordError('');
      setIsPasswordDialogOpen(true);
    },
    [view],
  );

  const handleClosePasswordDialog = () => {
    setIsPasswordDialogOpen(false);
    setPasswordInput('');
    setPasswordError('');
  };

  const handlePasswordSubmit = (event) => {
    event.preventDefault();

    if (passwordInput.trim() === UPLOAD_PASSWORD) {
      setView('upload');
      handleClosePasswordDialog();
      return;
    }

    setPasswordError('Senha incorreta. Tente novamente.');
  };

  const handleClosePlayer = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }

    setIsPlaying(false);
    setCurrentTrack(null);
    setCurrentTime(0);
    setDuration(0);
    setCurrentSourceIndex(0);
    setAudioError('');
  };

  const handleConfirmClosePlayer = () => {
    handleClosePlayer();
    setIsClosePlayerDialogOpen(false);
  };

  const handleRequestClosePlayer = () => {
    setIsClosePlayerDialogOpen(true);
  };

  const handleCancelClosePlayerDialog = () => {
    setIsClosePlayerDialogOpen(false);
  };

  const toggleRepeat = () => {
    setIsRepeatEnabled((currentValue) => !currentValue);
  };

  const toggleMute = () => {
    setIsMuted((currentValue) => !currentValue);
  };

  const handleSeek = (ratio) => {
    const audio = audioRef.current;

    if (!audio || !duration) {
      return;
    }

    const normalizedRatio = Math.min(Math.max(ratio, 0), 1);
    const nextTime = normalizedRatio * duration;

    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const handleOpenThemePicker = () => {
    setThemePickerSearch('');
    setIsThemePickerOpen(true);
  };

  const handleCloseThemePicker = () => {
    setThemePickerSearch('');
    setIsThemePickerOpen(false);
  };

  const handleSelectManageTheme = (show) => {
    setManageThemeId(String(show.id));
    setManageThemeQuery(show.title);
    setThemePickerSearch('');
    setIsThemePickerOpen(false);
  };

  const createTrackFromPublicLink = useCallback(
    async ({ themeId, trackNameInput, rawUrlInput }) => {
      const trackName = String(trackNameInput || '').trim().toUpperCase();
      const rawUrl = String(rawUrlInput || '').trim();
      const normalizedUrl = normalizeAudioUrl(rawUrl);
      const driveFileId = extractDriveFileId(rawUrl);
      const isDriveUrl = /(?:^https?:\/\/)?(?:www\.)?(?:drive|docs)\.google\.com/i.test(rawUrl);

      if (!Number.isFinite(themeId) || themeId <= 0) {
        throw new Error('Selecione um tema válido.');
      }

      if (!trackName || !normalizedUrl) {
        throw new Error('Preencha tema, nome da trilha e URL pública válida.');
      }

      if (isDriveUrl && !driveFileId) {
        throw new Error('Use o link do arquivo do Google Drive (não o link da pasta).');
      }

      return apiRequest(`/themes/${themeId}/tracks`, {
        method: 'POST',
        body: {
          name: trackName,
          duration: '--:--',
          url: normalizedUrl,
          driveFileId: driveFileId || null,
          source: 'drive-link',
        },
      });
    },
    [],
  );

  const createTrackFromUploadedFile = useCallback(async ({ themeId, trackNameInput, file, onProgress }) => {
    if (!Number.isFinite(themeId) || themeId <= 0) {
      throw new Error('Selecione um tema válido.');
    }

    if (!file) {
      throw new Error('Selecione um arquivo MP3 ou WAV para enviar.');
    }

    if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
      throw new Error('Arquivo excede o limite de 100 MB.');
    }

    if (!isAllowedAudioFile(file)) {
      throw new Error('Formato inválido. Envie apenas arquivos MP3 ou WAV.');
    }

    const trackName = String(trackNameInput || '').trim().toUpperCase();
    if (!trackName) {
      throw new Error('Informe o nome da trilha para enviar arquivo.');
    }

    const formData = new FormData();
    formData.append('name', trackName);
    formData.append('file', file);

    return apiUploadRequest(`/themes/${themeId}/tracks/upload`, formData, 'POST', onProgress);
  }, []);

  const updateTrackFromUploadedFile = useCallback(async ({ trackId, trackNameInput, file, onProgress }) => {
    if (!Number.isFinite(trackId) || trackId <= 0) {
      throw new Error('Trilha inválida.');
    }

    if (!file) {
      throw new Error('Selecione um arquivo MP3 ou WAV para enviar.');
    }

    if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
      throw new Error('Arquivo excede o limite de 100 MB.');
    }

    if (!isAllowedAudioFile(file)) {
      throw new Error('Formato inválido. Envie apenas arquivos MP3 ou WAV.');
    }

    const trackName = String(trackNameInput || '').trim().toUpperCase();
    if (!trackName) {
      throw new Error('Informe o nome da trilha para enviar arquivo.');
    }

    const formData = new FormData();
    formData.append('name', trackName);
    formData.append('file', file);

    try {
      return await apiUploadRequest(`/tracks/${trackId}/upload`, formData, 'PUT', onProgress);
    } catch {
      return apiUploadRequest(`/tracks/${trackId}/upload`, formData, 'POST', onProgress);
    }
  }, []);

  const handleAddTrackFilePicked = useCallback(
    (file) => {
      if (!file) {
        return;
      }

      if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
        showToast('error', 'Arquivo excede o limite de 100 MB.');
        return;
      }

      if (!isAllowedAudioFile(file)) {
        showToast('error', 'Formato inválido. Envie apenas arquivos MP3 ou WAV.');
        return;
      }

      setNewTrackFile(file);
    },
    [showToast],
  );

  const handleAddTrackFileInputChange = useCallback(
    (event) => {
      const selectedFile = event.target.files?.[0] || null;
      handleAddTrackFilePicked(selectedFile);
    },
    [handleAddTrackFilePicked],
  );

  const handleTriggerAddTrackFileDialog = useCallback(() => {
    addTrackFileInputRef.current?.click();
  }, []);

  const handleAddTrackFileDragEnter = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    addTrackDropDepthRef.current += 1;
    setIsAddTrackFileDragActive(true);
  }, []);

  const handleAddTrackFileDragOver = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    setIsAddTrackFileDragActive(true);
  }, []);

  const handleAddTrackFileDragLeave = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    addTrackDropDepthRef.current = Math.max(0, addTrackDropDepthRef.current - 1);
    if (addTrackDropDepthRef.current === 0) {
      setIsAddTrackFileDragActive(false);
    }
  }, []);

  const handleAddTrackFileDrop = useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      addTrackDropDepthRef.current = 0;
      setIsAddTrackFileDragActive(false);
      const droppedFile = event.dataTransfer?.files?.[0] || null;
      handleAddTrackFilePicked(droppedFile);
    },
    [handleAddTrackFilePicked],
  );

  const handleOpenAddTrackModal = () => {
    if (!activeManageTheme) {
      showToast('error', 'Selecione um tema para adicionar a trilha.');
      return;
    }

    setTrackPendingEdit(null);
    setNewTrackNameInput('');
    setNewTrackUrlInput('');
    setNewTrackFile(null);
    setIsAddTrackFileDragActive(false);
    setIsTrackModalSubmitting(false);
    setIsTrackUploadInProgress(false);
    setTrackUploadProgress(0);
    trackModalSubmitLockRef.current = false;
    addTrackDropDepthRef.current = 0;
    setIsAddTrackModalOpen(true);
  };

  const handleCloseAddTrackModal = () => {
    setIsAddTrackModalOpen(false);
    setTrackPendingEdit(null);
    setNewTrackNameInput('');
    setNewTrackUrlInput('');
    setNewTrackFile(null);
    setIsAddTrackFileDragActive(false);
    setIsTrackModalSubmitting(false);
    setIsTrackUploadInProgress(false);
    setTrackUploadProgress(0);
    trackModalSubmitLockRef.current = false;
    addTrackDropDepthRef.current = 0;
  };

  const handleConfirmAddTrackModal = async (event) => {
    event.preventDefault();

    if (trackModalSubmitLockRef.current) {
      return;
    }

    if (!activeManageTheme) {
      showToast('error', 'Selecione um tema para adicionar a trilha.');
      return;
    }

    const selectedShowId = Number(activeManageTheme.id);
    const hasFileInput = Boolean(newTrackFile);
    const hasUrlInput = Boolean(String(newTrackUrlInput || '').trim());
    const updateUploadProgress = (value) => setTrackUploadProgress(Math.max(0, Math.min(100, Number(value) || 0)));

    trackModalSubmitLockRef.current = true;
    setIsTrackModalSubmitting(true);
    setIsTrackUploadInProgress(hasFileInput);
    setTrackUploadProgress(hasFileInput ? 0 : 0);

    try {
      if (isTrackEditMode) {
        const trackName = newTrackNameInput.trim().toUpperCase();

        if (!trackName) {
          showToast('error', 'Informe o nome da trilha.');
          return;
        }

        let updatedTrack;
        if (hasFileInput) {
          updatedTrack = await updateTrackFromUploadedFile({
            trackId: Number(trackPendingEdit.id),
            trackNameInput: trackName,
            file: newTrackFile,
            onProgress: updateUploadProgress,
          });
        } else {
          const rawUrlInput = newTrackUrlInput.trim();
          const rawUrl = rawUrlInput || String(trackPendingEdit?.url || '').trim();
          const isDriveUrl = /(?:^https?:\/\/)?(?:www\.)?(?:drive|docs)\.google\.com/i.test(rawUrl);
          const driveFileId = rawUrlInput
            ? extractDriveFileId(rawUrl)
            : (trackPendingEdit?.driveFileId || extractDriveFileId(rawUrl));
          const normalizedUrl = rawUrlInput ? normalizeAudioUrl(rawUrl) : rawUrl;

          if (!normalizedUrl) {
            showToast('error', 'Preencha URL pública válida ou selecione um arquivo.');
            return;
          }

          if (rawUrlInput && isDriveUrl && !driveFileId) {
            showToast('error', 'Use o link do arquivo do Google Drive (não o link da pasta).');
            return;
          }

          const updatePayload = {
            name: trackName,
            url: normalizedUrl,
            driveFileId: driveFileId || null,
          };

          try {
            updatedTrack = await apiRequest(`/tracks/${trackPendingEdit.id}`, {
              method: 'PUT',
              body: updatePayload,
            });
          } catch {
            updatedTrack = await apiRequest(`/tracks/${trackPendingEdit.id}/update`, {
              method: 'POST',
              body: updatePayload,
            });
          }
        }

        setShows((currentShows) =>
          currentShows.map((show) => ({
            ...show,
            tracks: (show.tracks || []).map((track) =>
              track.id === updatedTrack.id
                ? {
                    ...track,
                    ...updatedTrack,
                  }
                : track,
            ),
          })),
        );

        setCurrentTrack((currentTrackValue) => {
          if (!currentTrackValue || currentTrackValue.id !== updatedTrack.id) {
            return currentTrackValue;
          }

          return {
            ...currentTrackValue,
            ...updatedTrack,
            showTitle: currentTrackValue.showTitle,
            showId: currentTrackValue.showId,
          };
        });

        if (currentTrack?.id === updatedTrack.id) {
          setCurrentSourceIndex(0);
          setCurrentTime(0);
          setDuration(0);
        }

        showToast('success', `Trilha "${updatedTrack.name}" atualizada com sucesso.`);
        handleCloseAddTrackModal();
        return;
      }

      if (hasFileInput && hasUrlInput) {
        showToast('error', 'Escolha apenas um método: arquivo de áudio ou URL pública.');
        return;
      }

      if (!hasFileInput && !hasUrlInput) {
        showToast('error', 'Selecione um arquivo de áudio ou informe a URL pública do arquivo.');
        return;
      }

      const createdTrack = hasFileInput
        ? await createTrackFromUploadedFile({
            themeId: selectedShowId,
            trackNameInput: newTrackNameInput,
            file: newTrackFile,
            onProgress: updateUploadProgress,
          })
        : await createTrackFromPublicLink({
            themeId: selectedShowId,
            trackNameInput: newTrackNameInput,
            rawUrlInput: newTrackUrlInput,
          });

      setShows((currentShows) =>
        currentShows.map((show) =>
          show.id === selectedShowId
            ? {
                ...show,
                tracks: [createdTrack, ...(show.tracks || [])],
              }
            : show,
        ),
      );

      handleCloseAddTrackModal();
      showToast('success', `Trilha "${createdTrack.name}" adicionada em ${activeManageTheme.title}.`);
    } catch (error) {
      showToast('error', error.message || 'Não foi possível salvar a trilha no banco MySQL.');
    } finally {
      setIsTrackModalSubmitting(false);
      setIsTrackUploadInProgress(false);
      setTrackUploadProgress(0);
      trackModalSubmitLockRef.current = false;
    }
  };

  const handleCreateShow = async (event) => {
    event.preventDefault();

    const title = newShowTitle.trim().toUpperCase();

    if (!title) {
      showToast('error', 'Informe o nome para criar o tema.');
      return;
    }

    try {
      const createdTheme = await apiRequest('/themes', {
        method: 'POST',
        body: { title },
      });

      setShows((currentShows) => [createdTheme, ...currentShows]);
      setManageThemeId(String(createdTheme.id));
      setManageThemeQuery(createdTheme.title);
      setNewShowTitle('');
      setIsAddThemeOpen(false);
      showToast('success', `Tema "${createdTheme.title}" criado com sucesso.`);
    } catch (error) {
      showToast('error', error.message || 'Não foi possível criar tema no banco MySQL.');
    }
  };

  const handleRequestRenameTheme = (show) => {
    setThemePendingRename({
      id: show.id,
      title: show.title,
    });
    setRenameThemeInput(show.title || '');
  };

  const handleCancelRenameThemeDialog = () => {
    setThemePendingRename(null);
    setRenameThemeInput('');
  };

  const handleConfirmRenameTheme = async (event) => {
    event.preventDefault();

    if (!themePendingRename) {
      return;
    }

    const title = renameThemeInput.trim().toUpperCase();
    if (!title) {
      showToast('error', 'Informe um nome válido para o tema.');
      return;
    }

    const show = themePendingRename;

    try {
      const updatedTheme = await apiRequest(`/themes/${show.id}`, {
        method: 'PUT',
        body: { title },
      });

      setShows((currentShows) =>
        currentShows.map((currentShow) =>
          currentShow.id === show.id
            ? {
                ...currentShow,
                title: updatedTheme.title,
              }
            : currentShow,
        ),
      );

      setCurrentTrack((currentTrackValue) => {
        if (!currentTrackValue || currentTrackValue.showId !== show.id) {
          return currentTrackValue;
        }

        return {
          ...currentTrackValue,
          showTitle: updatedTheme.title,
        };
      });

      if (String(show.id) === manageThemeId) {
        setManageThemeQuery(updatedTheme.title);
      }
      setManageThemeId(String(show.id));

      showToast('success', `Tema renomeado para "${updatedTheme.title}".`);
      handleCancelRenameThemeDialog();
    } catch (error) {
      showToast('error', error.message || 'Não foi possível editar o tema.');
    }
  };

  const handleRequestDeleteTheme = (show) => {
    setThemePendingDelete({
      id: show.id,
      title: show.title,
    });
  };

  const handleCancelDeleteThemeDialog = () => {
    setThemePendingDelete(null);
  };

  const handleConfirmDeleteTheme = async () => {
    if (!themePendingDelete) {
      return;
    }

    const show = themePendingDelete;

    try {
      await apiRequest(`/themes/${show.id}`, {
        method: 'DELETE',
      });

      setShows((currentShows) => currentShows.filter((currentShow) => currentShow.id !== show.id));

      if (currentTrack?.showId === show.id) {
        handleClosePlayer();
      }

      showToast('success', `Tema "${show.title}" excluído com sucesso.`);
    } catch (error) {
      showToast('error', error.message || 'Não foi possível excluir o tema.');
    } finally {
      setThemePendingDelete(null);
    }
  };

  const handleRequestEditTrack = (track) => {
    const trackUrl = String(track?.url || '').trim();
    const trackPublicUrl = String(track?.publicUrl ?? '').trim();
    const isLocalUploadSource = String(track?.source || '').toLowerCase() === 'local-upload';
    const isLocalUploadUrl = /^\/uploads\//i.test(trackUrl) || /\/uploads\//i.test(trackUrl);
    const nextPublicUrl = trackPublicUrl || (isLocalUploadSource || isLocalUploadUrl ? '' : trackUrl);

    setTrackPendingEdit(track);
    setNewTrackNameInput(track.name || '');
    setNewTrackUrlInput(nextPublicUrl);
    setNewTrackFile(null);
    setIsAddTrackFileDragActive(false);
    setIsTrackModalSubmitting(false);
    setIsTrackUploadInProgress(false);
    setTrackUploadProgress(0);
    trackModalSubmitLockRef.current = false;
    addTrackDropDepthRef.current = 0;
    setIsAddTrackModalOpen(true);
  };

  const handleRequestDeleteTrack = (track) => {
    setTrackPendingDelete(track);
  };

  const handleCancelDeleteTrackDialog = () => {
    setTrackPendingDelete(null);
  };

  const handleConfirmDeleteTrack = async () => {
    if (!trackPendingDelete) {
      return;
    }

    try {
      try {
        await apiRequest(`/tracks/${trackPendingDelete.id}`, {
          method: 'DELETE',
        });
      } catch {
        await apiRequest(`/tracks/${trackPendingDelete.id}/delete`, {
          method: 'POST',
        });
      }

      setShows((currentShows) =>
        currentShows.map((show) => ({
          ...show,
          tracks: (show.tracks || []).filter((track) => track.id !== trackPendingDelete.id),
        })),
      );

      if (currentTrack?.id === trackPendingDelete.id) {
        handleClosePlayer();
      }

      showToast('success', `Trilha "${trackPendingDelete.name}" excluída com sucesso.`);
    } catch (error) {
      showToast('error', error.message || 'Não foi possível excluir a trilha.');
    } finally {
      setTrackPendingDelete(null);
    }
  };

  useEffect(() => {
    loadThemes();
  }, [loadThemes]);

  useEffect(
    () => () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (shows.length === 0) {
      setManageThemeId('');
      setManageThemeQuery('');
      return;
    }

    const selectedTheme = shows.find((show) => String(show.id) === manageThemeId);
    if (selectedTheme) {
      if (manageThemeQuery !== selectedTheme.title) {
        setManageThemeQuery(selectedTheme.title);
      }
      return;
    }

    setManageThemeId(String(shows[0].id));
    setManageThemeQuery(shows[0].title);
  }, [manageThemeId, manageThemeQuery, shows]);

  useEffect(() => {
    if (isPasswordDialogOpen) {
      passwordInputRef.current?.focus();
    }
  }, [isPasswordDialogOpen]);

  useEffect(() => {
    if (!currentTrack?.id || !Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const nextDurationLabel = formatTime(duration);
    if (!isKnownDurationLabel(nextDurationLabel) || currentTrack.duration === nextDurationLabel) {
      return;
    }

    applyTrackDuration(currentTrack.id, nextDurationLabel);
  }, [applyTrackDuration, currentTrack, duration]);

  useEffect(() => {
    if (!shows.length || durationProbeRunningRef.current) {
      return;
    }

    const tracksWithoutDuration = shows
      .flatMap((show) => show.tracks || [])
      .filter((track) => track?.id && track?.url && !isKnownDurationLabel(track.duration));

    if (!tracksWithoutDuration.length) {
      return;
    }

    let cancelled = false;
    durationProbeRunningRef.current = true;

    const runDurationProbe = async () => {
      try {
        for (const track of tracksWithoutDuration) {
          if (cancelled) {
            break;
          }

          const probeKey = `${track.id}:${track.url}`;
          if (durationProbeAttemptedRef.current.has(probeKey)) {
            continue;
          }

          durationProbeAttemptedRef.current.add(probeKey);

          const nextDurationLabel = await resolveTrackDurationLabel(track);
          if (!cancelled && isKnownDurationLabel(nextDurationLabel)) {
            applyTrackDuration(track.id, nextDurationLabel);
          }
        }
      } finally {
        durationProbeRunningRef.current = false;
      }
    };

    runDurationProbe();

    return () => {
      cancelled = true;
    };
  }, [applyTrackDuration, shows]);

  useEffect(() => {
    sourceCandidatesRef.current = trackSourceCandidates;
  }, [trackSourceCandidates]);

  useEffect(() => {
    sourceIndexRef.current = currentSourceIndex;
  }, [currentSourceIndex]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleLoadedMetadata = () => setDuration(audio.duration || 0);
    const handleEnded = () => {
      if (isRepeatEnabled) {
        audio.currentTime = 0;
        setCurrentTime(0);
        setIsPlaying(true);
        audio.play().catch(() => {
          setIsPlaying(false);
        });
        return;
      }

      playNextTrack();
    };
    const handleError = () => {
      const canTryNextSource = sourceIndexRef.current < sourceCandidatesRef.current.length - 1;

      if (canTryNextSource) {
        setCurrentSourceIndex((currentValue) => currentValue + 1);
        return;
      }

      setAudioError(
        'Não foi possível reproduzir essa trilha. Verifique se o link está público no Google Drive.',
      );
      setIsPlaying(false);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
    };
  }, [isRepeatEnabled, playNextTrack]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    if (!currentSourceUrl) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      return;
    }

    audio.src = currentSourceUrl;
    audio.load();
  }, [currentSourceUrl]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio || !currentSourceUrl) {
      return;
    }

    if (isPlaying) {
      audio.play().catch((error) => {
        if (error?.name === 'NotAllowedError') {
          setIsPlaying(false);
          return;
        }

        const canTryNextSource = currentSourceIndex < trackSourceCandidates.length - 1;
        if (canTryNextSource) {
          setCurrentSourceIndex((currentValue) => currentValue + 1);
          return;
        }

        setAudioError(
          'Não foi possível iniciar a reprodução desta trilha. Confira permissões do link no Drive.',
        );
        setIsPlaying(false);
      });
      return;
    }

    audio.pause();
  }, [currentSourceIndex, currentSourceUrl, isPlaying, trackSourceCandidates.length]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.muted = isMuted;
  }, [isMuted]);

  return (
    <Layout
      activeView={view}
      onChangeView={handleChangeView}
      searchTerm={searchTerm}
      onSearchChange={setSearchTerm}
    >
      <div className="dashboard">
        {dbError && (
          <p className="audio-alert">
            {dbError}{' '}
            <button className="retry-link" onClick={loadThemes}>
              Tentar novamente
            </button>
          </p>
        )}
        {audioError && <p className="audio-alert">{audioError}</p>}

        {view === 'upload' ? (
          <section className="upload-panel reveal">
            <div className="theme-management-panel">
              <div className="theme-management-header-row">
                <h3 className="theme-management-title">GERENCIAR TEMAS</h3>
                <button
                  type="button"
                  className="button button-primary theme-header-add-button"
                  onClick={() => setIsAddThemeOpen(true)}
                >
                  <Plus size={15} />
                  Inserir Tema
                </button>
              </div>
              <div className="theme-management-body">
                {shows.length === 0 ? (
                  <p className="theme-management-empty">Nenhum tema cadastrado.</p>
                ) : (
                  <div className="theme-management-controls">
                    <div className="theme-selector-row">
                      <button
                        type="button"
                        className="theme-picker-trigger"
                        onClick={handleOpenThemePicker}
                      >
                        <span>{activeManageTheme?.title || manageThemeQuery || 'Selecionar tema'}</span>
                      </button>

                      <div className="theme-management-actions-bottom">
                        <button
                          type="button"
                          className="button button-subtle icon-only"
                          disabled={!activeManageTheme}
                          onClick={() => activeManageTheme && handleRequestRenameTheme(activeManageTheme)}
                          aria-label="Editar tema"
                          title="Editar tema"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          className="button button-danger icon-only"
                          disabled={!activeManageTheme}
                          onClick={() => activeManageTheme && handleRequestDeleteTheme(activeManageTheme)}
                          aria-label="Excluir tema"
                          title="Excluir tema"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>

                    {activeManageTheme && (
                      <p className="theme-management-meta">
                        {(activeManageTheme.tracks || []).length} trilha(s) no tema selecionado.
                      </p>
                    )}

                    {activeManageTheme && (
                      <div className="theme-track-preview">
                        <h4 className="theme-track-preview-title">Trilhas deste tema:</h4>
                        <div className="theme-track-preview-create-row">
                          <button
                            type="button"
                            className="button button-primary icon-only theme-track-preview-create"
                            onClick={handleOpenAddTrackModal}
                            aria-label="Adicionar trilha neste tema"
                            title="Adicionar trilha"
                          >
                            <Plus size={18} />
                          </button>
                        </div>

                        {(activeManageTheme.tracks || []).length === 0 ? (
                          <p className="theme-management-empty">Nenhuma trilha cadastrada neste tema.</p>
                        ) : (
                          <ul className="theme-track-preview-list">
                            {(activeManageTheme.tracks || []).map((track) => (
                              <li key={track.id} className="theme-track-preview-item">
                                  <div className="theme-track-preview-head">
                                    <div className="theme-track-preview-title-wrap">
                                      <strong>{track.name}</strong>
                                    </div>
                                    <div className="theme-track-preview-actions">
                                    <button
                                      type="button"
                                      className="button button-subtle icon-only"
                                      onClick={() => handleRequestEditTrack(track)}
                                      aria-label={`Editar ${track.name}`}
                                      title="Editar trilha"
                                    >
                                      <Pencil size={13} />
                                    </button>
                                    <button
                                      type="button"
                                      className="button button-danger icon-only"
                                      onClick={() => handleRequestDeleteTrack(track)}
                                      aria-label={`Excluir ${track.name}`}
                                      title="Excluir trilha"
                                    >
                                      <Trash2 size={13} />
                                    </button>
                                  </div>
                                </div>
                                <a
                                  href={track.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="theme-track-preview-link"
                                  title={track.url}
                                >
                                  {track.url}
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : (
          <section className="shows-section reveal">
            <header className="section-header">
              <h2>Temas Trilhas</h2>
            </header>

            {isLoading ? (
              <div className="empty-state">
                <h3>Carregando temas...</h3>
              </div>
            ) : filteredShows.length === 0 ? (
              <div className="empty-state">
                <h3>{shows.length === 0 ? 'Nenhum tema cadastrado' : 'Nenhum tema encontrado'}</h3>
                <p>
                  {shows.length === 0
                    ? 'Cadastre seu primeiro tema na página Upload de Trilhas.'
                    : 'Tente ajustar a busca por título ou trilha.'}
                </p>
              </div>
            ) : (
              <div className="shows-grid">
                {filteredShows.map((show) => (
                  <article className="show-card" key={show.id}>
                    <div className="show-content">
                      <h3>{show.title}</h3>
                      <ul className="track-list">
                        {(show.tracks || []).map((track) => {
                          const isCurrent = currentTrack?.id === track.id;
                          const downloadName = buildDownloadFileName(track.name);
                          const downloadUrl = getTrackDownloadUrl(track);

                          return (
                            <li key={track.id} className="track-row">
                              <button
                                className={`track-item ${isCurrent ? 'active' : ''}`}
                                onClick={() => handlePlayTrack(track, show.title, show.id)}
                              >
                                <span className="track-main">
                                  <span className="track-icon">
                                    {isCurrent && isPlaying ? <Pause size={13} /> : <Play size={13} />}
                                  </span>
                                  <span className="track-name">{track.name}</span>
                                </span>
                              </button>
                              {downloadUrl ? (
                                <a
                                  className="track-download"
                                  href={downloadUrl}
                                  download={downloadName}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`Baixar ${track.name}`}
                                  title="Download da trilha"
                                >
                                  <Download size={14} />
                                </a>
                              ) : (
                                <button
                                  className="track-download disabled"
                                  type="button"
                                  disabled
                                  aria-label="Download indisponível"
                                >
                                  <Download size={14} />
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {toast && (
        <div className="toast-stack" aria-live="polite" aria-atomic="true">
          <div className={`toast-item ${toast.type === 'success' ? 'success' : 'error'}`} role="status">
            {toast.message}
          </div>
        </div>
      )}

      {isThemePickerOpen && (
        <div className="password-modal-overlay confirm-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="theme-picker-title">
          <div className="password-modal-card theme-picker-modal-card reveal">
            <h3 id="theme-picker-title" className="password-modal-title">
              Selecionar tema
            </h3>
            <label className="theme-management-search theme-picker-search" htmlFor="theme-picker-search-input">
              <SearchIcon size={14} />
              <input
                id="theme-picker-search-input"
                type="search"
                placeholder="Pesquisar tema"
                value={themePickerSearch}
                onChange={(event) => setThemePickerSearch(event.target.value)}
                autoComplete="off"
              />
            </label>

            {filteredManageThemes.length === 0 ? (
              <p className="theme-management-empty">Nenhum tema encontrado para essa busca.</p>
            ) : (
              <div className="theme-picker-list">
                {filteredManageThemes.map((show) => (
                  <button
                    key={show.id}
                    type="button"
                    className={`theme-picker-item ${String(show.id) === manageThemeId ? 'active' : ''}`}
                    onClick={() => handleSelectManageTheme(show)}
                  >
                    <span>{show.title}</span>
                    <small>{(show.tracks || []).length} trilha(s)</small>
                  </button>
                ))}
              </div>
            )}

            <div className="password-modal-actions">
              <button type="button" className="button button-subtle" onClick={handleCloseThemePicker}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {isAddTrackModalOpen && (
        <div className="password-modal-overlay confirm-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="add-track-title">
          <form className="password-modal-card confirm-modal-card reveal add-track-modal-card" onSubmit={handleConfirmAddTrackModal}>
            <div className="add-track-modal-header">
              <h3 id="add-track-title" className="password-modal-title add-track-modal-title">
                {isTrackEditMode ? 'Editar trilha' : 'Adicionar trilha'}
              </h3>
              <button
                type="button"
                className="add-track-modal-close"
                onClick={handleCloseAddTrackModal}
                disabled={isTrackModalSubmitting}
                aria-label="Fechar modal"
                title="Fechar"
              >
                X
              </button>
            </div>
            <p className="password-modal-subtitle add-track-modal-subtitle">
              {activeManageTheme?.title || 'NÃO INFORMADO'}
            </p>

            <label className="password-modal-label" htmlFor="new-track-name-input">
              Nome da trilha
            </label>
            <input
              id="new-track-name-input"
              className="password-modal-input"
              type="text"
              placeholder="Ex.: FROZEN PARA MENINA..."
              value={newTrackNameInput}
              onChange={(event) => handleUppercaseFieldChange(event, setNewTrackNameInput)}
              disabled={isTrackModalSubmitting}
              autoComplete="off"
            />

            <label className="password-modal-label" htmlFor="new-track-file-input">
              Arquivo de áudio
            </label>
            <div
              className={`add-track-dropzone ${isAddTrackFileDragActive ? 'active' : ''}`}
              onDragEnter={!isTrackModalSubmitting ? handleAddTrackFileDragEnter : undefined}
              onDragOver={!isTrackModalSubmitting ? handleAddTrackFileDragOver : undefined}
              onDragLeave={!isTrackModalSubmitting ? handleAddTrackFileDragLeave : undefined}
              onDrop={!isTrackModalSubmitting ? handleAddTrackFileDrop : undefined}
            >
              <input
                id="new-track-file-input"
                ref={addTrackFileInputRef}
                className="password-modal-file-input-hidden"
                type="file"
                accept=".mp3,.wav,audio/mpeg,audio/wav"
                onChange={handleAddTrackFileInputChange}
                disabled={isTrackModalSubmitting}
              />
              <div className="add-track-file-picker-row">
                <button
                  type="button"
                  className="add-track-file-picker-button"
                  onClick={handleTriggerAddTrackFileDialog}
                  disabled={isTrackModalSubmitting}
                >
                  Escolher arquivo
                </button>
                <span className="add-track-file-picker-name">
                  {newTrackFile ? newTrackFile.name : 'Nenhum arquivo escolhido'}
                </span>
              </div>
              <p className="add-track-dropzone-hint">
                {isTrackEditMode
                  ? 'Na edição, você também pode trocar o arquivo da trilha.'
                  : 'Arraste e solte o arquivo aqui ou clique em "Escolher arquivo".'}
              </p>
              {isTrackEditMode && trackPendingEdit && !newTrackFile && (
                <p className="add-track-dropzone-current">
                  Arquivo atual: {getCurrentTrackFileLabel(trackPendingEdit)}
                </p>
              )}
              {newTrackFile && <p className="add-track-dropzone-selected">{newTrackFile.name}</p>}
            </div>
            <p className="password-modal-subtitle">
              Formatos aceitos: MP3 e WAV. Tamanho máximo: 100 MB.
            </p>
            {isTrackUploadInProgress && (
              <div className="add-track-upload-progress" role="status" aria-live="polite">
                <p className="add-track-upload-progress-label">
                  Enviando arquivo... {trackUploadProgress}%
                </p>
                <div className="add-track-upload-progress-track">
                  <span
                    className="add-track-upload-progress-fill"
                    style={{ width: `${Math.max(4, trackUploadProgress)}%` }}
                  />
                </div>
              </div>
            )}

            <div className="add-track-modal-divider" />

            <h4 className="add-track-modal-alt-title">Método Alternativo</h4>
            <label className="password-modal-label" htmlFor="new-track-url-input">
              URL pública do arquivo
            </label>
            <input
              id="new-track-url-input"
              className="password-modal-input"
              type="url"
              placeholder="https://drive.google.com/file/d/SEU_ID/view?usp=sharing"
              value={newTrackUrlInput}
              onChange={(event) => setNewTrackUrlInput(event.target.value)}
              disabled={isTrackModalSubmitting}
              autoComplete="off"
            />

            <div className="password-modal-actions add-track-modal-actions">
              <button type="submit" className="button button-primary add-track-modal-submit" disabled={isTrackModalSubmitting}>
                {isTrackModalSubmitting
                  ? (isTrackUploadInProgress ? `Enviando... ${trackUploadProgress}%` : 'Salvando...')
                  : (isTrackEditMode ? 'Salvar Alteração' : 'Adicionar Trilha')}
              </button>
            </div>
          </form>
        </div>
      )}

      {trackPendingDelete && (
        <div className="password-modal-overlay confirm-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-track-title">
          <div className="password-modal-card confirm-modal-card reveal">
            <h3 id="delete-track-title" className="password-modal-title">
              Excluir trilha
            </h3>
            <p className="password-modal-subtitle">
              Deseja excluir a trilha "{trackPendingDelete.name}"?
            </p>
            <p className="password-modal-subtitle confirm-modal-warning">
              Essa ação não poderá ser desfeita.
            </p>

            <div className="password-modal-actions">
              <button type="button" className="button button-subtle" onClick={handleCancelDeleteTrackDialog}>
                Cancelar
              </button>
              <button type="button" className="button button-danger" onClick={handleConfirmDeleteTrack}>
                Excluir Trilha
              </button>
            </div>
          </div>
        </div>
      )}

      {isPasswordDialogOpen && (
        <div className="password-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="upload-password-title">
          <form className="password-modal-card reveal" onSubmit={handlePasswordSubmit}>
            <h3 id="upload-password-title" className="password-modal-title">
              Acesso Protegido!
            </h3>
            <label className="password-modal-label" htmlFor="upload-password-input">
              Digite a Senha...
            </label>
            <input
              id="upload-password-input"
              ref={passwordInputRef}
              className="password-modal-input"
              type="password"
              value={passwordInput}
              onChange={(event) => {
                setPasswordInput(event.target.value);
                if (passwordError) {
                  setPasswordError('');
                }
              }}
              autoComplete="off"
            />

            {passwordError && <p className="password-modal-error">{passwordError}</p>}

            <div className="password-modal-actions">
              <button type="button" className="button button-subtle" onClick={handleClosePasswordDialog}>
                Cancelar
              </button>
              <button type="submit" className="button button-primary">
                Entrar
              </button>
            </div>
          </form>
        </div>
      )}

      {isClosePlayerDialogOpen && (
        <div className="password-modal-overlay confirm-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="close-player-title">
          <div className="password-modal-card confirm-modal-card reveal">
            <h3 id="close-player-title" className="password-modal-title">
              Fechar player
            </h3>
            <p className="password-modal-subtitle">
              Deseja fechar o player e parar a trilha atual?
            </p>

            <div className="password-modal-actions">
              <button type="button" className="button button-subtle" onClick={handleCancelClosePlayerDialog}>
                Cancelar
              </button>
              <button type="button" className="button button-danger" onClick={handleConfirmClosePlayer}>
                Fechar player
              </button>
            </div>
          </div>
        </div>
      )}

      {themePendingDelete && (
        <div className="password-modal-overlay confirm-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-theme-title">
          <div className="password-modal-card confirm-modal-card reveal">
            <h3 id="delete-theme-title" className="password-modal-title">
              Excluir tema
            </h3>
            <p className="password-modal-subtitle">
              Deseja excluir o tema "{themePendingDelete.title}"?
            </p>
            <p className="password-modal-subtitle confirm-modal-warning">
              Todas as trilhas deste tema serão removidas.
            </p>

            <div className="password-modal-actions">
              <button type="button" className="button button-subtle" onClick={handleCancelDeleteThemeDialog}>
                Cancelar
              </button>
              <button type="button" className="button button-danger" onClick={handleConfirmDeleteTheme}>
                Excluir tema
              </button>
            </div>
          </div>
        </div>
      )}

      {themePendingRename && (
        <div className="password-modal-overlay confirm-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="rename-theme-title">
          <form className="password-modal-card confirm-modal-card reveal add-theme-modal-card" onSubmit={handleConfirmRenameTheme}>
            <h3 id="rename-theme-title" className="password-modal-title">
              Renomear tema
            </h3>
            <label className="password-modal-label" htmlFor="rename-theme-input">
              Novo nome do tema
            </label>
            <input
              id="rename-theme-input"
              className="password-modal-input"
              type="text"
              placeholder="Ex.: Frozen"
              value={renameThemeInput}
              onChange={(event) => handleUppercaseFieldChange(event, setRenameThemeInput)}
              autoComplete="off"
            />

            {themePendingRenameTracks.length > 0 && (
              <div className="rename-theme-track-shortcuts">
                <p className="password-modal-label rename-theme-track-shortcuts-title">
                  Trilhas deste tema
                </p>
                <div className="rename-theme-track-shortcuts-list">
                  {themePendingRenameTracks.map((track) => (
                    <button
                      key={track.id}
                      type="button"
                      className="rename-theme-track-shortcut-item"
                      onClick={() => {
                        handleCancelRenameThemeDialog();
                        handleRequestEditTrack(track);
                      }}
                    >
                      <strong>{track.name}</strong>
                      <small>Editar trilha e trocar arquivo</small>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="password-modal-actions">
              <button type="button" className="button button-subtle" onClick={handleCancelRenameThemeDialog}>
                Cancelar
              </button>
              <button type="submit" className="button button-primary">
                Salvar
              </button>
            </div>
          </form>
        </div>
      )}

      {isAddThemeOpen && (
        <div className="password-modal-overlay confirm-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="create-theme-title">
          <form className="password-modal-card confirm-modal-card reveal add-theme-modal-card" onSubmit={handleCreateShow}>
            <h3 id="create-theme-title" className="password-modal-title">
              Adicionar tema
            </h3>
            <label className="password-modal-label" htmlFor="newShowTitle">
              Nome do tema
            </label>
            <input
              id="newShowTitle"
              className="password-modal-input"
              type="text"
              placeholder="Ex.: Festival Encantado"
              value={newShowTitle}
              onChange={(event) => handleUppercaseFieldChange(event, setNewShowTitle)}
              autoComplete="off"
            />

            <div className="password-modal-actions">
              <button
                type="button"
                className="button button-subtle"
                onClick={() => {
                  setIsAddThemeOpen(false);
                  setNewShowTitle('');
                }}
              >
                Cancelar
              </button>
              <button type="submit" className="button button-primary">
                Adicionar
              </button>
            </div>
          </form>
        </div>
      )}

      <AudioPlayer
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        isRepeatEnabled={isRepeatEnabled}
        isMuted={isMuted}
        onTogglePlay={togglePlayback}
        onToggleRepeat={toggleRepeat}
        onToggleMute={toggleMute}
        onClosePlayer={handleRequestClosePlayer}
        onNextTrack={playNextTrack}
        onPreviousTrack={playPreviousTrack}
        onSeek={handleSeek}
        progressPercent={progressPercent}
        currentTimeLabel={formatTime(currentTime)}
        durationLabel={duration ? formatTime(duration) : currentTrack?.duration || '--:--'}
      />

      <audio ref={audioRef} preload="metadata" />
    </Layout>
  );
}
