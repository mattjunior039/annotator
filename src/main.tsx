import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { GuestApp } from './app/GuestApp';
import { takeInviteFromLocation } from './collaboration/invite';
import './app/styles.css';

// Read once and strip from the address bar before rendering so the key is not kept in history.
const initialInvite = takeInviteFromLocation();
const initialShare = window.location.hash.startsWith('#share=') ? window.location.href : '';
if (initialShare) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);

function Root() {
  const [invite, setInvite] = useState(initialInvite);
  return invite ? <GuestApp invite={invite} onExit={() => setInvite(null)} /> : <App initialShare={initialShare} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing.');
createRoot(root).render(<StrictMode><Root /></StrictMode>);
