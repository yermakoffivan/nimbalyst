import { useEffect, useState } from 'react';
import type { BrowserNavigationState } from '../browserClient';

interface BrowserToolbarProps {
  state: BrowserNavigationState | null;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onToggleSourceMode?: () => void;
  /** Optional fixed display URL when the URL bar should not be editable (.html previews). */
  pinnedUrlLabel?: string;
}

export function BrowserToolbar({
  state,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onToggleSourceMode,
  pinnedUrlLabel,
}: BrowserToolbarProps): JSX.Element {
  // Local input keeps the URL bar editable without fighting the broadcast
  // state updates. We seed it from state and sync on remote navigation.
  const [draft, setDraft] = useState<string>(state?.url ?? '');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (focused) return;
    setDraft(state?.url ?? '');
  }, [state?.url, focused]);

  const submit = (): void => {
    const value = draft.trim();
    if (!value) return;
    let url = value;
    // Convenience: bare hostnames or paths -> https:// so the user doesn't
    // have to type the scheme for every quick lookup.
    if (!/^[a-z]+:/i.test(url)) {
      url = `https://${url}`;
    }
    onNavigate(url);
  };

  return (
    <div
      className="nim-browser-toolbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        borderBottom: '1px solid var(--nim-border, rgba(0,0,0,0.1))',
        background: 'var(--nim-panel-bg, transparent)',
      }}
    >
      <button
        type="button"
        onClick={onBack}
        disabled={!state?.canGoBack}
        className="nim-browser-toolbar-btn"
        aria-label="Back"
        title="Back"
        style={{ padding: '4px 8px' }}
      >
        &larr;
      </button>
      <button
        type="button"
        onClick={onForward}
        disabled={!state?.canGoForward}
        className="nim-browser-toolbar-btn"
        aria-label="Forward"
        title="Forward"
        style={{ padding: '4px 8px' }}
      >
        &rarr;
      </button>
      <button
        type="button"
        onClick={onReload}
        className="nim-browser-toolbar-btn"
        aria-label="Reload"
        title="Reload"
        style={{ padding: '4px 8px' }}
      >
        &#x21bb;
      </button>

      {pinnedUrlLabel !== undefined ? (
        <span
          className="nim-browser-url-label"
          title={pinnedUrlLabel}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '4px 8px',
            border: '1px solid var(--nim-border, rgba(0,0,0,0.1))',
            borderRadius: 4,
            color: 'var(--nim-text-secondary, #666)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'inherit',
          }}
        >
          {pinnedUrlLabel}
        </span>
      ) : (
        <input
          className="nim-browser-url-input"
          type="text"
          value={draft}
          onChange={(e): void => setDraft(e.target.value)}
          onFocus={(): void => setFocused(true)}
          onBlur={(): void => setFocused(false)}
          onKeyDown={(e): void => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          spellCheck={false}
          aria-label="URL"
          style={{
            flex: 1,
            minWidth: 0,
            padding: '4px 8px',
            border: '1px solid var(--nim-border, rgba(0,0,0,0.1))',
            borderRadius: 4,
            background: 'var(--nim-input-bg, white)',
            color: 'var(--nim-text, inherit)',
            outline: 'none',
          }}
          placeholder="Enter URL"
        />
      )}

      {state?.isLoading ? (
        <span
          className="nim-browser-loading"
          aria-hidden="true"
          style={{ fontSize: 11, color: 'var(--nim-text-secondary, #666)' }}
        >
          Loading&hellip;
        </span>
      ) : null}

      {onToggleSourceMode ? (
        <button
          type="button"
          onClick={onToggleSourceMode}
          className="nim-browser-toolbar-btn"
          title="Toggle source view"
          style={{ padding: '4px 8px' }}
        >
          Source
        </button>
      ) : null}
    </div>
  );
}
