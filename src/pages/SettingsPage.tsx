import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { IonIcon } from '@ionic/react';
import {
  cameraOutline, checkmarkCircle, cloudDownloadOutline, logOutOutline, notificationsOutline,
  personOutline, shieldCheckmarkOutline, colorPaletteOutline, lockClosedOutline, serverOutline,
  informationCircleOutline, peopleOutline, mailOutline, powerOutline, refreshOutline,
  addOutline, statsChartOutline, chatbubblesOutline, imageOutline, pencilOutline,
  phonePortraitOutline, trashOutline,
} from 'ionicons/icons';
import { accountApi, adminApi, pushApi, uploadMedia } from '../services/api';
import type { PushDevice } from '../services/api';
import { useApp } from '../context/AppContext';
import { useInstallPrompt } from '../services/hooks';
import { prepareImage } from '../services/image';
import {
  currentPushEndpoint, describeDevice, disablePush, enablePush, pushSupported, testPush,
} from '../services/notifications';
import { setApiURL, settings } from '../services/settings';
import { formatListTime, lastSeenLabel } from '../services/utils';
import type { AdminStats, PrivacyValue, ThemeMode, User } from '../types';
import { Avatar, ConfirmDialog, Field, Segmented, Spinner, Tag, Toggle } from '../components/ui';
import { InviteManager } from '../components/InviteManager';

export default function SettingsPage() {
  const {
    me, toast, updateMe, updateNotif, updatePrivacy, theme, setTheme, accent, setAccent,
    soundEnabled, setSoundEnabled, logout, refreshMe,
  } = useApp();
  const history = useHistory();
  const { canInstall, installed, install } = useInstallPrompt();
  const [name, setName] = useState(me?.name || '');
  const [username, setUsername] = useState(me?.username || '');
  const [email, setEmail] = useState(me?.email || '');
  const [bio, setBio] = useState(me?.bio || '');
  const [phone, setPhone] = useState(me?.phone || '');
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInput = useRef<HTMLInputElement | null>(null);
  const [pushPermission, setPushPermission] = useState<string>(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [pushBusy, setPushBusy] = useState(false);
  const [subscriptionActive, setSubscriptionActive] = useState(false);
  const [pushChecked, setPushChecked] = useState(false);
  const [pushDevices, setPushDevices] = useState<PushDevice[]>([]);
  const [showPassword, setShowPassword] = useState(false);
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState(settings.apiURL);
  const [serverEditing, setServerEditing] = useState(false);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [adminUsers, setAdminUsers] = useState<User[]>([]);
  const [adminQ, setAdminQ] = useState('');
  const [adminBusy, setAdminBusy] = useState<number | null>(null);
  const [confirmUser, setConfirmUser] = useState<{ user: User; action: 'deactivate' | 'promote' | 'demote' } | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [showAdminInvites, setShowAdminInvites] = useState(false);

  useEffect(() => {
    if (!me) return;
    setName(me.name);
    setUsername(me.username);
    setEmail(me.email || '');
    setBio(me.bio || '');
    setPhone(me.phone || '');
  }, [me?.id, me?.name, me?.username, me?.email, me?.bio, me?.phone]);

  useEffect(() => {
    if (!me || me.role !== 'admin') return;
    adminApi.stats().then((res) => setStats(res.stats)).catch(() => undefined);
    adminApi.users().then((res) => setAdminUsers(res.users)).catch(() => undefined);
  }, [me?.role]);

  // Un compte peut être activé sur plusieurs appareils : on vérifie
  // l'abonnement réel de CE navigateur, pas seulement la préférence serveur.
  const loadPushDevices = useCallback(async () => {
    if (!pushSupported()) return;
    try {
      const endpoint = await currentPushEndpoint();
      const res = await pushApi.devices(endpoint);
      setPushDevices(res.devices);
      if (endpoint) setSubscriptionActive(res.devices.some((d) => d.current));
    } catch {
      /* liste indicative : on n'empêche pas l'écran de fonctionner */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let attempts = 0;
    if (!pushSupported()) {
      setPushChecked(true);
      return () => { alive = false; };
    }
    const check = async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!alive) return;
        setSubscriptionActive(!!sub);
        setPushChecked(true);
        void loadPushDevices();
        // L'abonnement automatique de connexion peut être encore en cours.
        if (!sub && attempts < 3) {
          attempts++;
          timer = window.setTimeout(() => void check(), 1500);
        }
      } catch {
        if (alive) setPushChecked(true);
      }
    };
    void check();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [me?.id, loadPushDevices]);

  const filteredAdminUsers = useMemo(() => {
    const needle = adminQ.trim().toLowerCase();
    if (!needle) return adminUsers;
    return adminUsers.filter((u) => u.name.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle) || (u.email || '').toLowerCase().includes(needle));
  }, [adminUsers, adminQ]);

  if (!me) return null;
  const isAdmin = me.role === 'admin';
  const pushEnabled = pushChecked && subscriptionActive && me.notif.enabled;

  const saveProfile = async () => {
    setSaving(true);
    try {
      const res = await accountApi.profileUpdate({ name: name.trim(), username: username.trim(), email: email.trim(), bio: bio.trim(), phone: phone.trim() });
      updateMe(res.user);
      toast({ title: 'Profil enregistré', tone: 'success' });
    } catch (e) {
      toast({ title: 'Enregistrement impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    setAvatarBusy(true);
    try {
      const img = await prepareImage(file);
      const media = await uploadMedia(img.blob, 'image', { filename: img.filename, width: img.width, height: img.height });
      const res = await accountApi.profileUpdate({ avatarId: media.media.id });
      updateMe(res.user);
      toast({ title: 'Photo de profil mise à jour', tone: 'success' });
    } catch (e) {
      toast({ title: 'Photo impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setAvatarBusy(false);
    }
  };

  const togglePush = async () => {
    if (!pushSupported()) {
      toast({ title: 'Push non disponible', body: 'Sur iPhone, installez Pulse sur l’écran d’accueil (iOS 16.4+) puis réessayez.', tone: 'error' });
      return;
    }
    setPushBusy(true);
    try {
      if (pushEnabled) {
        // Désactivation locale uniquement : les autres appareils du compte
        // restent abonnés (la préférence globale reste activée).
        await disablePush();
        setSubscriptionActive(false);
        toast({ title: 'Notifications désactivées sur cet appareil', tone: 'success' });
      } else {
        const res = await enablePush();
        if (!res.ok) {
          toast({ title: 'Activation impossible', body: res.reason, tone: 'error' });
        } else {
          if (!me.notif.enabled) await updateNotif({ enabled: true });
          setSubscriptionActive(true);
          toast({ title: 'Notifications activées sur cet appareil', tone: 'success' });
        }
      }
      setPushPermission(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
      await refreshMe();
      await loadPushDevices();
    } finally {
      setPushBusy(false);
    }
  };

  const removePushDevice = async (device: PushDevice) => {
    setPushBusy(true);
    try {
      await pushApi.removeDevice(device.id);
      toast({ title: 'Appareil retiré', body: 'Il ne recevra plus les notifications.', tone: 'success' });
      await refreshMe();
      await loadPushDevices();
    } catch (e) {
      toast({ title: 'Suppression impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setPushBusy(false);
    }
  };

  const testNotification = async () => {
    setPushBusy(true);
    try {
      const res = await testPush();
      toast({ title: res.ok ? 'Notification envoyée' : 'Envoi impossible', body: res.message, tone: res.ok ? 'success' : 'error' });
    } finally {
      setPushBusy(false);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwords.next !== passwords.confirm) {
      toast({ title: 'Les mots de passe ne correspondent pas', tone: 'error' });
      return;
    }
    setPasswordBusy(true);
    try {
      await accountApi.changePassword(passwords.current, passwords.next);
      setPasswords({ current: '', next: '', confirm: '' });
      setShowPassword(false);
      toast({ title: 'Mot de passe modifié', body: 'Les autres appareils ont été déconnectés.', tone: 'success' });
    } catch (err) {
      toast({ title: 'Modification impossible', body: (err as Error).message, tone: 'error' });
    } finally {
      setPasswordBusy(false);
    }
  };

  const saveServerUrl = () => {
    const clean = serverUrl.trim();
    if (!/^https?:\/\//.test(clean)) {
      toast({ title: 'URL invalide', body: 'L’adresse doit commencer par http:// ou https://', tone: 'error' });
      return;
    }
    setApiURL(clean);
    setServerEditing(false);
    toast({ title: 'Adresse enregistrée', body: 'Rechargez l’application si le serveur change.', tone: 'success' });
  };

  const doAdminAction = async () => {
    if (!confirmUser) return;
    const { user, action } = confirmUser;
    setAdminBusy(user.id);
    try {
      if (action === 'deactivate') await adminApi.updateUser(user.id, { active: false });
      else await adminApi.updateUser(user.id, { role: action === 'promote' ? 'admin' : 'member' });
      const res = await adminApi.users();
      setAdminUsers(res.users);
      if (action === 'deactivate') {
        setAdminUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, active: false } : u)));
      }
      toast({ title: 'Compte mis à jour', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setAdminBusy(null);
      setConfirmUser(null);
    }
  };

  const reactivate = async (user: User) => {
    setAdminBusy(user.id);
    try {
      await adminApi.updateUser(user.id, { active: true });
      setAdminUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, active: true } : u)));
      toast({ title: 'Compte réactivé', tone: 'success' });
    } catch (e) {
      toast({ title: 'Action impossible', body: (e as Error).message, tone: 'error' });
    } finally {
      setAdminBusy(null);
    }
  };

  return (
    <div className="page settings-page">
      <header className="page-head">
        <div>
          <h1>Réglages</h1>
          <p className="page-sub">@{me.username} · {me.role === 'admin' ? 'Administrateur' : 'Membre'}</p>
        </div>
        <button type="button" className="btn ghost small danger-text" onClick={() => setConfirmLogout(true)}>
          <IonIcon icon={logOutOutline} /> Se déconnecter
        </button>
      </header>

      <section className="settings-card profile-card-settings">
        <div className="settings-profile-hero">
          <button type="button" className="avatar-edit" onClick={() => avatarInput.current?.click()} disabled={avatarBusy}>
            <Avatar id={me.id} name={me.name} avatarId={me.avatarId} size={88} online={me.online} ring />
            <span className="avatar-edit-badge">{avatarBusy ? <Spinner size={14} /> : <IonIcon icon={cameraOutline} />}</span>
          </button>
          <input
            ref={avatarInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAvatar(f); e.target.value = ''; }}
          />
          <div>
            <h2>{me.name}</h2>
            <p>@{me.username} · membre depuis {new Date(me.createdAt * 1000).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</p>
            <div className="chip-row">
              <Tag tone="accent">{me.role === 'admin' ? 'Administrateur' : 'Membre'}</Tag>
              {pushEnabled && <Tag tone="accent">Push actif</Tag>}
              <Tag>{me.pushDevices || 0} appareil{(me.pushDevices || 0) > 1 ? 's' : ''}</Tag>
            </div>
          </div>
        </div>

        <div className="settings-grid-2">
          <Field label="Nom affiché">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Identifiant" hint="Lettres, chiffres, point et tiret bas.">
            <div className="input-prefix"><span>@</span><input value={username} onChange={(e) => setUsername(e.target.value.replace(/^@/, ''))} maxLength={24} /></div>
          </Field>
          <Field label="Téléphone (optionnel)">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} placeholder="+33 6 …" />
          </Field>
          <Field label="E-mail" hint="Sert aussi d’identifiant de connexion.">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </Field>
        </div>
        <Field label="Bio / statut" hint="200 caractères max. Visible sur votre fiche.">
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={2} maxLength={200} placeholder="Un mot sur vous…" />
        </Field>
        <div className="card-actions">
          <button type="button" className="btn primary" onClick={() => void saveProfile()} disabled={saving}>
            {saving ? <Spinner size={18} /> : <IonIcon icon={checkmarkCircle} />} Enregistrer le profil
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h3><IonIcon icon={colorPaletteOutline} /> Apparence</h3>
        <div className="settings-line">
          <div><strong>Thème</strong><span>Choisissez le mode clair, sombre ou système.</span></div>
          <Segmented<ThemeMode>
            value={theme}
            onChange={setTheme}
            options={[{ value: 'dark', label: 'Sombre' }, { value: 'light', label: 'Clair' }, { value: 'system', label: 'Système' }]}
          />
        </div>
        <div className="settings-line">
          <div><strong>Couleur d’accent</strong><span>Personnalisez les bulles et les boutons.</span></div>
          <div className="accent-swatches">
            {[
              ['emerald', '#12c2a0'],
              ['violet', '#7c5cff'],
              ['ocean', '#2f8df6'],
              ['sunset', '#ff7a59'],
            ].map(([key, color]) => (
              <button
                key={key}
                type="button"
                className={`accent-swatch ${accent === key ? 'active' : ''}`}
                style={{ background: color }}
                aria-label={`Accent ${key}`}
                onClick={() => setAccent(key)}
              />
            ))}
          </div>
        </div>
        <Toggle
          checked={soundEnabled}
          onChange={setSoundEnabled}
          label="Sons de notification"
          description="Petit son lors d’un nouveau message, app ouverte."
        />
      </section>

      <section className="settings-card">
        <h3><IonIcon icon={notificationsOutline} /> Notifications</h3>
        <div className="settings-line">
          <div>
            <strong>Notifications push</strong>
            <span>
              {!pushChecked ? 'Vérification de l’abonnement…' : pushPermission === 'denied' ? 'Bloquées par le navigateur. Autorisez-les dans les réglages du site.' : pushEnabled ? 'Actives sur cet appareil.' : 'Non activées sur cet appareil. Les autres appareils du compte restent indépendants.'}
              {installed ? ' Application installée.' : ''}
            </span>
          </div>
          <button type="button" className={`btn ${pushEnabled ? 'ghost' : 'primary'} small`} onClick={() => void togglePush()} disabled={pushBusy}>
            {pushBusy ? <Spinner size={16} /> : <IonIcon icon={powerOutline} />}
            {pushEnabled ? 'Désactiver' : 'Activer'}
          </button>
        </div>
        {pushDevices.length > 0 && (
          <div className="push-devices">
            <div className="push-devices-head">
              Appareils abonnés <Tag tone="accent">{pushDevices.length}</Tag>
            </div>
            {pushDevices.map((d) => (
              <div key={d.id} className={`push-device ${d.current ? 'current' : ''}`}>
                <span className="push-device-icon"><IonIcon icon={phonePortraitOutline} /></span>
                <div className="push-device-text">
                  <strong>
                    {describeDevice(d.ua)}
                    {d.current && <Tag tone="accent">cet appareil</Tag>}
                  </strong>
                  <span>
                    Ajouté le {new Date(d.createdAt * 1000).toLocaleDateString('fr-FR')}
                    {d.lastOk ? ` · dernière notification ${formatListTime(d.lastOk)}` : ' · aucune notification reçue'}
                  </span>
                </div>
                {!d.current && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => void removePushDevice(d)}
                    disabled={pushBusy}
                    aria-label={`Retirer ${describeDevice(d.ua)}`}
                    title="Retirer cet appareil"
                  >
                    <IonIcon icon={trashOutline} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {pushEnabled && (
          <div className="settings-line">
            <div><strong>Tester</strong><span>Envoie une notification à vos appareils abonnés.</span></div>
            <button type="button" className="btn ghost small" onClick={() => void testNotification()} disabled={pushBusy}>
              <IonIcon icon={refreshOutline} /> Envoyer un test
            </button>
          </div>
        )}
        <Toggle checked={me.notif.messages} onChange={(v) => void updateNotif({ messages: v })} label="Messages privés" description="Notifications pour les conversations individuelles." />
        <Toggle checked={me.notif.groups} onChange={(v) => void updateNotif({ groups: v })} label="Messages de groupe" description="Notifications pour les groupes (hors conversations en sourdine)." />
        <Toggle checked={me.notif.preview} onChange={(v) => void updateNotif({ preview: v })} label="Aperçu du message" description="Affiche le contenu du message dans la notification." />
        <Toggle checked={me.notif.sound} onChange={(v) => void updateNotif({ sound: v })} label="Son des notifications push" />
        <Toggle checked={me.notif.badge} onChange={(v) => void updateNotif({ badge: v })} label="Badge sur l’icône" description="Nombre de messages non lus sur l’icône de la PWA." />
        {canInstall && (
          <div className="install-banner">
            <IonIcon icon={cloudDownloadOutline} />
            <div><strong>Installer Pulse</strong><span>Accès plein écran et notifications sur iPhone.</span></div>
            <button type="button" className="btn primary small" onClick={() => void install()}>Installer</button>
          </div>
        )}
      </section>

      <section className="settings-card">
        <h3><IonIcon icon={lockClosedOutline} /> Confidentialité</h3>
        <div className="settings-line">
          <div><strong>Dernière connexion</strong><span>Qui peut voir votre présence et votre dernière activité.</span></div>
          <select value={me.privacy.lastSeen} onChange={(e) => void updatePrivacy({ lastSeen: e.target.value as PrivacyValue })}>
            <option value="everyone">Tout le monde</option>
            <option value="contacts">Mes contacts</option>
            <option value="nobody">Personne</option>
          </select>
        </div>
        <div className="settings-line">
          <div><strong>Photo de profil</strong><span>Qui peut voir votre photo.</span></div>
          <select value={me.privacy.profilePhoto} onChange={(e) => void updatePrivacy({ profilePhoto: e.target.value as PrivacyValue })}>
            <option value="everyone">Tout le monde</option>
            <option value="contacts">Mes contacts</option>
            <option value="nobody">Personne</option>
          </select>
        </div>
        <button type="button" className="settings-link" onClick={() => setShowPassword((v) => !v)}>
          <IonIcon icon={shieldCheckmarkOutline} />
          <span><strong>Changer mon mot de passe</strong><em>Sécurisez votre compte.</em></span>
          <IonIcon icon={pencilOutline} />
        </button>
        {showPassword && (
          <form className="password-form" onSubmit={changePassword}>
            <Field label="Mot de passe actuel">
              <input type="password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} required autoComplete="current-password" />
            </Field>
            <div className="settings-grid-2">
              <Field label="Nouveau mot de passe">
                <input type="password" value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} required minLength={8} autoComplete="new-password" />
              </Field>
              <Field label="Confirmer">
                <input type="password" value={passwords.confirm} onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })} required autoComplete="new-password" />
              </Field>
            </div>
            <button type="submit" className="btn primary" disabled={passwordBusy}>
              {passwordBusy ? <Spinner size={18} /> : <IonIcon icon={lockClosedOutline} />} Mettre à jour
            </button>
          </form>
        )}
      </section>

      {isAdmin && (
        <section className="settings-card admin-card">
          <h3><IonIcon icon={statsChartOutline} /> Administration</h3>
          {stats && (
            <div className="stats-grid">
              <div><strong>{stats.users}</strong><span>Utilisateurs</span></div>
              <div><strong>{stats.online}</strong><span>En ligne</span></div>
              <div><strong>{stats.conversations}</strong><span>Conversations</span></div>
              <div><strong>{stats.messages}</strong><span>Messages</span></div>
              <div><strong>{stats.mediaCount}</strong><span>Médias</span></div>
              <div><strong>{(stats.mediaBytes / (1024 * 1024)).toFixed(1)} Mo</strong><span>Stockage</span></div>
            </div>
          )}

          <div className="section-head">
            <h4><IonIcon icon={peopleOutline} /> Comptes</h4>
            <button type="button" className="text-btn" onClick={() => setShowAdminInvites((v) => !v)}>
              <IonIcon icon={addOutline} /> Invitations
            </button>
          </div>
          <div className="search-box">
            <IonIcon icon={mailOutline} />
            <input value={adminQ} onChange={(e) => setAdminQ(e.target.value)} placeholder="Rechercher un compte…" />
          </div>
          <div className="admin-user-list">
            {filteredAdminUsers.map((u) => (
              <div key={u.id} className={`admin-user-row ${u.active === false ? 'disabled' : ''}`}>
                <Avatar id={u.id} name={u.name} avatarId={u.avatarId} size={40} online={u.online} />
                <span className="admin-user-info">
                  <strong>{u.name} {u.id === me.id && <em>(vous)</em>}</strong>
                  <span>@{u.username} · {u.email}</span>
                  <small>{u.active === false ? 'Compte désactivé' : u.online ? 'En ligne' : lastSeenLabel(u.lastSeen)}</small>
                </span>
                <Tag tone={u.role === 'admin' ? 'accent' : 'default'}>{u.role === 'admin' ? 'Admin' : 'Membre'}</Tag>
                {u.id !== me.id && (
                  <div className="admin-user-actions">
                    {u.active === false ? (
                      <button type="button" className="btn tiny ghost" onClick={() => void reactivate(u)} disabled={adminBusy === u.id}>Réactiver</button>
                    ) : (
                      <button
                        type="button"
                        className="btn tiny ghost"
                        disabled={adminBusy === u.id}
                        onClick={() => setConfirmUser({ user: u, action: u.role === 'admin' ? 'demote' : 'promote' })}
                      >
                        {u.role === 'admin' ? 'Retirer admin' : 'Nommer admin'}
                      </button>
                    )}
                    {u.active !== false && (
                      <button type="button" className="icon-btn danger" title="Désactiver" onClick={() => setConfirmUser({ user: u, action: 'deactivate' })}>
                        <IonIcon icon={powerOutline} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {showAdminInvites && (
            <div className="admin-invites">
              <h4>Toutes les invitations</h4>
              <InviteManager />
            </div>
          )}
        </section>
      )}

      <section className="settings-card">
        <h3><IonIcon icon={serverOutline} /> Application</h3>
        <div className="settings-line">
          <div><strong>Version</strong><span>Pulse PWA</span></div>
          <Tag>{__APP_VERSION__}</Tag>
        </div>
        <div className="settings-line">
          <div><strong>Adresse de l’API</strong><span className="mono">{settings.apiURL}</span></div>
          <button type="button" className="btn ghost small" onClick={() => setServerEditing((v) => !v)}>Modifier</button>
        </div>
        {serverEditing && (
          <div className="server-edit">
            <Field label="URL de l’API PHP" hint="Ex. https://votre-domaine.fr/api-messagerie.php">
              <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
            </Field>
            <button type="button" className="btn primary small" onClick={saveServerUrl}>Enregistrer l’adresse</button>
          </div>
        )}
        <div className="settings-line">
          <div><strong>Installation</strong><span>{installed ? 'Pulse est installée sur cet appareil.' : canInstall ? 'Installez Pulse pour un accès plein écran.' : 'Utilisez le menu du navigateur → Installer l’application.'}</span></div>
          {canInstall && <button type="button" className="btn primary small" onClick={() => void install()}><IonIcon icon={cloudDownloadOutline} /> Installer</button>}
        </div>
        <div className="settings-line">
          <div><strong>Confidentialité des données</strong><span>Hébergement sur votre serveur PHP, base SQLite. Aucun tiers.</span></div>
          <IonIcon icon={informationCircleOutline} className="muted" />
        </div>
      </section>

      <button type="button" className="logout-block" onClick={() => setConfirmLogout(true)}>
        <IonIcon icon={logOutOutline} /> Se déconnecter de Pulse
      </button>
      <p className="settings-foot">Pulse · messagerie privée · v{__APP_VERSION__}</p>

      <ConfirmDialog
        open={!!confirmUser}
        onClose={() => setConfirmUser(null)}
        onConfirm={() => void doAdminAction()}
        title={confirmUser?.action === 'deactivate' ? 'Désactiver ce compte ?' : confirmUser?.action === 'promote' ? 'Nommer administrateur ?' : 'Retirer le rôle admin ?'}
        message={confirmUser?.action === 'deactivate'
          ? `${confirmUser.user.name} ne pourra plus se connecter. Ses messages restent visibles.`
          : confirmUser?.action === 'promote'
            ? `${confirmUser.user.name} pourra gérer les comptes et les invitations.`
            : `${confirmUser?.user.name} redeviendra un membre simple.`}
        confirmLabel="Confirmer"
        danger={confirmUser?.action !== 'promote'}
      />
      <ConfirmDialog
        open={confirmLogout}
        onClose={() => setConfirmLogout(false)}
        onConfirm={() => void logout()}
        title="Se déconnecter ?"
        message="Vous ne recevrez plus de notifications sur cet appareil."
        confirmLabel="Se déconnecter"
        danger
      />
    </div>
  );
}
