// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// Capture what the strip hands to TerminalPanel without pulling in xterm/ghostty.
// `isActive`/`panelVisible` true === "the genuine CLI is being launched".
const terminalProps: Array<{ isActive: boolean; panelVisible: boolean }> = [];
vi.mock('../../Terminal/TerminalPanel', () => ({
  TerminalPanel: (props: { isActive: boolean; panelVisible: boolean }) => {
    terminalProps.push({ isActive: props.isActive, panelVisible: props.panelVisible });
    return <div data-testid="terminal-panel" data-active={String(props.isActive)} />;
  },
}));

import { ClaudeCliTerminalStrip } from '../ClaudeCliTerminalStrip';

// Controllable IntersectionObserver: tests trigger an "on screen" entry on demand.
let intersectCallbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
class MockIO {
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    intersectCallbacks.push(cb);
  }
  observe() {}
  disconnect() {}
}

function triggerOnScreen() {
  act(() => {
    for (const cb of intersectCallbacks) cb([{ isIntersecting: true }]);
  });
}

let windowFocused = true;

beforeEach(() => {
  terminalProps.length = 0;
  intersectCallbacks = [];
  (globalThis as unknown as { IntersectionObserver: typeof MockIO }).IntersectionObserver = MockIO;
  windowFocused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => windowFocused);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const launched = () =>
  terminalProps.length > 0 && terminalProps[terminalProps.length - 1].isActive;

describe('ClaudeCliTerminalStrip - launches the CLI only when the window is focused (NIM-813)', () => {
  it('does NOT launch when on-screen but the window is not focused', () => {
    windowFocused = false;
    render(<ClaudeCliTerminalStrip sessionId="s1" workspacePath="/ws" />);
    triggerOnScreen();
    expect(launched()).toBe(false);
  });

  it('launches when on-screen and the window is focused', () => {
    windowFocused = true;
    render(<ClaudeCliTerminalStrip sessionId="s1" workspacePath="/ws" />);
    triggerOnScreen();
    expect(launched()).toBe(true);
  });

  it('launches a background window once it gains focus', () => {
    windowFocused = false;
    render(<ClaudeCliTerminalStrip sessionId="s1" workspacePath="/ws" />);
    triggerOnScreen();
    expect(launched()).toBe(false);

    // User brings the window forward.
    windowFocused = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(launched()).toBe(true);
  });
});
