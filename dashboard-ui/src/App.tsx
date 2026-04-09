import { useEffect, useState } from 'react';
import OverviewPage  from './pages/OverviewPage';
import FailuresPage  from './pages/FailuresPage';
import ActionsPage   from './pages/ActionsPage';
import './index.css';

type Tab = 'overview' | 'failures' | 'actions';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',  label: 'Overview' },
  { id: 'failures',  label: 'Failures' },
  { id: 'actions',   label: 'Actions'  },
];

function getTab(): Tab {
  const p = new URLSearchParams(window.location.search).get('tab');
  return (p === 'failures' || p === 'actions') ? p : 'overview';
}

function getEmbed(): boolean {
  return new URLSearchParams(window.location.search).get('embed') === 'true';
}

export default function App() {
  const [tab,   setTab]   = useState<Tab>(getTab);
  const [embed] = useState<boolean>(getEmbed);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', url.toString());
  }, [tab]);

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: embed ? '8px 16px' : '24px 16px' }}>
      {!embed && (
        <header style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', marginBottom: 4 }}>
            🔮 Oracle Dashboard
          </h1>
          <p style={{ color: 'var(--color-muted)', fontSize: 12 }}>
            Read-only view of AI Oracle triage data
          </p>
        </header>
      )}

      <nav style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--color-border)', paddingBottom: 0 }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '8px 16px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: tab === t.id ? 'var(--color-accent)' : 'var(--color-muted)',
              fontWeight: tab === t.id ? 600 : 400,
              borderBottom: tab === t.id ? '2px solid var(--color-accent)' : '2px solid transparent',
              marginBottom: -1,
              fontSize: 14,
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'overview'  && <OverviewPage />}
        {tab === 'failures'  && <FailuresPage />}
        {tab === 'actions'   && <ActionsPage  />}
      </main>
    </div>
  );
}
