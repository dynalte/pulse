import React from 'react';
import { useHistory, useLocation, Route, Switch } from 'react-router-dom';
import { IonIcon } from '@ionic/react';
import {
  chatbubblesOutline, peopleOutline, settingsOutline, addOutline, personAddOutline,
  arrowForwardOutline, shieldCheckmarkOutline, notificationsOutline, imagesOutline, micOutline,
  timeOutline, sparklesOutline,
} from 'ionicons/icons';
import { AppProvider, useApp } from './context/AppContext';
import { LoadingScreen, Logo, Toasts, Avatar, Badge } from './components/ui';
import AuthPage from './pages/AuthPage';
import ChatsPage from './pages/ChatsPage';
import ChatPage from './pages/ChatPage';
import ContactsPage from './pages/ContactsPage';
import SettingsPage from './pages/SettingsPage';
import NewGroupPage from './pages/NewGroupPage';
import JoinPage from './pages/JoinPage';
import { formatListTime, previewText } from './services/utils';

const Rail: React.FC = () => {
  const { me, unreadTotal, contactRequests } = useApp();
  const location = useLocation();
  const history = useHistory();
  if (!me) return null;
  const is = (p: string) => (p === '/' ? location.pathname === '/' || location.pathname.startsWith('/chat') : location.pathname.startsWith(p));
  return (
    <nav className="rail" aria-label="Navigation principale">
      <button type="button" className="rail-logo" onClick={() => history.push('/')} aria-label="Pulse, accueil">
        <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" />
      </button>
      <div className="rail-nav">
        <button type="button" className={`rail-btn ${is('/') ? 'active' : ''}`} onClick={() => history.push('/')} title="Discussions">
          <IonIcon icon={chatbubblesOutline} />
          <span>Discussions</span>
          {unreadTotal > 0 && <i className="rail-badge">{unreadTotal > 99 ? '99+' : unreadTotal}</i>}
        </button>
        <button type="button" className={`rail-btn ${location.pathname.startsWith('/contacts') || location.pathname.startsWith('/new-group') ? 'active' : ''}`} onClick={() => history.push('/contacts')} title="Contacts">
          <IonIcon icon={peopleOutline} />
          <span>Contacts</span>
          {contactRequests > 0 && <i className="rail-badge">{contactRequests > 99 ? '99+' : contactRequests}</i>}
        </button>
        <button type="button" className={`rail-btn ${location.pathname.startsWith('/settings') ? 'active' : ''}`} onClick={() => history.push('/settings')} title="Réglages">
          <IonIcon icon={settingsOutline} />
          <span>Réglages</span>
        </button>
      </div>
      <div className="rail-foot">
        <button type="button" className="rail-avatar" onClick={() => history.push('/settings')} title={`${me.name} — profil`}>
          <Avatar id={me.id} name={me.name} avatarId={me.avatarId} size={40} online={me.online} />
        </button>
      </div>
    </nav>
  );
};

const MobileTabs: React.FC = () => {
  const { unreadTotal, contactRequests } = useApp();
  const location = useLocation();
  const history = useHistory();
  const active = location.pathname === '/' || location.pathname.startsWith('/chat') ? 'chats'
    : location.pathname.startsWith('/contacts') || location.pathname.startsWith('/new-group') ? 'contacts'
      : location.pathname.startsWith('/settings') ? 'settings' : 'chats';
  return (
    <nav className="mobile-tabs" aria-label="Navigation">
      <button type="button" className={active === 'chats' ? 'active' : ''} onClick={() => history.push('/')}>
        <span className="tab-icon"><IonIcon icon={chatbubblesOutline} />{unreadTotal > 0 && <i>{unreadTotal > 99 ? '99+' : unreadTotal}</i>}</span>
        Discussions
      </button>
      <button type="button" className={active === 'contacts' ? 'active' : ''} onClick={() => history.push('/contacts')}>
        <span className="tab-icon">
          <IonIcon icon={peopleOutline} />
          {contactRequests > 0 && <i>{contactRequests > 99 ? '99+' : contactRequests}</i>}
        </span>
        Contacts
      </button>
      <button type="button" className={active === 'settings' ? 'active' : ''} onClick={() => history.push('/settings')}>
        <span className="tab-icon"><IonIcon icon={settingsOutline} /></span>
        Réglages
      </button>
    </nav>
  );
};

const WelcomePane: React.FC = () => {
  const { me, conversations } = useApp();
  const history = useHistory();
  if (!me) return null;
  const recent = conversations.filter((c) => !c.archived).slice(0, 4);
  return (
    <div className="welcome-pane">
      <div className="welcome-glow" aria-hidden="true" />
      <div className="welcome-hero">
        <Logo size={62} />
        <span className="welcome-kicker"><IonIcon icon={sparklesOutline} /> Messagerie privée · sur invitation</span>
        <h1>Vos conversations,<br /><em>en toute intimité.</em></h1>
        <p>
          Discutez en direct, créez des groupes, partagez photos et messages vocaux.
          Pulse est hébergé sur votre serveur, sans publicité ni tiers.
        </p>
        <div className="welcome-actions">
          <button type="button" className="btn primary" onClick={() => history.push('/contacts')}>
            <IonIcon icon={addOutline} /> Nouvelle discussion
          </button>
          <button type="button" className="btn ghost" onClick={() => history.push('/new-group')}>
            <IonIcon icon={peopleOutline} /> Créer un groupe
          </button>
        </div>
      </div>

      <div className="welcome-features">
        <div><span><IonIcon icon={shieldCheckmarkOutline} /></span><strong>Contrôlé</strong><em>Chaque compte est invité. Bloquez, masquez, gérez.</em></div>
        <div><span><IonIcon icon={notificationsOutline} /></span><strong>Notifications</strong><em>Web Push paramétrable, app fermée incluse.</em></div>
        <div><span><IonIcon icon={imagesOutline} /></span><strong>Médias</strong><em>Photos compressées, documents et vocaux.</em></div>
        <div><span><IonIcon icon={micOutline} /></span><strong>Vocaux</strong><em>Enregistrement waveform et lecture rapide.</em></div>
      </div>

      {recent.length > 0 && (
        <div className="welcome-recent">
          <div className="section-head"><h3><IonIcon icon={timeOutline} /> Reprendre</h3><button type="button" className="text-btn" onClick={() => history.push('/')}>Tout voir</button></div>
          <div className="recent-grid">
            {recent.map((c) => (
              <button key={c.id} type="button" className="recent-card" onClick={() => history.push(`/chat/${c.id}`)}>
                <Avatar id={c.type === 'group' ? c.id + 3 : c.peer?.id || c.id} name={c.title} avatarId={c.avatarId} size={44} group={c.type === 'group'} online={c.peer?.online} />
                <span className="recent-main">
                  <strong>{c.title}</strong>
                  <em>{c.lastMessage ? previewText(c.lastMessage.type, c.lastMessage.body, c.lastMessage.deleted) : 'Nouvelle conversation'}</em>
                </span>
                <span className="recent-side">
                  <time>{formatListTime(c.lastMessage?.createdAt || c.updatedAt)}</time>
                  <Badge count={c.unread} />
                </span>
                <IonIcon icon={arrowForwardOutline} className="recent-arrow" />
              </button>
            ))}
          </div>
        </div>
      )}

      {conversations.length === 0 && (
        <button type="button" className="welcome-invite" onClick={() => history.push('/contacts')}>
          <IonIcon icon={personAddOutline} />
          <span><strong>Invitez vos premiers proches</strong><em>Créez un lien d’invitation, partagez-le, discutons.</em></span>
          <IonIcon icon={arrowForwardOutline} />
        </button>
      )}

      <footer className="welcome-foot">
        <span className={`server-dot ok`} /> Hébergé sur votre serveur · PHP + SQLite
      </footer>
    </div>
  );
};

const Shell: React.FC = () => {
  const location = useLocation();
  const path = location.pathname;
  const isChat = path.startsWith('/chat/');
  const isJoin = path.startsWith('/invite/');
  const mobileFull = path !== '/' && path !== '/chats';
  return (
    <div className={`app-shell ${mobileFull ? 'mobile-full' : ''} ${isChat ? 'chat-open' : ''}`}>
      <Rail />
      <aside className="list-pane"><ChatsPage /></aside>
      <main className="main-pane">
        <Switch>
          <Route exact path="/" component={WelcomePane} />
          <Route path="/chat/:id" component={ChatPage} />
          <Route exact path="/contacts" component={ContactsPage} />
          <Route exact path="/settings" component={SettingsPage} />
          <Route exact path="/new-group" component={NewGroupPage} />
          <Route path="/invite/:code" component={JoinPage} />
          <Route render={() => <WelcomePane />} />
        </Switch>
      </main>
      {!isChat && !isJoin && <MobileTabs />}
    </div>
  );
};

const Root: React.FC = () => {
  const { me, booting } = useApp();
  const location = useLocation();
  if (booting) return <LoadingScreen />;
  if (!me) {
    return (
      <Switch>
        <Route path="/invite/:code" component={JoinPage} />
        <Route render={() => <AuthPage />} />
      </Switch>
    );
  }
  return <Shell />;
};

const App: React.FC = () => (
  <AppProvider>
    <Root />
    <Toasts />
  </AppProvider>
);

export default App;
