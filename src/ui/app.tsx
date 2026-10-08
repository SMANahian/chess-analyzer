// App shell: header + nav (desktop), bottom tab bar (mobile), routing, toasts, update prompt,
// boot/fatal states and a crash boundary. Pages Leaks/Train/Openings/Scout are loaded lazily from
// ./pages/<Name>.tsx when present (each default-exports a component taking PageProps).
import { useSignalEffect } from '@preact/signals';
import { Component, type ComponentChildren, type ComponentType, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as store from '../state/store';
import { CopyButton } from './components/buttons';
import { bootError, bootState, collectDiagnostics, errorText } from './components/diagnostics';
import { EmptyState } from './components/EmptyState';
import { Icon, type IconName } from './components/Icon';
import { Banner, NoticeHost, ToastView } from './components/Notice';
import { JobStatusPill } from './components/ProgressCard';
import { Sheet } from './components/Modal';
import { Spinner } from './components/Spinner';
import About from './pages/About';
import Dashboard from './pages/Dashboard';
import Onboarding from './pages/Onboarding';
import Settings from './pages/Settings';
import { href, route, type PageProps, type Route, type RouteName } from './router';
import { applyTheme } from './theme';

// ── Pages ───────────────────────────────────────────────────────────────
interface PageModule {
  default: ComponentType<PageProps>;
}
/** Pages built in other modules; a file that does not exist yet shows a placeholder. */
const LAZY_PAGES = import.meta.glob<PageModule>(['./pages/Leaks.tsx', './pages/Train.tsx', './pages/Openings.tsx', './pages/Scout.tsx']);
const LAZY_FILE: Partial<Record<RouteName, string>> = {
  leaks: './pages/Leaks.tsx',
  train: './pages/Train.tsx',
  openings: './pages/Openings.tsx',
  scout: './pages/Scout.tsx',
};
if (import.meta.env.DEV) {
  // Component gallery at #/dev (development server only; removed from production builds).
  LAZY_PAGES.dev = () => import('./components/Gallery.dev');
}
const loadedPages = new Map<string, ComponentType<PageProps>>();

function LazyPage({ file, route: r }: { file: string; route: Route }): JSX.Element {
  const [Page, setPage] = useState<ComponentType<PageProps> | undefined>(() => loadedPages.get(file));
  const [failed, setFailed] = useState<unknown>(null);
  useEffect(() => {
    const cached = loadedPages.get(file);
    if (cached) {
      setPage(() => cached);
      return;
    }
    const load = LAZY_PAGES[file];
    if (!load) return;
    let live = true;
    load()
      .then(mod => {
        loadedPages.set(file, mod.default);
        if (live) setPage(() => mod.default);
      })
      .catch(err => live && setFailed(err));
    return () => {
      live = false;
    };
  }, [file]);
  if (!LAZY_PAGES[file]) {
    return (
      <EmptyState icon="clock" title="Coming soon">
        This part of Chess Analyzer is still being built.
      </EmptyState>
    );
  }
  if (failed) {
    return (
      <EmptyState icon="alert" title="This page didn’t load" actions={<ReloadButton />}>
        You may be offline, or a new version was published. Reload to try again.
      </EmptyState>
    );
  }
  return Page ? <Page route={r} /> : <PageLoading />;
}

function PageLoading(): JSX.Element {
  // Only show a spinner when loading is noticeably slow.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setVisible(true), 250);
    return () => clearTimeout(id);
  }, []);
  return <div class="loading-shell">{visible ? <Spinner label="Loading page" size={28} /> : null}</div>;
}

const NEEDS_PROFILE: ReadonlySet<RouteName> = new Set(['leaks', 'train', 'openings']);

function NeedsProfile(): JSX.Element {
  return (
    <EmptyState
      icon="leaks"
      title="Connect your games first"
      actions={
        <a class="btn btn-primary" href={href('home')}>
          Get started
        </a>
      }
    >
      Enter your Lichess or Chess.com username (or upload a PGN) and this page fills with your own repeated mistakes.
    </EmptyState>
  );
}

function NotFound(): JSX.Element {
  return (
    <EmptyState
      icon="alert"
      title="Page not found"
      actions={
        <a class="btn" href={href('home')}>
          Go to Home
        </a>
      }
    >
      The link may be old or mistyped.
    </EmptyState>
  );
}

function PageFor({ r }: { r: Route }): JSX.Element {
  const self = store.selfProfile.value;
  if (r.name === 'home') {
    if (!self && bootState.value === 'loading') return <BootSplash />;
    return self ? <Dashboard route={r} /> : <Onboarding route={r} />;
  }
  if (r.name === 'settings') return <Settings route={r} />;
  if (r.name === 'about') return <About route={r} />;
  if (r.name === 'not-found') {
    if (import.meta.env.DEV && r.path === '/dev') return <LazyPage file="dev" route={r} />;
    return <NotFound />;
  }
  if (bootState.value === 'loading') return <BootSplash />;
  // A prep drill (#/train?scout=<id>) trains a scouted player's leaks: no own profile needed.
  if (!self && NEEDS_PROFILE.has(r.name) && !(r.name === 'train' && r.query.scout)) return <NeedsProfile />;
  const file = LAZY_FILE[r.name];
  return file ? <LazyPage file={file} route={r} /> : <NotFound />;
}

function BootSplash(): JSX.Element {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(id);
  }, []);
  return (
    <div class="loading-shell">
      <Spinner label="" size={28} />
      <p>Opening your data…</p>
      {slow ? (
        <p class="small faint" style={{ maxWidth: '40ch', textAlign: 'center' }}>
          This is taking longer than usual. If Chess Analyzer is open in another tab, close it and reload this one.
        </p>
      ) : null}
    </div>
  );
}

// ── Fatal + crash ───────────────────────────────────────────────────────
function ReloadButton(): JSX.Element {
  return (
    <button type="button" class="btn" onClick={() => location.reload()}>
      <Icon name="refresh" size={18} /> Reload
    </button>
  );
}

function FatalPanel(): JSX.Element | null {
  const [hidden, setHidden] = useState(false);
  if (bootState.value !== 'failed' || hidden) return null;
  const err = bootError.value;
  return (
    <div class="fatal">
      <Banner
        tone="danger"
        title="Chess Analyzer couldn’t open its storage"
        onDismiss={() => setHidden(true)}
        actions={
          <>
            <ReloadButton />
            <CopyButton text={() => collectDiagnostics(err)} label="Copy diagnostics" class="btn" />
          </>
        }
      >
        <p>
          Your browser may be blocking site storage (private browsing, strict privacy settings) or be too old. You can look
          around, but nothing will be saved. Try a normal window or another browser — and if that doesn’t help, copy the
          diagnostics into a GitHub issue.
        </p>
      </Banner>
      <details class="small">
        <summary class="muted">Technical details</summary>
        <pre>{errorText(err)}</pre>
      </details>
    </div>
  );
}

interface BoundaryState {
  error: unknown;
}

/**
 * Catches render errors of one page so the shell and navigation keep working. Keyed by route name, so a
 * page stays mounted while only its id changes (the Leaks list keeps its scroll position); a crash is
 * cleared when the path changes.
 */
class PageBoundary extends Component<{ children: ComponentChildren; resetKey: string }, BoundaryState> {
  override state: BoundaryState = { error: null };
  static override getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }
  override componentDidCatch(error: unknown): void {
    console.error('Page crashed', error);
  }
  override componentDidUpdate(prev: { resetKey: string }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  override render(): ComponentChildren {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <EmptyState
        icon="alert"
        title="Something broke on this page"
        actions={
          <>
            <a class="btn" href={href('home')}>
              Go to Home
            </a>
            <ReloadButton />
            <CopyButton text={() => collectDiagnostics(error)} label="Copy diagnostics" class="btn" />
          </>
        }
      >
        Your data is safe. Reloading usually fixes it; if not, please report it with the diagnostics.
      </EmptyState>
    );
  }
}

// ── Navigation ──────────────────────────────────────────────────────────
interface NavItem {
  name: Exclude<RouteName, 'not-found'>;
  label: string;
  icon: IconName;
}
const PRIMARY_NAV: readonly NavItem[] = [
  { name: 'home', label: 'Home', icon: 'home' },
  { name: 'leaks', label: 'Leaks', icon: 'leaks' },
  { name: 'train', label: 'Train', icon: 'train' },
  { name: 'openings', label: 'Openings', icon: 'openings' },
];
const MORE_NAV: readonly (NavItem & { sub: string })[] = [
  { name: 'scout', label: 'Scout', icon: 'scout', sub: 'Prepare for an opponent' },
  { name: 'settings', label: 'Settings', icon: 'settings', sub: 'Accounts, analysis, backup' },
  { name: 'about', label: 'About & FAQ', icon: 'about', sub: 'How it works, privacy, credits' },
];

const current = (r: Route, name: RouteName): 'page' | undefined => (r.name === name ? 'page' : undefined);

function Brand(): JSX.Element {
  return (
    <a class="brand" href={href('home')} aria-label="Chess Analyzer — home">
      <img class="brand-mark" src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={28} height={28} />
      <span>Chess Analyzer</span>
    </a>
  );
}

function Header({ r, minimal }: { r: Route; minimal: boolean }): JSX.Element {
  const due = store.dueCount.value;
  return (
    <header class="app-header">
      <div class="app-header-inner">
        <Brand />
        {minimal ? (
          <nav class="top-nav-end" aria-label="Site">
            <a class="nav-link" href={href('about')} aria-current={current(r, 'about')}>
              About
            </a>
            <a class="nav-link" href={href('settings')} aria-current={current(r, 'settings')}>
              Settings
            </a>
          </nav>
        ) : (
          <>
            <nav class="top-nav top-nav-main" aria-label="Main">
              {PRIMARY_NAV.map(item => (
                <a key={item.name} class="nav-link" href={href(item.name)} aria-current={current(r, item.name)}>
                  {item.label}
                  {item.name === 'train' && due > 0 ? (
                    <span class="nav-badge" aria-label={`${due} due`}>
                      {due > 99 ? '99+' : due}
                    </span>
                  ) : null}
                </a>
              ))}
              <a class="nav-link" href={href('scout')} aria-current={current(r, 'scout')}>
                Scout
              </a>
            </nav>
            <div class="header-status">
              <JobStatusPill href={href('home')} />
            </div>
            <nav class="top-nav top-nav-end" aria-label="Secondary">
              <a class="nav-link" href={href('settings')} aria-current={current(r, 'settings')}>
                <Icon name="settings" size={18} />
                Settings
              </a>
              <a class="nav-link" href={href('about')} aria-current={current(r, 'about')}>
                About
              </a>
            </nav>
          </>
        )}
      </div>
    </header>
  );
}

function TabBar({ r }: { r: Route }): JSX.Element {
  const [moreOpen, setMoreOpen] = useState(false);
  const due = store.dueCount.value;
  const inMore = MORE_NAV.some(i => i.name === r.name);
  useEffect(() => setMoreOpen(false), [r.path]);
  return (
    <>
      <nav class="tab-bar" aria-label="Main">
        {PRIMARY_NAV.map(item => (
          <a key={item.name} class="tab-item" href={href(item.name)} aria-current={current(r, item.name)}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {item.name === 'train' && due > 0 ? (
              <span class="nav-badge" aria-label={`${due} due`}>
                {due > 99 ? '99+' : due}
              </span>
            ) : null}
          </a>
        ))}
        <button
          type="button"
          class="tab-item"
          aria-current={inMore ? 'page' : undefined}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <Icon name="more" />
          <span>More</span>
        </button>
      </nav>
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <ul class="menu-list">
          {MORE_NAV.map(item => (
            <li key={item.name}>
              <a class="menu-link" href={href(item.name)} aria-current={current(r, item.name)} onClick={() => setMoreOpen(false)}>
                <Icon name={item.icon} size={22} />
                <span>
                  {item.label}
                  <span class="menu-sub">{item.sub}</span>
                </span>
                <Icon name="chevron" size={18} class="menu-chevron" />
              </a>
            </li>
          ))}
        </ul>
      </Sheet>
    </>
  );
}

function Footer(): JSX.Element {
  return (
    <footer class="app-footer">
      <p>
        Chess Analyzer is free and open source (
        <a href="https://github.com/SMANahian/chess-analyzer" target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
        ). Not affiliated with Lichess or Chess.com. Your data stays in this browser.
      </p>
    </footer>
  );
}

function UpdatePrompt(): JSX.Element | null {
  const [later, setLater] = useState(false);
  const apply = store.updateAvailable.value;
  if (!apply || later || store.busy.value) return null;
  return (
    <ToastView kind="info" action={{ label: 'Reload', run: () => apply() }} onClose={() => setLater(true)}>
      A new version of Chess Analyzer is available.
    </ToastView>
  );
}

/** Moves focus to <main> on page changes so screen readers announce the new page. */
function useFocusOnNavigate(path: string): { current: HTMLElement | null } {
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [path]);
  return main;
}

export function App(): JSX.Element {
  const r = route.value;
  const minimal = !store.selfProfile.value;
  const main = useFocusOnNavigate(r.path);

  // Settings own the theme once loaded (before that, the pre-paint choice from localStorage stands).
  useSignalEffect(() => {
    if (bootState.value === 'ready') applyTheme(store.settings.value.theme);
  });

  return (
    <div class="app" data-shell={minimal ? 'minimal' : 'full'}>
      <a class="skip-link" href="#main" onClick={e => (e.preventDefault(), main.current?.focus())}>
        Skip to content
      </a>
      <Header r={r} minimal={minimal} />
      <main id="main" class="app-main" ref={main} tabIndex={-1}>
        <FatalPanel />
        <PageBoundary key={r.name} resetKey={r.path}>
          <PageFor r={r} />
        </PageBoundary>
      </main>
      <Footer />
      {minimal ? null : <TabBar r={r} />}
      <NoticeHost>
        <UpdatePrompt />
      </NoticeHost>
    </div>
  );
}
