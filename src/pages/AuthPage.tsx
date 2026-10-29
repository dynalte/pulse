import React, { useEffect, useMemo, useState } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { IonIcon } from '@ionic/react';
import {
  arrowForwardOutline, checkmarkCircle, eyeOffOutline, eyeOutline, lockClosedOutline,
  mailOutline, personOutline, serverOutline, shieldCheckmarkOutline, keyOutline, peopleOutline,
  chatbubblesOutline, notificationsOutline, imageOutline, micOutline, refreshOutline, warningOutline,
} from 'ionicons/icons';
import { authApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { setApiURL, settings } from '../services/settings';
import { useDebouncedValue } from '../services/hooks';
import { formatTime } from '../services/utils';
import { Logo, Spinner, Field, Tag } from '../components/ui';

type Mode = 'login' | 'join' | 'setup';

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'Serveur';
  }
}

export default function AuthPage({ initialCode = '' }: { initialCode?: string }) {
  const { login, registerWithInvite, setupAdmin, toast } = useApp();
  const history = useHistory();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>('login');
  const [checking, setChecking] = useState(true);
  const [serverOk, setServerOk] = useState(true);
  const [showServer, setShowServer] = useState(false);
  const [serverUrl, setServerUrl] = useState(settings.apiURL);
  const [busy, setBusy] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    login: '',
    password: '',
    code: '',
    name: '',
    email: '',
    username: '',
    password2: '',
  });
  const [invitePreview, setInvitePreview] = useState<{ valid: boolean; email: string; note: string; creatorName: string; reason?: string } | null>(null);
  const [inviteChecking, setInviteChecking] = useState(false);
  const debouncedCode = useDebouncedValue(form.code, 400);

  useEffect(() => {
    let alive = true;
    setChecking(true);
    authApi.bootstrapStatus()
      .then((res) => {
        if (!alive) return;
        setServerOk(true);
        if (res.needsSetup) setMode('setup');
      })
      .catch(() => {
        if (alive) setServerOk(false);
      })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const code = (params.get('code') || initialCode || settings.inviteDraft || '').trim().toUpperCase();
    if (code) {
      setForm((f) => ({ ...f, code }));
      setMode('join');
      try { localStorage.removeItem('pulse_invite_draft'); } catch { /* ignore */ }
    }
  }, [location.search, initialCode]);

  useEffect(() => {
    const code = debouncedCode.trim().toUpperCase();
    if (!code || mode !== 'join') {
      setInvitePreview(null);
      return;
    }
    let alive = true;
    setInviteChecking(true);
    authApi.inviteInfo(code)
      .then((res) => {
        if (!alive) return;
        const inv = res.invite;
        if (inv.kind !== 'account') {
          setInvitePreview({ valid: false, email: '', note: '', creatorName: '', reason: 'Ce lien est une invitation de groupe. Connectez-vous d’abord.' });
          return;
        }
        setInvitePreview({
          valid: inv.valid,
          email: inv.email,
          note: inv.note,
          creatorName: inv.creatorName,
          reason: inv.reason,
        });
        if (inv.valid && inv.email) setForm((f) => (f.email ? f : { ...f, email: inv.email }));
      })
      .catch(() => { if (alive) setInvitePreview(null); })
      .finally(() => { if (alive) setInviteChecking(false); });
    return () => { alive = false; };
  }, [debouncedCode, mode]);

  const afterAuth = () => {
    let pending = '';
    try { pending = localStorage.getItem('pulse_invite_after_login') || ''; } catch { /* ignore */ }
    if (pending) {
      try { localStorage.removeItem('pulse_invite_after_login'); } catch { /* ignore */ }
      history.replace(`/invite/${pending}`);
    } else {
      history.replace('/');
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'setup') {
        if (form.password.length < 8) throw new Error('Le mot de passe doit contenir au moins 8 caractères.');
        await setupAdmin(form.name.trim(), form.email.trim(), form.username.trim(), form.password);
        toast({ title: 'Bienvenue sur Pulse !', body: 'Votre compte administrateur est prêt.', tone: 'success' });
      } else if (mode === 'login') {
        await login(form.login.trim(), form.password);
      } else {
        if (form.password.length < 8) throw new Error('Le mot de passe doit contenir au moins 8 caractères.');
        if (form.password !== form.password2) throw new Error('Les mots de passe ne correspondent pas.');
        await registerWithInvite(form.code.trim().toUpperCase(), form.name.trim(), form.email.trim(), form.username.trim(), form.password);
        toast({ title: 'Compte créé !', body: 'Bienvenue dans Pulse.', tone: 'success' });
      }
      afterAuth();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applyServer = () => {
    const clean = serverUrl.trim();
    if (!/^https?:\/\//.test(clean)) {
      setError('L’adresse de l’API doit commencer par http:// ou https://');
      return;
    }
    setApiURL(clean);
    setError('');
    setShowServer(false);
    authApi.bootstrapStatus()
      .then((res) => {
        setServerOk(true);
        if (res.needsSetup) setMode('setup');
        else setMode((m) => (m === 'setup' ? 'login' : m));
        toast({ title: 'Serveur joignable', tone: 'success' });
      })
      .catch(() => setServerOk(false));
  };

  const passwordToggle = (
    <button type="button" className="input-toggle" onClick={() => setShowPass((v) => !v)} aria-label={showPass ? 'Masquer le mot de passe' : 'Afficher'}>
      <IonIcon icon={showPass ? eyeOffOutline : eyeOutline} />
    </button>
  );

  const inviteOk = invitePreview?.valid !== false;
  const title = mode === 'setup' ? 'Créez votre espace' : mode === 'login' ? 'Heureux de vous revoir' : 'Rejoindre Pulse';
  const subtitle = mode === 'setup'
    ? 'Le premier compte devient administrateur. Les suivants seront créés sur invitation.'
    : mode === 'login'
      ? 'Connectez-vous pour retrouver vos discussions.'
      : 'Saisissez le code d’invitation reçu pour créer votre compte.';

  return (
    <div className="auth-page">
      <div className="auth-backdrop" aria-hidden="true">
        <span className="blob b1" />
        <span className="blob b2" />
        <span className="blob b3" />
      </div>

      <aside className="auth-hero">
        <Logo size={54} withText />
        <h1>Des conversations qui restent <em>privées</em>.</h1>
        <p className="auth-lead">
          Pulse réunit vos discussions, groupes, photos et messages vocaux dans une messagerie moderne,
          hébergée sur votre serveur. Pas de publicité, pas de revente de données.
        </p>
        <ul className="auth-features">
          <li><span><IonIcon icon={chatbubblesOutline} /></span><div><strong>Discussions & groupes</strong><em>Temps réel, accusés de lecture, réactions.</em></div></li>
          <li><span><IonIcon icon={imageOutline} /></span><div><strong>Photos et vocaux</strong><em>Partagez des images et des messages vocaux.</em></div></li>
          <li><span><IonIcon icon={notificationsOutline} /></span><div><strong>Notifications</strong><em>Push PWA, même application fermée.</em></div></li>
          <li><span><IonIcon icon={shieldCheckmarkOutline} /></span><div><strong>Sur invitation</strong><em>Vous décidez qui peut rejoindre.</em></div></li>
        </ul>
        <footer className="auth-hero-foot">
          <span className={`server-dot ${serverOk ? 'ok' : 'down'}`} />
          {serverOk ? 'Serveur connecté' : 'Serveur injoignable'}
          <button type="button" onClick={() => setShowServer(true)}><IonIcon icon={serverOutline} /> Configurer</button>
        </footer>
      </aside>

      <main className="auth-card-wrap">
        <div className="auth-card">
          <div className="auth-mobile-logo"><Logo size={44} withText /></div>
          <div className="auth-heading">
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>

          {checking && (
            <div className="auth-checking"><Spinner size={24} /><span>Connexion au serveur…</span></div>
          )}

          {!checking && !serverOk && (
            <div className="notice danger auth-server-error">
              <IonIcon icon={warningOutline} />
              <div>
                <strong>Serveur injoignable</strong>
                <p>Vérifiez l’adresse de l’API PHP et votre connexion.</p>
                <button type="button" className="btn small ghost" onClick={() => setShowServer(true)}>
                  <IonIcon icon={serverOutline} /> Changer d’adresse
                </button>
              </div>
            </div>
          )}

          {!checking && serverOk && mode !== 'setup' && (
            <div className="auth-tabs">
              <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>Connexion</button>
              <button type="button" className={mode === 'join' ? 'active' : ''} onClick={() => { setMode('join'); setError(''); }}>J’ai une invitation</button>
            </div>
          )}

          {!checking && serverOk && (
            <form className="auth-form" onSubmit={submit}>
              {mode === 'setup' && (
                <>
                  <div className="setup-badge"><IonIcon icon={shieldCheckmarkOutline} /> Configuration initiale</div>
                  <Field label="Votre nom">
                    <div className="input-with-icon"><IonIcon icon={personOutline} /><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Alex Martin" required autoComplete="name" /></div>
                  </Field>
                  <Field label="Adresse e-mail">
                    <div className="input-with-icon"><IonIcon icon={mailOutline} /><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="alex@exemple.fr" required autoComplete="email" /></div>
                  </Field>
                  <Field label="Identifiant" hint="3 à 24 caractères : lettres, chiffres, point, tiret bas.">
                    <div className="input-prefix"><span>@</span><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.replace(/^@/, '') })} placeholder="alex" required autoComplete="username" /></div>
                  </Field>
                </>
              )}

              {mode === 'login' && (
                <>
                  <Field label="E-mail ou identifiant">
                    <div className="input-with-icon"><IonIcon icon={personOutline} /><input value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} placeholder="alex ou alex@exemple.fr" required autoComplete="username" autoFocus /></div>
                  </Field>
                </>
              )}

              {mode === 'join' && (
                <>
                  <Field label="Code d’invitation">
                    <div className="input-with-icon"><IonIcon icon={keyOutline} /><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="XXXXXXXX" required autoFocus /></div>
                  </Field>
                  {inviteChecking && <p className="muted small"><Spinner size={14} /> Vérification de l’invitation…</p>}
                  {invitePreview && (
                    <div className={`invite-preview ${invitePreview.valid ? 'ok' : 'bad'}`}>
                      <IonIcon icon={invitePreview.valid ? checkmarkCircle : warningOutline} />
                      <div>
                        <strong>{invitePreview.valid ? 'Invitation valide' : 'Invitation invalide'}</strong>
                        <span>
                          {invitePreview.valid
                            ? `${invitePreview.creatorName ? `Invité par ${invitePreview.creatorName}. ` : ''}${invitePreview.note || 'Créez votre compte pour rejoindre Pulse.'}`
                            : invitePreview.reason || 'Demandez un nouveau lien.'}
                        </span>
                      </div>
                    </div>
                  )}
                  <Field label="Votre nom">
                    <div className="input-with-icon"><IonIcon icon={personOutline} /><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Camille Dupont" required autoComplete="name" /></div>
                  </Field>
                  <Field label="Adresse e-mail">
                    <div className="input-with-icon"><IonIcon icon={mailOutline} /><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="camille@exemple.fr" required autoComplete="email" /></div>
                  </Field>
                  <Field label="Identifiant">
                    <div className="input-prefix"><span>@</span><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.replace(/^@/, '') })} placeholder="camille" required autoComplete="username" /></div>
                  </Field>
                </>
              )}

              <Field label={mode === 'setup' ? 'Mot de passe administrateur' : 'Mot de passe'} hint="8 caractères minimum.">
                <div className="input-with-icon">
                  <IonIcon icon={lockClosedOutline} />
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={mode === 'join' ? form.password : form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder="••••••••"
                    required
                    minLength={8}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  />
                  {passwordToggle}
                </div>
              </Field>

              {mode === 'join' && (
                <Field label="Confirmer le mot de passe">
                  <div className="input-with-icon">
                    <IonIcon icon={lockClosedOutline} />
                    <input type={showPass ? 'text' : 'password'} value={form.password2} onChange={(e) => setForm({ ...form, password2: e.target.value })} placeholder="••••••••" required autoComplete="new-password" />
                  </div>
                </Field>
              )}

              {error && <div className="form-error"><IonIcon icon={warningOutline} /> {error}</div>}

              <button
                type="submit"
                className="btn primary block auth-submit"
                disabled={busy || (mode === 'join' && !inviteOk)}
              >
                {busy ? <Spinner size={20} /> : <IonIcon icon={mode === 'login' ? arrowForwardOutline : mode === 'setup' ? shieldCheckmarkOutline : peopleOutline} />}
                {mode === 'login' ? 'Se connecter' : mode === 'setup' ? 'Créer mon compte administrateur' : 'Créer mon compte'}
              </button>

              {mode === 'login' && (
                <p className="auth-switch">
                  Pas encore de compte ? <button type="button" onClick={() => setMode('join')}>Utilisez une invitation</button>
                </p>
              )}
              {mode === 'join' && (
                <p className="auth-switch">
                  Déjà membre ? <button type="button" onClick={() => setMode('login')}>Se connecter</button>
                </p>
              )}
              {mode === 'setup' && (
                <p className="auth-foot-note">
                  <IonIcon icon={shieldCheckmarkOutline} /> Cette page n’est accessible qu’une seule fois, tant qu’aucun compte n’existe.
                </p>
              )}
            </form>
          )}

          <footer className="auth-card-foot">
            <span>Pulse · messagerie privée</span>
            <button type="button" onClick={() => setShowServer(true)}><IonIcon icon={serverOutline} /> {safeHost(settings.apiURL)}</button>
          </footer>
        </div>
      </main>

      {showServer && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowServer(false); }}>
          <div className="modal sheet server-modal">
            <header className="modal-head"><h2>Serveur</h2><button type="button" className="icon-btn ghost" onClick={() => setShowServer(false)} aria-label="Fermer">✕</button></header>
            <div className="modal-body">
              <Field label="Adresse de l’API PHP" hint="Par défaut, l’API est cherchée à la racine du site : /api-messagerie.php">
                <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://exemple.fr/api-messagerie.php" />
              </Field>
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setServerUrl(settings.apiURL)}>Réinitialiser</button>
                <button type="button" className="btn primary" onClick={applyServer}><IonIcon icon={refreshOutline} /> Tester et enregistrer</button>
              </div>
              <p className="muted small">
                L’adresse est stockée sur cet appareil. En production, servez l’API en HTTPS pour activer les notifications push et la caméra.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
