import { create } from 'zustand';
import type { CompanionStatus, KeyView, NavState, ServerMessage, SessionUser, ViewSnapshot } from '@pch/shared';

export type SocketState = 'connecting' | 'open' | 'closed';
export type Route = 'operate' | 'edit' | 'settings';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface KeyFeedback {
  state: 'armed' | 'fired' | 'rejected';
  at: number;
}

interface AppState {
  user: SessionUser | null;
  setupRequired: boolean;
  authChecked: boolean;
  version: string;
  socket: SocketState;
  companion: CompanionStatus | null;
  view: ViewSnapshot | null;
  keys: KeyView[];
  feedback: Record<number, KeyFeedback>;
  toasts: Toast[];
  route: Route;
  setAuth(user: SessionUser | null, setupRequired: boolean, version?: string): void;
  setSocket(s: SocketState): void;
  apply(msg: ServerMessage): void;
  toast(level: Toast['level'], message: string): void;
  dismiss(id: number): void;
  setRoute(r: Route): void;
}

const NAV_KEY = 'pch.nav';

export function loadSavedNav(): NavState | null {
  try {
    const raw = localStorage.getItem(NAV_KEY);
    return raw ? (JSON.parse(raw) as NavState) : null;
  } catch {
    return null;
  }
}

function saveNav(nav: NavState | null) {
  try {
    if (nav) localStorage.setItem(NAV_KEY, JSON.stringify(nav));
  } catch {
    /* storage unavailable (private mode) */
  }
}

function routeFromHash(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  return h === 'edit' || h === 'settings' ? h : 'operate';
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  user: null,
  setupRequired: false,
  authChecked: false,
  version: '',
  socket: 'closed',
  companion: null,
  view: null,
  keys: [],
  feedback: {},
  toasts: [],
  route: routeFromHash(),
  setAuth: (user, setupRequired, version) => set({ user, setupRequired, authChecked: true, ...(version ? { version } : {}) }),
  setSocket: (socket) => set(socket === 'open' ? { socket } : { socket, feedback: {} }),
  apply: (msg) => {
    switch (msg.type) {
      case 'welcome':
        set({ user: msg.user, version: msg.version });
        break;
      case 'status':
        set({ companion: msg.companion });
        break;
      case 'view':
        saveNav(msg.view.nav);
        set({ view: msg.view, feedback: {} });
        break;
      case 'keys':
        set({ keys: msg.keys });
        break;
      case 'key': {
        const keys = get().keys.slice();
        keys[msg.key.index] = msg.key;
        set({ keys });
        break;
      }
      case 'feedback': {
        const feedback = { ...get().feedback };
        if (msg.state === 'idle') delete feedback[msg.index];
        else feedback[msg.index] = { state: msg.state, at: Date.now() };
        set({ feedback });
        if (msg.state === 'rejected' && msg.message) get().toast('warn', msg.message);
        if (msg.state === 'fired' || msg.state === 'rejected') {
          setTimeout(() => {
            const f = { ...useApp.getState().feedback };
            if (f[msg.index]?.state === msg.state) {
              delete f[msg.index];
              useApp.setState({ feedback: f });
            }
          }, 600);
        }
        break;
      }
      case 'notice':
        get().toast(msg.level, msg.message);
        break;
      default:
        break;
    }
  },
  toast: (level, message) => {
    const id = ++toastId;
    // Collapse duplicates so a stuck condition doesn't flood the screen.
    const existing = get().toasts.filter((t) => t.message !== message).slice(-3);
    set({ toasts: [...existing, { id, level, message }] });
    setTimeout(() => get().dismiss(id), level === 'error' ? 7000 : 4000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setRoute: (route) => {
    location.hash = route === 'operate' ? '' : `/${route}`;
    set({ route });
  },
}));

window.addEventListener('hashchange', () => useApp.setState({ route: routeFromHash() }));

export function canPress(u: SessionUser | null) {
  return u?.role === 'admin' || u?.role === 'operator';
}
export function isAdmin(u: SessionUser | null) {
  return u?.role === 'admin';
}
