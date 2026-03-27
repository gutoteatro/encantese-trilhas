import React from 'react';
import { Pause, Play, Repeat, SkipBack, SkipForward, X } from 'lucide-react';

export default function AudioPlayer({
  currentTrack,
  isPlaying,
  isRepeatEnabled,
  onTogglePlay,
  onToggleRepeat,
  onNextTrack,
  onPreviousTrack,
  onSeek,
  progressPercent,
  currentTimeLabel,
  durationLabel,
  onClosePlayer,
}) {
  if (!currentTrack) {
    return null;
  }

  return (
    <div className="audio-player" aria-label="Player de trilha atual">
      <button className="audio-close-button" type="button" aria-label="Fechar player" onClick={onClosePlayer}>
        <X size={15} />
      </button>

      <div className="audio-now-playing">
        <p>{currentTrack.showTitle}</p>
        <strong>{currentTrack.name}</strong>
      </div>

      <div className="audio-controls">
        <div className="audio-buttons-row">
          <button
            className={`icon-button ${isRepeatEnabled ? 'active' : ''}`}
            aria-label={isRepeatEnabled ? 'Desativar repetição' : 'Ativar repetição'}
            aria-pressed={isRepeatEnabled}
            onClick={onToggleRepeat}
          >
            <Repeat size={18} />
          </button>
          <button className="icon-button" aria-label="Trilha anterior" onClick={onPreviousTrack}>
            <SkipBack size={18} />
          </button>
          <button className="icon-button primary" aria-label={isPlaying ? 'Pausar' : 'Reproduzir'} onClick={onTogglePlay}>
            {isPlaying ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button className="icon-button" aria-label="Próxima trilha" onClick={onNextTrack}>
            <SkipForward size={18} />
          </button>
        </div>

        <div className="audio-progress-row">
          <span>{currentTimeLabel}</span>
          <button
            className="audio-progress-bar"
            aria-label="Ajustar progresso"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = (event.clientX - rect.left) / rect.width;
              onSeek(ratio);
            }}
          >
            <span className="audio-progress-fill" style={{ width: `${progressPercent}%` }} />
          </button>
          <span>{durationLabel}</span>
        </div>
      </div>

    </div>
  );
}
