import React, { useCallback, useRef } from 'react';
import { Pause, Play, Repeat, SkipBack, SkipForward, Volume2, VolumeX, X } from 'lucide-react';

export default function AudioPlayer({
  currentTrack,
  isPlaying,
  isRepeatEnabled,
  isMuted,
  onTogglePlay,
  onToggleRepeat,
  onToggleMute,
  onNextTrack,
  onPreviousTrack,
  onSeek,
  progressPercent,
  currentTimeLabel,
  durationLabel,
  onClosePlayer,
}) {
  const progressBarRef = useRef(null);

  const seekByClientX = useCallback(
    (clientX) => {
      const barElement = progressBarRef.current;
      if (!barElement) {
        return;
      }

      const rect = barElement.getBoundingClientRect();
      if (!rect.width) {
        return;
      }

      const ratio = (clientX - rect.left) / rect.width;
      onSeek(ratio);
    },
    [onSeek],
  );

  const handleProgressPointerDown = useCallback(
    (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }

      event.preventDefault();
      seekByClientX(event.clientX);

      const handlePointerMove = (moveEvent) => {
        seekByClientX(moveEvent.clientX);
      };

      const handlePointerUp = () => {
        window.removeEventListener('pointermove', handlePointerMove);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp, { once: true });
    },
    [seekByClientX],
  );

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
          <button
            className={`icon-button ${isMuted ? 'active' : ''}`}
            aria-label={isMuted ? 'Ativar som' : 'Silenciar'}
            aria-pressed={isMuted}
            onClick={onToggleMute}
          >
            {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
        </div>

        <div className="audio-progress-row">
          <span>{currentTimeLabel}</span>
          <button
            ref={progressBarRef}
            className="audio-progress-bar"
            type="button"
            aria-label="Ajustar progresso"
            onPointerDown={handleProgressPointerDown}
          >
            <span className="audio-progress-fill" style={{ width: `${progressPercent}%` }} />
          </button>
          <span>{durationLabel}</span>
        </div>
      </div>

    </div>
  );
}
