import React from 'react';
import { render, screen } from '@testing-library/react';
import type { LoadedExtensionSettingsRoute, SettingsPanelProps } from '@nimbalyst/runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionSettingsRoutePanel } from '../ExtensionSettingsRoutes';

const { storage, createExtensionStorage } = vi.hoisted(() => {
  const mockedStorage = { marker: 'storage' };
  return {
    storage: mockedStorage,
    createExtensionStorage: vi.fn(() => mockedStorage),
  };
});

vi.mock('@nimbalyst/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nimbalyst/runtime')>()),
  createExtensionStorage,
}));

vi.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark', themeId: 'dark', setTheme: vi.fn() }),
}));

let receivedProps: SettingsPanelProps | undefined;

function ProbeSettings(props: SettingsPanelProps) {
  receivedProps = props;
  return <div>Extension route mounted</div>;
}

function makeRoute(scope: 'application' | 'project'): LoadedExtensionSettingsRoute {
  return {
    id: `ext:com.example.settings:${scope}`,
    extensionId: 'com.example.settings',
    scope,
    label: 'Example',
    group: 'Extensions',
    icon: 'extension',
    order: 100,
    componentName: 'ProbeSettings',
    contribution: {
      id: scope,
      scope,
      label: 'Example',
      component: 'ProbeSettings',
    },
    component: ProbeSettings,
  };
}

describe('ExtensionSettingsRoutePanel', () => {
  beforeEach(() => {
    receivedProps = undefined;
    createExtensionStorage.mockClear();
  });

  it('passes workspace and project target to project-scoped routes', () => {
    render(
      <ExtensionSettingsRoutePanel
        route={makeRoute('project')}
        workspacePath="/workspace"
        projectTarget={{ kind: 'workspace', workspacePath: '/workspace' }}
      />,
    );

    expect(screen.getByText('Extension route mounted')).toBeTruthy();
    expect(receivedProps).toEqual(
      expect.objectContaining({
        storage,
        theme: 'dark',
        workspacePath: '/workspace',
        projectTarget: { kind: 'workspace', workspacePath: '/workspace' },
        callBackendTool: expect.any(Function),
      }),
    );
  });

  it('omits project context from application-scoped routes', () => {
    render(
      <ExtensionSettingsRoutePanel
        route={makeRoute('application')}
        workspacePath="/workspace"
        projectTarget={{ kind: 'workspace', workspacePath: '/workspace' }}
      />,
    );

    expect(receivedProps).not.toHaveProperty('workspacePath');
    expect(receivedProps).not.toHaveProperty('projectTarget');
  });
});
