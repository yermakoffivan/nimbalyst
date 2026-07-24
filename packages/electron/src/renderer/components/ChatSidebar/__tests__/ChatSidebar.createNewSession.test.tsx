// @vitest-environment jsdom
import React, { createRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSidebar, type ChatSidebarRef } from '../ChatSidebar';

vi.mock('../../../store', async () => {
  const { atom } = await import('jotai');
  return {
    sessionListChatAtom: atom([]),
    refreshSessionListAtom: atom(null, () => {}),
    initSessionList: vi.fn(),
  };
});

vi.mock('../../../store/atoms/appSettings', async () => {
  const { atom } = await import('jotai');
  return {
    defaultAgentModelAtom: atom('claude-code:sonnet'),
  };
});

vi.mock('../../UnifiedAI/SessionTranscript', () => ({
  SessionTranscript: () => null,
}));

vi.mock('../../AIChat/SessionDropdown', () => ({
  SessionDropdown: () => null,
}));

describe('ChatSidebar createNewSession ref action', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: vi.fn(() => 'new-chat-session'),
    });
    (window as any).electronAPI = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('creates a chat session while the panel is hidden', async () => {
    const ref = createRef<ChatSidebarRef>();
    render(
      <ChatSidebar
        ref={ref}
        workspacePath="/workspace"
        isActive={false}
      />,
    );

    await act(async () => {
      await ref.current?.createNewSession();
    });

    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'sessions:create',
      {
        session: {
          id: 'new-chat-session',
          provider: 'claude-code',
          model: 'claude-code:sonnet',
          title: 'Chat',
        },
        workspaceId: '/workspace',
      },
    );
  });
});
