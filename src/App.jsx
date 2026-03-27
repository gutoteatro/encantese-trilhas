import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Layout from './components/Layout';
import AudioPlayer from './components/AudioPlayer';
import {
  ChevronDown,
  Download,
  Pause,
  Pencil,
  Play,
  Search as SearchIcon,
  Trash2,
  Upload as UploadIcon,
} from 'lucide-react';

const API_BASE = '/api';
const UPLOAD_PASSWORD = '1234';

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.message || 'Falha na comunicação com o banco de dados.');
  }

  return payload;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
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
  const [audioError, setAudioError] = useState('');
  const [toast, setToast] = useState(null);
  const [isThemeManagementCollapsed, setIsThemeManagementCollapsed] = useState(true);
  const [isTrackUploadCollapsed, setIsTrackUploadCollapsed] = useState(true);
  const [isAddThemeOpen, setIsAddThemeOpen] = useState(false);
  const [manageThemeQuery, setManageThemeQuery] = useState('');
  const [manageThemeId, setManageThemeId] = useState('');
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [isClosePlayerDialogOpen, setIsClosePlayerDialogOpen] = useState(false);
  const [themePendingRename, setThemePendingRename] = useState(null);
  const [themePendingDelete, setThemePendingDelete] = useState(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [newShowTitle, setNewShowTitle] = useState('');
  const [renameThemeInput, setRenameThemeInput] = useState('');
  const [linkForm, setLinkForm] = useState({
    showId: '',
    trackName: '',
    url: '',
  });

  const audioRef = useRef(null);
  const sourceCandidatesRef = useRef([]);
  const sourceIndexRef = useRef(0);
  const passwordInputRef = useRef(null);
  const toastTimeoutRef = useRef(null);

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

  const activeShowId = useMemo(() => {
    const hasSelectedShow = shows.some((show) => String(show.id) === linkForm.showId);
    if (hasSelectedShow) {
      return linkForm.showId;
    }

    return shows[0] ? String(shows[0].id) : '';
  }, [linkForm.showId, shows]);

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
    const normalizedSearch = manageThemeQuery.trim().toLowerCase();

    if (!normalizedSearch) {
      return shows;
    }

    return shows.filter((show) => show.title.toLowerCase().includes(normalizedSearch));
  }, [manageThemeQuery, shows]);

  const activeManageTheme = useMemo(() => {
    const selected = shows.find((show) => String(show.id) === manageThemeId);
    const selectedIsVisible = selected
      ? filteredManageThemes.some((show) => show.id === selected.id)
      : false;

    if (selectedIsVisible) {
      return selected;
    }

    return filteredManageThemes[0] || null;
  }, [filteredManageThemes, manageThemeId, shows]);

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

  const handleManageThemeQueryChange = (nextValue) => {
    setManageThemeQuery(nextValue);

    const normalizedValue = nextValue.trim().toLowerCase();
    if (!normalizedValue) {
      return;
    }

    const exactMatch = shows.find((show) => show.title.trim().toLowerCase() === normalizedValue);
    if (exactMatch) {
      setManageThemeId(String(exactMatch.id));
    }
  };

  const toggleThemeManagementCollapse = () => {
    setIsThemeManagementCollapsed((currentValue) => {
      const nextValue = !currentValue;
      if (nextValue) {
        setIsAddThemeOpen(false);
      }

      return nextValue;
    });
  };

  const toggleTrackUploadCollapse = () => {
    setIsTrackUploadCollapsed((currentValue) => !currentValue);
  };

  const handleLinkFormChange = (field) => (event) => {
    const rawValue = event.target.value;
    const nextValue = field === 'trackName' ? rawValue.toUpperCase() : rawValue;

    setLinkForm((currentForm) => ({
      ...currentForm,
      [field]: nextValue,
    }));
  };

  const handleAddLinkTrack = async (event) => {
    event.preventDefault();

    const rawUrl = linkForm.url.trim();
    const driveFileId = extractDriveFileId(rawUrl);
    const isDriveUrl = /(?:^https?:\/\/)?(?:www\.)?(?:drive|docs)\.google\.com/i.test(rawUrl);
    const normalizedUrl = normalizeAudioUrl(linkForm.url);
    const trackName = linkForm.trackName.trim().toUpperCase();

    if (!activeShowId || !trackName || !normalizedUrl) {
      showToast('error', 'Preencha tema, nome da trilha e URL pública válida.');
      return;
    }

    if (isDriveUrl && !driveFileId) {
      showToast('error', 'Use o link do arquivo do Google Drive (não o link da pasta).');
      return;
    }

    const selectedShowId = Number(activeShowId);

    try {
      const createdTrack = await apiRequest(`/themes/${selectedShowId}/tracks`, {
        method: 'POST',
        body: {
          name: trackName,
          duration: '--:--',
          url: normalizedUrl,
          driveFileId: driveFileId || null,
          source: 'drive-link',
        },
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

      setLinkForm((currentForm) => ({
        ...currentForm,
        trackName: '',
        url: '',
      }));

      const selectedShow = shows.find((show) => show.id === selectedShowId);
      showToast(
        'success',
        `Trilha "${createdTrack.name}" adicionada em ${selectedShow?.title || 'tema selecionado'}.`,
      );
    } catch (error) {
      showToast('error', error.message || 'Não foi possível salvar a trilha no banco MySQL.');
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
      setLinkForm((currentForm) => ({
        ...currentForm,
        showId: String(createdTheme.id),
      }));
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

      setLinkForm((currentForm) => {
        if (currentForm.showId !== String(show.id)) {
          return currentForm;
        }

        return {
          ...currentForm,
          showId: '',
        };
      });

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

    if (!manageThemeId && !manageThemeQuery.trim()) {
      setManageThemeId(String(shows[0].id));
      setManageThemeQuery(shows[0].title);
      return;
    }

    const hasSelectedTheme = shows.some((show) => String(show.id) === manageThemeId);
    if (!hasSelectedTheme && manageThemeId) {
      setManageThemeId('');
    }
  }, [manageThemeId, manageThemeQuery, shows]);

  useEffect(() => {
    if (isPasswordDialogOpen) {
      passwordInputRef.current?.focus();
    }
  }, [isPasswordDialogOpen]);

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

  return (
    <Layout
      activeView={view}
      onChangeView={handleChangeView}
      searchTerm={searchTerm}
      onSearchChange={setSearchTerm}
    >
      <div className="dashboard">
        {view !== 'upload' && (
          <section className="hero-panel reveal">
            <div className="hero-copy">
              <h1>Trilhas Encante-se</h1>
              <p>Plataforma de trilhas sonoras para os temas da Encante-se Personagens.</p>
            </div>
          </section>
        )}

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
              <button
                type="button"
                className="theme-management-header"
                onClick={toggleThemeManagementCollapse}
                aria-expanded={!isThemeManagementCollapsed}
              >
                <h3>Gerenciar temas</h3>
                <ChevronDown
                  size={18}
                  className={`theme-management-chevron ${isThemeManagementCollapsed ? 'collapsed' : ''}`}
                />
              </button>

              {!isThemeManagementCollapsed && (
                <div className="theme-management-body">
                  {shows.length === 0 ? (
                    <p className="theme-management-empty">Nenhum tema cadastrado.</p>
                  ) : (
                    <div className="theme-management-controls">
                      <label className="field-label" htmlFor="themeManageInput">
                        Tema
                      </label>
                      <label className="theme-management-search theme-management-combobox" htmlFor="themeManageInput">
                        <SearchIcon size={14} />
                        <input
                          id="themeManageInput"
                          type="search"
                          placeholder="Pesquisar e selecionar tema"
                          list="themeManageOptions"
                          value={manageThemeQuery}
                          onChange={(event) => handleManageThemeQueryChange(event.target.value)}
                        />
                      </label>

                      <datalist id="themeManageOptions">
                        {filteredManageThemes.map((show) => (
                          <option key={show.id} value={show.title} />
                        ))}
                      </datalist>

                      {filteredManageThemes.length === 0 && (
                        <p className="theme-management-empty">Nenhum tema encontrado para essa busca.</p>
                      )}

                      {activeManageTheme && (
                        <p className="theme-management-meta">
                          {(activeManageTheme.tracks || []).length} trilha(s) no tema selecionado.
                        </p>
                      )}

                      <div className="theme-management-actions-bottom">
                        <button
                          type="button"
                          className="button button-subtle"
                          disabled={!activeManageTheme}
                          onClick={() => activeManageTheme && handleRequestRenameTheme(activeManageTheme)}
                        >
                          <Pencil size={14} /> Editar
                        </button>
                        <button
                          type="button"
                          className="button button-danger"
                          disabled={!activeManageTheme}
                          onClick={() => activeManageTheme && handleRequestDeleteTheme(activeManageTheme)}
                        >
                          <Trash2 size={14} /> Excluir
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="add-theme-box">
                    <button
                      type="button"
                      className="button button-primary add-theme-toggle"
                      onClick={() => setIsAddThemeOpen(true)}
                    >
                      Adicionar Tema
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="upload-track-panel">
              <button
                type="button"
                className="upload-track-header"
                onClick={toggleTrackUploadCollapse}
                aria-expanded={!isTrackUploadCollapsed}
              >
                <h3>Adicionar trilha por URL</h3>
                <ChevronDown
                  size={18}
                  className={`upload-track-chevron ${isTrackUploadCollapsed ? 'collapsed' : ''}`}
                />
              </button>

              {!isTrackUploadCollapsed && (
                <div className="upload-track-body">
                  <form className="upload-form upload-track-form" onSubmit={handleAddLinkTrack}>
                    <label className="field-label" htmlFor="showSelect">
                      Tema
                    </label>
                    <select
                      id="showSelect"
                      className="field-control"
                      value={activeShowId}
                      onChange={handleLinkFormChange('showId')}
                      disabled={shows.length === 0 || isLoading}
                    >
                      {shows.length === 0 ? (
                        <option value="">Crie um tema primeiro</option>
                      ) : (
                        shows.map((show) => (
                          <option key={show.id} value={show.id}>
                            {show.title}
                          </option>
                        ))
                      )}
                    </select>

                    <label className="field-label" htmlFor="trackName">
                      Nome da trilha
                    </label>
                    <input
                      id="trackName"
                      className="field-control"
                      type="text"
                      placeholder="Ex.: Entrada principal"
                      value={linkForm.trackName}
                      onChange={handleLinkFormChange('trackName')}
                    />

                    <label className="field-label" htmlFor="trackUrl">
                      URL pública do arquivo
                    </label>
                    <input
                      id="trackUrl"
                      className="field-control"
                      type="url"
                      placeholder="https://drive.google.com/file/d/SEU_ID/view?usp=sharing"
                      value={linkForm.url}
                      onChange={handleLinkFormChange('url')}
                    />

                    <button className="button button-primary" type="submit" disabled={shows.length === 0 || isLoading}>
                      <UploadIcon size={16} /> Adicionar trilha por link
                    </button>
                  </form>

                </div>
              )}
            </div>

          </section>
        ) : (
          <section className="shows-section reveal">
            <header className="section-header">
              <h2>Temas</h2>
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
                                <span className="track-duration">{track.duration}</span>
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

      {isPasswordDialogOpen && (
        <div className="password-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="upload-password-title">
          <form className="password-modal-card reveal" onSubmit={handlePasswordSubmit}>
            <h3 id="upload-password-title" className="password-modal-title">
              Acesso protegido
            </h3>
            <label className="password-modal-label" htmlFor="upload-password-input">
              Senha
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
              placeholder="Ex.: FESTIVAL ENCANTADO"
              value={renameThemeInput}
              onChange={(event) => setRenameThemeInput(event.target.value.toUpperCase())}
              autoComplete="off"
            />

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
              onChange={(event) => setNewShowTitle(event.target.value.toUpperCase())}
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
        onTogglePlay={togglePlayback}
        onToggleRepeat={toggleRepeat}
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
