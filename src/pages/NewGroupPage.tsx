import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { IonIcon } from '@ionic/react';
import {
  arrowBackOutline, cameraOutline, checkmarkCircle, ellipseOutline, peopleOutline,
  searchOutline, arrowForwardOutline, closeOutline,
} from 'ionicons/icons';
import { accountApi, chatApi, uploadMedia } from '../services/api';
import { useApp } from '../context/AppContext';
import { prepareImage } from '../services/image';
import { lastSeenLabel } from '../services/utils';
import type { User } from '../types';
import { Avatar, EmptyState, Field, Spinner } from '../components/ui';

export default function NewGroupPage() {
  const history = useHistory();
  const { me, upsertConversation, toast } = useApp();
  const [step, setStep] = useState<1 | 2>(1);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [avatarId, setAvatarId] = useState<number | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const avatarInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    accountApi.directory()
      .then((res) => { if (alive) setUsers(res.users); })
      .catch((e) => toast({ title: 'Annuaire indisponible', body: e.message, tone: 'error' }))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [toast]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return users.filter((u) => !needle || u.name.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle));
  }, [users, q]);

  if (!me) return null;

  const toggle = (id: number) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const uploadAvatar = async (file: File) => {
    try {
      const img = await prepareImage(file);
      const res = await uploadMedia(img.blob, 'image', { filename: img.filename, width: img.width, height: img.height });
      setAvatarId(res.media.id);
      setAvatarUrl(URL.createObjectURL(img.blob));
    } catch (e) {
      toast({ title: 'Photo impossible', body: (e as Error).message, tone: 'error' });
    }
  };

  const create = async () => {
    if (!selected.length) return;
    setBusy(true);
    try {
      const res = await chatApi.createGroup({
        name: name.trim() || 'Nouveau groupe',
        description: description.trim(),
        memberIds: selected,
        avatarId,
      });
      upsertConversation(res.conversation);
      toast({ title: 'Groupe créé', tone: 'success' });
      history.replace(`/chat/${res.conversation.id}`);
    } catch (e) {
      toast({ title: 'Création impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const selectedUsers = users.filter((u) => selected.includes(u.id));

  return (
    <div className="page new-group-page">
      <header className="page-head">
        <div className="head-with-back">
          <button type="button" className="icon-btn ghost" onClick={() => (step === 2 ? setStep(1) : history.push('/contacts'))} aria-label="Retour">
            <IonIcon icon={arrowBackOutline} />
          </button>
          <div>
            <h1>{step === 1 ? 'Nouveau groupe' : 'Détails du groupe'}</h1>
            <p className="page-sub">{step === 1 ? 'Choisissez les personnes à ajouter' : `${selected.length} membre${selected.length > 1 ? 's' : ''} sélectionné${selected.length > 1 ? 's' : ''}`}</p>
          </div>
        </div>
        {step === 1 ? (
          <button type="button" className="btn primary small" disabled={!selected.length} onClick={() => setStep(2)}>
            Suivant <IonIcon icon={arrowForwardOutline} />
          </button>
        ) : (
          <button type="button" className="btn primary small" disabled={busy} onClick={() => void create()}>
            {busy ? <Spinner size={16} /> : <IonIcon icon={checkmarkCircle} />} Créer
          </button>
        )}
      </header>

      <div className="stepper">
        <span className="step active">1</span>
        <span className={`step-line ${step === 2 ? 'active' : ''}`} />
        <span className={`step ${step === 2 ? 'active' : ''}`}>2</span>
      </div>

      {step === 1 && (
        <div className="page-section">
          {selectedUsers.length > 0 && (
            <div className="selected-chips">
              {selectedUsers.map((u) => (
                <button key={u.id} type="button" className="selected-chip" onClick={() => toggle(u.id)}>
                  <Avatar id={u.id} name={u.name} avatarId={u.avatarId} size={22} />
                  {u.name.split(' ')[0]}
                  <IonIcon icon={closeOutline} />
                </button>
              ))}
            </div>
          )}
          <div className="search-box large">
            <IonIcon icon={searchOutline} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un membre…" autoFocus />
            {q && <button type="button" className="clear-btn" onClick={() => setQ('')}><IonIcon icon={closeOutline} /></button>}
            {loading && <Spinner size={16} />}
          </div>
          {!loading && filtered.length === 0 && (
            <EmptyState icon={<IonIcon icon={peopleOutline} />} title="Aucun membre" text="Invitez d’abord vos proches depuis l’onglet Contacts." />
          )}
          <div className="picker-list">
            {filtered.map((u) => {
              const on = selected.includes(u.id);
              return (
                <button key={u.id} type="button" className={`picker-row ${on ? 'selected' : ''}`} onClick={() => toggle(u.id)}>
                  <Avatar id={u.id} name={u.name} avatarId={u.avatarId} size={44} online={u.online} />
                  <span className="picker-info">
                    <strong>{u.name}</strong>
                    <em>@{u.username} · {u.online ? 'en ligne' : lastSeenLabel(u.lastSeen)}</em>
                  </span>
                  <IonIcon icon={on ? checkmarkCircle : ellipseOutline} className={on ? 'check on' : 'check'} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="page-section group-form">
          <div className="group-avatar-upload">
            <button type="button" className="avatar-edit" onClick={() => avatarInput.current?.click()}>
              {avatarUrl
                ? <span className="avatar" style={{ width: 96, height: 96 }}><img src={avatarUrl} alt="" /></span>
                : <Avatar id={selected[0] || 1} name={name || 'Groupe'} size={96} group />}
              <span className="avatar-edit-badge"><IonIcon icon={cameraOutline} /></span>
            </button>
            <input
              ref={avatarInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAvatar(f); e.target.value = ''; }}
            />
            <span className="muted small">Photo du groupe (optionnelle)</span>
          </div>
          <Field label="Nom du groupe">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Les amis, Famille, Projet…" maxLength={80} autoFocus />
          </Field>
          <Field label="Description (optionnelle)" hint="Visible par tous les membres dans les infos du groupe.">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={300} placeholder="À quoi sert ce groupe ?" />
          </Field>
          <div className="summary-card">
            <h4>Membres</h4>
            <div className="member-avatars">
              <Avatar id={me.id} name={me.name} avatarId={me.avatarId} size={38} />
              {selectedUsers.map((u) => <Avatar key={u.id} id={u.id} name={u.name} avatarId={u.avatarId} size={38} />)}
            </div>
            <p>{selectedUsers.map((u) => u.name.split(' ')[0]).join(', ')} et vous.</p>
          </div>
        </div>
      )}
    </div>
  );
}
