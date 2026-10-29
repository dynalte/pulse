import React, { useEffect, useState } from 'react';
import { useHistory, useParams } from 'react-router-dom';
import { IonIcon } from '@ionic/react';
import {
  arrowForwardOutline, checkmarkCircle, peopleOutline, warningOutline, chatbubblesOutline,
  logInOutline, personAddOutline, homeOutline,
} from 'ionicons/icons';
import { authApi, chatApi } from '../services/api';
import { useApp } from '../context/AppContext';
import type { InviteInfo } from '../types';
import { Avatar, Logo, Spinner } from '../components/ui';
import AuthPage from './AuthPage';

export default function JoinPage() {
  const { code = '' } = useParams<{ code: string }>();
  const { me, upsertConversation, toast } = useApp();
  const history = useHistory();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    authApi.inviteInfo(code)
      .then((res) => { if (alive) setInfo(res.invite); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [code]);

  if (loading) {
    return <div className="join-page"><div className="center-pad"><Spinner size={32} /><p>Vérification de l’invitation…</p></div></div>;
  }

  if (!info) {
    return (
      <div className="join-page">
        <Logo size={54} withText />
        <div className="join-card">
          <IonIcon icon={warningOutline} className="join-icon bad" />
          <h1>Invitation introuvable</h1>
          <p>{error || 'Ce lien est invalide ou a expiré.'}</p>
          <button type="button" className="btn primary" onClick={() => history.push('/')}><IonIcon icon={homeOutline} /> Retour</button>
        </div>
      </div>
    );
  }

  // Invitation de compte : on délègue à la page d'inscription.
  if (!me && info.kind === 'account') {
    return <AuthPage initialCode={code} />;
  }

  if (!me && info.kind === 'group') {
    return (
      <div className="join-page public">
        <div className="auth-backdrop" aria-hidden="true"><span className="blob b1" /><span className="blob b2" /><span className="blob b3" /></div>
        <Logo size={54} withText />
        <div className="join-card group-join-card">
          <div className="join-group-avatar">
            <Avatar id={info.groupMemberCount || 1} name={info.groupName || 'Groupe'} size={84} group />
          </div>
          <span className="join-kicker"><IonIcon icon={peopleOutline} /> Invitation de groupe</span>
          <h1>{info.groupName || 'Rejoindre un groupe'}</h1>
          <p>
            {info.groupMemberCount} membre{(info.groupMemberCount || 0) > 1 ? 's' : ''} vous invitent à rejoindre ce groupe sur Pulse.
            {info.note ? ` « ${info.note} »` : ''}
          </p>
          <button
            type="button"
            className="btn primary block"
            onClick={() => {
              try { localStorage.setItem('pulse_invite_after_login', code.toUpperCase()); } catch { /* ignore */ }
              history.push('/');
            }}
          >
            <IonIcon icon={logInOutline} /> Se connecter ou créer un compte
          </button>
          <p className="muted small">
            <IonIcon icon={personAddOutline} /> Pulse est une messagerie privée : vous aurez aussi besoin d’un code
            d’invitation de compte si vous n’êtes pas encore membre.
          </p>
          <button type="button" className="text-btn" onClick={() => {
            try { localStorage.removeItem('pulse_invite_after_login'); } catch { /* ignore */ }
            history.push('/');
          }}>Retour à l’accueil</button>
        </div>
      </div>
    );
  }

  // Authentifié.
  if (!me) return null;
  const join = async () => {
    if (info.kind !== 'group') return;
    setBusy(true);
    try {
      const res = await chatApi.joinInvite(code);
      upsertConversation(res.conversation);
      toast({ title: `Vous avez rejoint « ${res.conversation.title} »`, tone: 'success' });
      history.replace(`/chat/${res.conversation.id}`);
    } catch (e) {
      toast({ title: 'Impossible de rejoindre', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="join-page">
      <div className="join-card group-join-card">
        {info.kind === 'group' ? (
          <>
            <div className="join-group-avatar"><Avatar id={info.groupMemberCount || 1} name={info.groupName || 'Groupe'} size={84} group /></div>
            <span className="join-kicker"><IonIcon icon={chatbubblesOutline} /> Invitation reçue</span>
            <h1>{info.groupName || 'Groupe'}</h1>
            <p>{info.groupMemberCount || 0} membre{(info.groupMemberCount || 0) > 1 ? 's' : ''}{info.note ? ` · ${info.note}` : ''}</p>
            <div className="join-connected">Connecté en tant que <strong>{me.name}</strong></div>
            <button type="button" className="btn primary block" onClick={() => void join()} disabled={busy}>
              {busy ? <Spinner size={18} /> : <IonIcon icon={checkmarkCircle} />} Rejoindre le groupe
            </button>
            <button type="button" className="btn ghost block" onClick={() => history.push('/')}>Plus tard</button>
          </>
        ) : (
          <>
            <IonIcon icon={checkmarkCircle} className="join-icon ok" />
            <h1>Invitation de compte</h1>
            <p>Vous êtes déjà connecté en tant que <strong>{me.name}</strong>. Cette invitation sert à créer un nouveau compte.</p>
            <button type="button" className="btn primary block" onClick={() => history.push('/')}>
              <IonIcon icon={arrowForwardOutline} /> Ouvrir Pulse
            </button>
          </>
        )}
      </div>
    </div>
  );
}
