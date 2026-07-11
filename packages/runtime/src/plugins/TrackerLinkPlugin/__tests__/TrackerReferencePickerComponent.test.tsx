import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';

import type { TrackerRecord } from '../../../core/TrackerRecord';
import { trackerItemsMapAtom } from '../../TrackerPlugin/trackerDataAtoms';
import { TrackerReferencePicker } from '../TrackerReferencePickerComponent';

function record(id: string, issueKey: string, title: string): TrackerRecord {
  return {
    id,
    issueKey,
    primaryType: 'task',
    typeTags: ['task'],
    source: 'native',
    archived: false,
    syncStatus: 'synced',
    system: {
      workspace: '/workspace',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    },
    fields: { title, status: 'to-do' },
  };
}

function ControlledPicker({ initial = [] }: { initial?: string[] }): JSX.Element {
  const [value, setValue] = React.useState(initial);
  return <TrackerReferencePicker value={value} onChange={setValue} />;
}

describe('TrackerReferencePicker', () => {
  it('searches canonical tracker data, selects a key, and removes it', () => {
    const store = createStore();
    store.set(trackerItemsMapAtom, new Map([
      ['task_1', record('task_1', 'NIM-10', 'Add tracker picker')],
      ['task_2', record('task_2', 'NIM-11', 'Unrelated item')],
    ]));

    const { container } = render(
      <Provider store={store}>
        <ControlledPicker />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Link tracker item' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tracker items' }), {
      target: { value: 'picker' },
    });
    fireEvent.click(screen.getByRole('option', { name: /NIM-10.*Add tracker picker/ }));

    const selected = container.querySelector('.tracker-reference-picker-values');
    expect(selected).not.toBeNull();
    expect(within(selected as HTMLElement).getByText('NIM-10')).toBeTruthy();
    expect(within(selected as HTMLElement).queryByText('Add tracker picker')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove tracker reference NIM-10' }));
    expect(container.querySelector('.tracker-reference-picker-values')).toBeNull();
  });

  it('preserves unresolved keys and suppresses mutation controls when disabled', () => {
    const onChange = vi.fn();
    const store = createStore();

    render(
      <Provider store={store}>
        <TrackerReferencePicker value={['NIM-404']} onChange={onChange} disabled />
      </Provider>,
    );

    expect(screen.getByText('NIM-404')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove tracker reference NIM-404' })).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Link tracker item' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('replaces the value and closes in single-selection mode', () => {
    const store = createStore();
    store.set(trackerItemsMapAtom, new Map([
      ['task_1', record('task_1', 'NIM-10', 'First item')],
    ]));

    function SinglePicker(): JSX.Element {
      const [value, setValue] = React.useState<string[]>(['NIM-OLD']);
      return <TrackerReferencePicker value={value} onChange={setValue} multiple={false} />;
    }

    render(
      <Provider store={store}>
        <SinglePicker />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Link tracker item' }));
    fireEvent.click(screen.getByRole('option', { name: /NIM-10.*First item/ }));

    expect(screen.getByText('NIM-10')).toBeTruthy();
    expect(screen.queryByText('NIM-OLD')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Search tracker items' })).toBeNull();
  });
});
