import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { IonApp, setupIonicReact } from '@ionic/react';

import '@ionic/react/css/core.css';
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';

import './styles/app.css';
import App from './App';

setupIonicReact({ mode: 'md' });

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <IonApp>
      <HashRouter>
        <App />
      </HashRouter>
    </IonApp>
  </React.StrictMode>,
);
