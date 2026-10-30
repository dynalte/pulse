import React, { useEffect, useState } from 'react';
import { IonIcon } from '@ionic/react';
import {
  addOutline, calendarOutline, closeCircle, locationOutline, navigateOutline, timeOutline,
} from 'ionicons/icons';
import { Modal, Segmented, Toggle } from './ui';

/* --------------------------------------------------------------- sondage */

type PollKind = 'choice' | 'dates';
type PollOptionInput = string | { text: string; at?: number };
interface DateRow { date: string; time: string; }

function todayISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function dateOption(date: string, time: string): { text: string; at: number } | null {
  if (!date) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = (time || '12:00').split(':').map(Number);
  const dt = new Date(year, (month || 1) - 1, day || 1, hour || 0, minute || 0, 0, 0);
  if (Number.isNaN(dt.getTime())) return null;
  const label = dt.toLocaleDateString('fr-FR', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
  const clean = label.charAt(0).toUpperCase() + label.slice(1);
  return {
    at: Math.floor(dt.getTime() / 1000),
    text: time ? `${clean} · ${time}` : clean,
  };
}

export function PollComposerModal({
  open, onClose, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (question: string, options: PollOptionInput[], kind: PollKind) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<PollKind>('choice');
  const [withTime, setWithTime] = useState(false);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [dates, setDates] = useState<DateRow[]>([{ date: '', time: '' }, { date: '', time: '' }]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setKind('choice');
    setWithTime(false);
    setQuestion('');
    setOptions(['', '']);
    setDates([{ date: '', time: '' }, { date: '', time: '' }]);
    setSending(false);
    setError('');
  }, [open]);

  const setOption = (index: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));
  };
  const setDateRow = (index: number, patch: Partial<DateRow>) => {
    setDates((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const submit = async () => {
    const q = question.trim();
    setSending(true);
    setError('');
    try {
      if (kind === 'dates') {
        const seen = new Map<number, { text: string; at: number }>();
        for (const row of dates) {
          const entry = dateOption(row.date, withTime ? row.time : '');
          if (entry && !seen.has(entry.at)) seen.set(entry.at, entry);
        }
        const entries = Array.from(seen.values()).sort((a, b) => a.at - b.at);
        if (entries.length < 2) {
          setError('Proposez au moins deux dates.');
          return;
        }
        const ok = await onSubmit(q || 'Quand êtes-vous disponible ?', entries, 'dates');
        if (ok) onClose();
        return;
      }
      const cleaned = options.map((o) => o.trim()).filter(Boolean);
      if (!q) { setError('Ajoutez une question.'); return; }
      if (cleaned.length < 2) { setError('Ajoutez au moins deux options.'); return; }
      const ok = await onSubmit(q, cleaned, 'choice');
      if (ok) onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nouveau sondage"
      footer={(
        <>
          <button type="button" className="btn ghost" onClick={onClose}>Annuler</button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={sending}>
            {kind === 'dates' ? 'Proposer ces dates' : 'Envoyer le sondage'}
          </button>
        </>
      )}
    >
      <div className="poll-form">
        <Segmented<PollKind>
          value={kind}
          label="Type de sondage"
          options={[
            { value: 'choice', label: 'Choix simple' },
            { value: 'dates', label: 'Dates' },
          ]}
          onChange={(value) => { setKind(value); setError(''); }}
        />

        <label className="field">
          <span className="field-label">Question</span>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={kind === 'dates' ? 'Quand êtes-vous disponible ?' : 'Ex. Où mange-t-on samedi ?'}
            maxLength={300}
            autoFocus
          />
        </label>

        {kind === 'dates' ? (
          <div className="poll-form-options">
            <span className="field-label">Dates proposées</span>
            <Toggle
              checked={withTime}
              onChange={(value) => {
                setWithTime(value);
                if (!value) setDates((prev) => prev.map((row) => ({ ...row, time: '' })));
              }}
              label="Avec des heures"
              description="Ajoutez une heure à chaque date. Désactivez pour proposer des journées entières."
            />
            {dates.map((row, index) => (
              <div key={index} className="poll-form-row date-row">
                <span className="poll-form-index"><IonIcon icon={calendarOutline} /></span>
                <input
                  type="date"
                  value={row.date}
                  min={todayISO()}
                  onChange={(e) => setDateRow(index, { date: e.target.value })}
                  aria-label={`Date ${index + 1}`}
                />
                {withTime && (
                  <>
                    <input
                      type="time"
                      value={row.time}
                      onChange={(e) => setDateRow(index, { time: e.target.value })}
                      aria-label={`Heure ${index + 1}`}
                    />
                    {row.time && (
                      <button
                        type="button"
                        className="date-time-clear"
                        onClick={() => setDateRow(index, { time: '' })}
                      >
                        Sans heure
                      </button>
                    )}
                  </>
                )}
                {dates.length > 2 && (
                  <button
                    type="button"
                    className="poll-form-remove"
                    onClick={() => setDates((prev) => prev.filter((_, i) => i !== index))}
                    aria-label="Retirer cette date"
                  >
                    <IonIcon icon={closeCircle} />
                  </button>
                )}
              </div>
            ))}
            {dates.length < 20 && (
              <button
                type="button"
                className="poll-form-add"
                onClick={() => setDates((prev) => [...prev, { date: '', time: '' }])}
              >
                <IonIcon icon={addOutline} /> Ajouter une date
              </button>
            )}
            <p className="field-hint">
              Les participants cochent toutes les dates qui leur conviennent. Les noms s’affichent
              sous chaque date.
            </p>
          </div>
        ) : (
          <div className="poll-form-options">
            <span className="field-label">Options</span>
            {options.map((option, index) => (
              <div key={index} className="poll-form-row">
                <span className="poll-form-index">{index + 1}</span>
                <input
                  value={option}
                  onChange={(e) => setOption(index, e.target.value)}
                  placeholder={`Option ${index + 1}`}
                  maxLength={120}
                />
                {options.length > 2 && (
                  <button
                    type="button"
                    className="poll-form-remove"
                    onClick={() => setOptions((prev) => prev.filter((_, i) => i !== index))}
                    aria-label="Retirer cette option"
                  >
                    <IonIcon icon={closeCircle} />
                  </button>
                )}
              </div>
            ))}
            {options.length < 10 && (
              <button type="button" className="poll-form-add" onClick={() => setOptions((prev) => [...prev, ''])}>
                <IonIcon icon={addOutline} /> Ajouter une option
              </button>
            )}
          </div>
        )}
        {error && <p className="field-error">{error}</p>}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- position */

export type LocationMode = 'now' | 'live15' | 'live60';

export function LocationShareModal({
  open, onClose, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (location: { lat: number; lng: number; accuracy: number; liveSeconds: number }) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<LocationMode>('now');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode('now');
    setBusy(false);
    setError('');
  }, [open]);

  const share = () => {
    if (!('geolocation' in navigator)) {
      setError('La géolocalisation n’est pas disponible sur cet appareil.');
      return;
    }
    if (!window.isSecureContext) {
      setError('La géolocalisation nécessite HTTPS.');
      return;
    }
    setBusy(true);
    setError('');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const liveSeconds = mode === 'live15' ? 900 : mode === 'live60' ? 3600 : 0;
          const ok = await onSubmit({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy || 0,
            liveSeconds,
          });
          if (ok) onClose();
        } finally {
          setBusy(false);
        }
      },
      (err) => {
        setBusy(false);
        setError(err.code === err.PERMISSION_DENIED
          ? 'Autorisation refusée. Activez la localisation dans les réglages du navigateur.'
          : 'Position introuvable. Réessayez dans un instant.');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  };

  const choices: { value: LocationMode; label: string; hint: string; icon: string }[] = [
    { value: 'now', label: 'Position actuelle', hint: 'Envoyée une seule fois', icon: locationOutline },
    { value: 'live15', label: 'En direct · 15 min', hint: 'Mise à jour tant que l’app est ouverte', icon: timeOutline },
    { value: 'live60', label: 'En direct · 1 h', hint: 'Mise à jour tant que l’app est ouverte', icon: timeOutline },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Partager ma position"
      footer={(
        <>
          <button type="button" className="btn ghost" onClick={onClose}>Annuler</button>
          <button type="button" className="btn primary" onClick={share} disabled={busy}>
            <IonIcon icon={navigateOutline} /> Partager
          </button>
        </>
      )}
    >
      <div className="location-form">
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={`location-choice ${mode === choice.value ? 'active' : ''}`}
            onClick={() => setMode(choice.value)}
          >
            <span className="location-choice-icon"><IonIcon icon={choice.icon} /></span>
            <span>
              <strong>{choice.label}</strong>
              <em>{choice.hint}</em>
            </span>
          </button>
        ))}
        <p className="field-hint">
          La position est visible uniquement par les membres de cette conversation.
          {mode !== 'now' ? ' Vous pouvez l’arrêter à tout moment depuis le message.' : ''}
        </p>
        {error && <p className="field-error">{error}</p>}
      </div>
    </Modal>
  );
}
