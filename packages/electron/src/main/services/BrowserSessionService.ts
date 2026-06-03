/**
 * BrowserSessionService
 *
 * Main-process owner of native browser surfaces. Each session is backed by a
 * single `WebContentsView` which is attached as a child of a host BrowserWindow.
 * The renderer-side custom editor reserves a rectangle on its tab and asks this
 * service to position the WebContentsView over that rectangle. Bounds, focus,
 * navigation, and screenshot capture all live here -- the renderer never owns
 * the chromium surface directly.
 *
 * Why a host-level primitive instead of an iframe:
 *   - X-Frame-Options / CSP frame-ancestors break iframes for most real sites.
 *   - WebContentsView is a real Chromium browsing context with its own session
 *     partition, so we can run isolated navigation, capture full-page pixels,
 *     and (later) wire devtools without the renderer process being involved.
 *
 * Lifecycle:
 *   createSession() -> view created, navigated to URL (loads in background)
 *   attachToWindow() -> view installed as childView of a BrowserWindow + positioned
 *   setBounds() / detachFromWindow() -> renderer can reflow / unmount as tab changes
 *   destroySession() -> view torn down, webContents closed
 *
 * The view is sized in CSS pixels and positioned in the host window's content
 * area; conversion to device pixels happens automatically inside Electron.
 */

import { WebContentsView, BrowserWindow, session as electronSession } from 'electron';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

export interface BrowserSessionInitOptions {
  /** Stable session id chosen by the caller. */
  sessionId: string;
  /** Initial URL to load. May be a `nim-preview://`, `http(s)://`, or `about:blank` URL. */
  url: string;
  /**
   * Session partition. Plain names are in-memory and isolated to this app
   * run; use a `persist:` prefix only when the caller explicitly wants
   * Chromium storage to survive restarts.
   * Falls back to the in-memory `'preview'` partition if omitted.
   */
  partition?: string;
}

export interface BrowserSessionBounds {
  /** CSS pixels, relative to the host window's content area. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserNavigationState {
  sessionId: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Populated when the most recent navigation failed. */
  lastError?: { code: number; description: string };
}

interface SessionEntry {
  sessionId: string;
  partitionName: string;
  view: WebContentsView;
  hostWindow: BrowserWindow | null;
  bounds: BrowserSessionBounds | null;
  state: BrowserNavigationState;
}

/**
 * Pure-function bounds clamper. Exposed for unit tests so we can verify that
 * a negative or oversized rect (which Electron silently accepts) is corrected
 * before we hand it to `view.setBounds`.
 */
export function clampBounds(
  bounds: BrowserSessionBounds,
  container: { width: number; height: number },
): BrowserSessionBounds {
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  // Width/height are non-negative integers; if the requested rect extends past
  // the container we clip so we never produce a view with negative dims.
  const width = Math.max(0, Math.min(Math.floor(bounds.width), container.width - x));
  const height = Math.max(0, Math.min(Math.floor(bounds.height), container.height - y));
  return { x, y, width, height };
}

/**
 * Pure-function URL allow-list. Centralized so the renderer-facing API and the
 * service implementation agree on what counts as a safe URL to navigate to.
 *
 * Allowed schemes:
 *   - `http:` / `https:` (remote pages -- iframe-blocking sites still load here
 *     because WebContentsView is not an iframe).
 *   - `nim-preview:` (workspace-served local HTML).
 *   - `about:blank` (used to clear the view).
 *
 * Explicitly blocked:
 *   - `file:` (workspace HTML must go through `nim-preview:` so we can enforce
 *     workspace scoping in one place).
 *   - `javascript:`, `data:` (XSS surface).
 */
export function isAllowedBrowserUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (url === 'about:blank') return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'http:' ||
    parsed.protocol === 'https:' ||
    parsed.protocol === 'nim-preview:'
  );
}

export function resolveBrowserPartitionName(partition?: string): string {
  const normalized = partition?.trim() || 'preview';
  return normalized.startsWith('persist:') ? normalized : `browser-${normalized}`;
}

export class BrowserSessionService extends EventEmitter {
  private static instance: BrowserSessionService | null = null;

  private sessions = new Map<string, SessionEntry>();

  /**
   * Sessions track a single host window only; when that window is destroyed we
   * proactively tear the session down so we don't leak WebContentsView objects.
   * The map of teardown listeners is keyed by window id so we can detach on
   * `detachFromWindow` without leaving stale closures behind.
   */
  private windowCloseListeners = new Map<number, Set<string>>();

  private constructor() {
    super();
  }

  public static getInstance(): BrowserSessionService {
    if (!BrowserSessionService.instance) {
      BrowserSessionService.instance = new BrowserSessionService();
    }
    return BrowserSessionService.instance;
  }

  /**
   * Reset the singleton. Tests only.
   */
  public static __resetForTests(): void {
    if (BrowserSessionService.instance) {
      BrowserSessionService.instance.cleanup();
    }
    BrowserSessionService.instance = null;
  }

  // ============ SESSION LIFECYCLE ============

  public hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  public listSessions(): string[] {
    return [...this.sessions.keys()];
  }

  public getState(sessionId: string): BrowserNavigationState | null {
    const entry = this.sessions.get(sessionId);
    return entry ? { ...entry.state } : null;
  }

  public createSession(opts: BrowserSessionInitOptions): BrowserNavigationState {
    const existing = this.sessions.get(opts.sessionId);
    if (existing) {
      const requestedPartition = resolveBrowserPartitionName(opts.partition);
      if (
        existing.state.url !== opts.url ||
        existing.partitionName !== requestedPartition
      ) {
        throw new Error(
          `Browser session ${opts.sessionId} already exists with different configuration`,
        );
      }
      logger.main.warn(`[BrowserSessionService] Session already exists: ${opts.sessionId}`);
      return { ...existing.state };
    }
    if (!isAllowedBrowserUrl(opts.url)) {
      throw new Error(`Disallowed browser URL: ${opts.url}`);
    }

    const partitionName = resolveBrowserPartitionName(opts.partition);
    const ses = electronSession.fromPartition(partitionName);

    const view = new WebContentsView({
      webPreferences: {
        // No preload script: this view runs untrusted web content. Renderer
        // requests for IPC must go through the host BrowserWindow's preload.
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        session: ses,
      },
    });

    const entry: SessionEntry = {
      sessionId: opts.sessionId,
      partitionName,
      view,
      hostWindow: null,
      bounds: null,
      state: {
        sessionId: opts.sessionId,
        url: opts.url,
        title: '',
        isLoading: true,
        canGoBack: false,
        canGoForward: false,
      },
    };
    this.sessions.set(opts.sessionId, entry);

    this.wireWebContentsEvents(entry);

    // Kick off the initial load. We intentionally do not await -- the renderer
    // will see navigation events via the state-changed signal.
    void view.webContents.loadURL(opts.url).catch((err) => {
      // loadURL rejects on network errors / aborts; the will-fail-load handler
      // also fires, but logging here gives us a single error to grep.
      logger.main.warn(
        `[BrowserSessionService] loadURL failed for ${opts.sessionId}: ${(err as Error)?.message}`,
      );
    });

    logger.main.info(
      `[BrowserSessionService] Created session ${opts.sessionId} url=${opts.url} partition=${partitionName}`,
    );
    return { ...entry.state };
  }

  public destroySession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (entry.hostWindow && !entry.hostWindow.isDestroyed()) {
      try {
        entry.hostWindow.contentView.removeChildView(entry.view);
      } catch (err) {
        // removeChildView throws if the view is not a child; ignore -- we are
        // tearing down regardless.
        logger.main.debug(
          `[BrowserSessionService] removeChildView during destroy threw for ${sessionId}: ${(err as Error)?.message}`,
        );
      }
      this.removeWindowCloseListener(entry.hostWindow.id, sessionId);
    }

    try {
      // close() on the view's webContents tears down the renderer process.
      entry.view.webContents.close();
    } catch (err) {
      logger.main.debug(
        `[BrowserSessionService] webContents.close threw for ${sessionId}: ${(err as Error)?.message}`,
      );
    }

    this.sessions.delete(sessionId);
    logger.main.info(`[BrowserSessionService] Destroyed session ${sessionId}`);
  }

  // ============ ATTACH / DETACH ============

  public attachToWindow(
    sessionId: string,
    hostWindow: BrowserWindow,
    bounds: BrowserSessionBounds,
  ): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`No browser session: ${sessionId}`);
    }
    if (hostWindow.isDestroyed()) {
      throw new Error('Host window is destroyed');
    }

    // If we're already attached to a different window, detach first so we
    // never end up parented in two trees simultaneously.
    if (entry.hostWindow && entry.hostWindow !== hostWindow && !entry.hostWindow.isDestroyed()) {
      try {
        entry.hostWindow.contentView.removeChildView(entry.view);
      } catch {
        // ignore -- detach is best-effort
      }
      this.removeWindowCloseListener(entry.hostWindow.id, sessionId);
    }

    hostWindow.contentView.addChildView(entry.view);
    entry.hostWindow = hostWindow;
    this.installWindowCloseListener(hostWindow, sessionId);

    this.setBounds(sessionId, bounds);
  }

  public detachFromWindow(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.hostWindow) return;
    if (!entry.hostWindow.isDestroyed()) {
      try {
        entry.hostWindow.contentView.removeChildView(entry.view);
      } catch (err) {
        logger.main.debug(
          `[BrowserSessionService] detach removeChildView threw for ${sessionId}: ${(err as Error)?.message}`,
        );
      }
      this.removeWindowCloseListener(entry.hostWindow.id, sessionId);
    }
    entry.hostWindow = null;
    entry.bounds = null;
  }

  public setBounds(sessionId: string, bounds: BrowserSessionBounds): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.hostWindow || entry.hostWindow.isDestroyed()) return;

    const [containerWidth, containerHeight] = entry.hostWindow.getContentSize();
    const clamped = clampBounds(bounds, { width: containerWidth, height: containerHeight });
    entry.bounds = clamped;
    entry.view.setBounds(clamped);
  }

  // ============ NAVIGATION ============

  public navigate(sessionId: string, url: string): void {
    const entry = this.requireEntry(sessionId);
    if (!isAllowedBrowserUrl(url)) {
      throw new Error(`Disallowed browser URL: ${url}`);
    }
    entry.state.lastError = undefined;
    void entry.view.webContents.loadURL(url).catch((err) => {
      logger.main.warn(
        `[BrowserSessionService] navigate loadURL failed for ${sessionId}: ${(err as Error)?.message}`,
      );
    });
  }

  public reload(sessionId: string): void {
    const entry = this.requireEntry(sessionId);
    entry.view.webContents.reload();
  }

  public goBack(sessionId: string): void {
    const entry = this.requireEntry(sessionId);
    // webContents.navigationHistory.goBack was added in Electron 25+, but
    // canGoBack/goBack on webContents itself is the long-standing API.
    if (entry.view.webContents.navigationHistory.canGoBack()) {
      entry.view.webContents.navigationHistory.goBack();
    }
  }

  public goForward(sessionId: string): void {
    const entry = this.requireEntry(sessionId);
    if (entry.view.webContents.navigationHistory.canGoForward()) {
      entry.view.webContents.navigationHistory.goForward();
    }
  }

  // ============ SCREENSHOT ============

  public async captureScreenshot(sessionId: string): Promise<Buffer> {
    const entry = this.requireEntry(sessionId);
    // capturePage() captures the WebContentsView's current viewport.
    const nativeImage = await entry.view.webContents.capturePage();
    return nativeImage.toPNG();
  }

  // ============ INTERNAL ============

  private requireEntry(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`No browser session: ${sessionId}`);
    }
    return entry;
  }

  private wireWebContentsEvents(entry: SessionEntry): void {
    const wc = entry.view.webContents;

    const emitStateChanged = (): void => {
      if (!this.sessions.has(entry.sessionId)) return;
      this.emit('state-changed', { ...entry.state });
    };

    wc.on('did-start-loading', () => {
      entry.state.isLoading = true;
      emitStateChanged();
    });
    wc.on('did-stop-loading', () => {
      entry.state.isLoading = false;
      entry.state.canGoBack = wc.navigationHistory.canGoBack();
      entry.state.canGoForward = wc.navigationHistory.canGoForward();
      emitStateChanged();
    });
    wc.on('did-navigate', (_event, url) => {
      entry.state.url = url;
      entry.state.canGoBack = wc.navigationHistory.canGoBack();
      entry.state.canGoForward = wc.navigationHistory.canGoForward();
      emitStateChanged();
    });
    wc.on('did-navigate-in-page', (_event, url) => {
      entry.state.url = url;
      entry.state.canGoBack = wc.navigationHistory.canGoBack();
      entry.state.canGoForward = wc.navigationHistory.canGoForward();
      emitStateChanged();
    });
    wc.on('page-title-updated', (_event, title) => {
      entry.state.title = title;
      emitStateChanged();
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // Subframe failures (ads, third-party iframes) shouldn't disturb the
      // editor's surfaced state. Only flag failures of the main document.
      if (!isMainFrame) return;
      // -3 is ERR_ABORTED, which happens for any normal navigation away from a
      // pending load; surfacing it as a "failure" would be misleading.
      if (errorCode === -3) return;
      entry.state.lastError = {
        code: errorCode,
        description: errorDescription || 'Navigation failed',
      };
      entry.state.url = validatedURL || entry.state.url;
      entry.state.isLoading = false;
      emitStateChanged();
    });

    // Open `target=_blank` and any window.open() calls externally rather than
    // in a popup we don't own.
    wc.setWindowOpenHandler(({ url }) => {
      this.emit('external-navigation-requested', { sessionId: entry.sessionId, url });
      return { action: 'deny' };
    });
  }

  private installWindowCloseListener(hostWindow: BrowserWindow, sessionId: string): void {
    const windowId = hostWindow.id;
    let sessionsForWindow = this.windowCloseListeners.get(windowId);
    if (!sessionsForWindow) {
      sessionsForWindow = new Set();
      this.windowCloseListeners.set(windowId, sessionsForWindow);
      hostWindow.once('closed', () => {
        const sessions = this.windowCloseListeners.get(windowId);
        if (!sessions) return;
        for (const id of sessions) {
          // The window is gone; treat as detach + destroy. We can't call
          // contentView.removeChildView because the window is destroyed.
          const entry = this.sessions.get(id);
          if (entry) {
            entry.hostWindow = null;
            entry.bounds = null;
            this.destroySession(id);
          }
        }
        this.windowCloseListeners.delete(windowId);
      });
    }
    sessionsForWindow.add(sessionId);
  }

  private removeWindowCloseListener(windowId: number, sessionId: string): void {
    const sessions = this.windowCloseListeners.get(windowId);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (sessions.size === 0) {
      this.windowCloseListeners.delete(windowId);
    }
  }

  public cleanup(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.destroySession(sessionId);
    }
    this.windowCloseListeners.clear();
  }
}
