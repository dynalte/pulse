import React, { useEffect, useState } from 'react';
import { IonIcon } from '@ionic/react';
import {
  barChartOutline, calendarOutline, checkmarkCircle, locationOutline, mapOutline,
  navigateOutline, stopCircleOutline,
} from 'ionicons/icons';
import { formatTime } from '../services/utils';
import type { LocationData, Poll } from '../types';

/* ------------------------------------------------------------------ poll */

export function PollCard({
  poll, onVote,
}: {
  poll: Poll;
  onVote: (optionIndex: number) => void;
}) {
  const isDates = poll.kind === 'dates';
  const total = Math.max(0, isDates ? poll.voterCount : poll.totalVotes);
  const best = Math.max(0, ...poll.options.map((option) => option.votes));
  return (
    <div className={`poll-card ${isDates ? 'dates' : ''}`}>
      <div className="poll-head">
        <IonIcon icon={isDates ? calendarOutline : barChartOutline} />
        <span>{isDates ? 'Sondage de dates' : 'Sondage'}</span>
      </div>
      <strong className="poll-question">{poll.question}</strong>
      <div className="poll-options">
        {poll.options.map((option, index) => {
          const percent = total > 0 ? Math.round((option.votes / total) * 100) : 0;
          const isBest = isDates && best > 0 && option.votes === best;
          return (
            <button
              key={index}
              type="button"
              className={`poll-option ${option.mine ? 'mine' : ''} ${isBest ? 'best' : ''}`}
              onClick={() => onVote(index)}
              aria-pressed={option.mine}
            >
              <span className="poll-fill" style={{ width: `${percent}%` }} aria-hidden="true" />
              <span className="poll-option-main">
                <span className="poll-label">
                  {option.mine
                    ? <IonIcon icon={checkmarkCircle} className="poll-check" />
                    : <span className={`poll-dot ${isDates ? 'square' : ''}`} aria-hidden="true" />}
                  <span>{option.text}</span>
                  {isBest && <em className="poll-best">Meilleur</em>}
                </span>
                <span className="poll-percent">{percent}%</span>
              </span>
              {isDates && option.voters.length > 0 && (
                <span className="poll-voters">
                  {option.voters.slice(0, 6).map((v) => v.name).join(', ')}
                  {option.voters.length > 6 ? ` +${option.voters.length - 6}` : ''}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="poll-foot">
        <span>
          {isDates
            ? `${total} participant${total > 1 ? 's' : ''}`
            : `${total} vote${total > 1 ? 's' : ''}`}
        </span>
        <span>
          {isDates
            ? (poll.myVotes.length > 0 ? 'Cochez ou décochez vos dates' : 'Cochez toutes vos disponibilités')
            : (poll.myVote === null ? 'Appuyez pour voter' : 'Appuyez pour changer')}
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- location */

function remainingLabel(until: number, now: number): string {
  const seconds = Math.max(0, until - now);
  if (seconds <= 0) return 'terminée';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

export function LocationCard({
  location, mine, onStop,
}: {
  location: LocationData;
  mine: boolean;
  onStop: () => void;
}) {
  const [, setTick] = useState(0);
  const [showMap, setShowMap] = useState(false);
  const now = Date.now() / 1000;
  const live = location.liveUntil > now && location.stoppedAt === 0;
  const wasLive = location.liveUntil > 0 || location.stoppedAt > 0;
  const ended = wasLive && !live && location.stoppedAt === 0;

  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => setTick((v) => v + 1), 20000);
    return () => window.clearInterval(timer);
  }, [live]);

  const embedUrl = (() => {
    const dLat = 0.004;
    const dLng = 0.006;
    const bbox = [
      location.lng - dLng, location.lat - dLat,
      location.lng + dLng, location.lat + dLat,
    ].map((v) => v.toFixed(6)).join('%2C');
    return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${location.lat}%2C${location.lng}`;
  })();
  const externalUrl = `https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lng}#map=16/${location.lat}/${location.lng}`;

  return (
    <div className={`location-card ${live ? 'live' : ''}`}>
      <div className="location-head">
        <span className={`location-pin ${live ? 'live' : ''}`}>
          <IonIcon icon={locationOutline} />
        </span>
        <span>
          <strong>
            {live
              ? 'Position en direct'
              : location.stoppedAt > 0
                ? 'Position en direct arrêtée'
                : ended
                  ? 'Position en direct terminée'
                  : 'Position partagée'}
          </strong>
          <em>
            {live
              ? `Encore ${remainingLabel(location.liveUntil, now)}`
              : location.stoppedAt > 0
                ? `Arrêtée à ${formatTime(location.stoppedAt)}`
                : ended
                  ? 'Durée écoulée'
                  : 'Position ponctuelle'}
          </em>
        </span>
        {live && <i className="location-live-dot" aria-label="En direct" />}
      </div>

      {showMap && (
        <div className="location-map">
          <iframe title="Carte de la position" src={embedUrl} loading="lazy" referrerPolicy="no-referrer" />
        </div>
      )}

      <div className="location-meta">
        <span>
          {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
          {location.accuracy > 0 ? ` · ± ${Math.round(location.accuracy)} m` : ''}
        </span>
      </div>

      <div className="location-actions">
        <button type="button" className="location-btn" onClick={() => setShowMap((v) => !v)}>
          <IonIcon icon={mapOutline} />
          {showMap ? 'Masquer la carte' : 'Afficher la carte'}
        </button>
        <a className="location-btn" href={externalUrl} target="_blank" rel="noreferrer noopener">
          <IonIcon icon={navigateOutline} />
          Itinéraire
        </a>
        {mine && live && (
          <button type="button" className="location-btn danger" onClick={onStop}>
            <IonIcon icon={stopCircleOutline} />
            Arrêter
          </button>
        )}
      </div>
    </div>
  );
}
