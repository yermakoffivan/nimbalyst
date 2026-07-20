// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SelectionChips } from '../SelectionChips';
import { clearTextSelection, setTextSelection } from '../TextSelectionIndicator';
import {
  clearEditorContext,
  getActiveEditorContextItems,
  setEditorContextItems,
} from '../../../stores/editorContextStore';
const FILE = '/test/diagram.excalidraw';
const OTHER_FILE = '/test/other.excalidraw';
const COLLAB_FILE = 'collab://org:o:doc:shared.md';

afterEach(() => {
  cleanup();
  clearTextSelection();
  clearEditorContext(FILE);
  clearEditorContext(OTHER_FILE);
  clearEditorContext(COLLAB_FILE);
  delete (window as any).__mockupFilePath;
  delete (window as any).__mockupSelectedElement;
  delete (window as any).__mockupDrawing;
  delete (window as any).__mockupAnnotationTimestamp;
});

describe('SelectionChips', () => {
  it('reacts to text-selection events and removes the selection immediately', () => {
    render(<SelectionChips currentFilePath={FILE} />);
    expect(screen.queryByText('Selection')).toBeNull();

    act(() => setTextSelection('selected text', FILE));
    expect(screen.getByText('Selection')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Remove Selection from context'));
    expect(screen.queryByText('Selection')).toBeNull();
  });

  it('shows any published selection when no currentFilePath prop is passed (collab/agent panels)', () => {
    // Collab/Agent chat panels pass no currentFilePath; the focused editor is the
    // only publisher, so the stored selection is trusted and shown.
    render(<SelectionChips />);
    expect(screen.queryByText('Selection')).toBeNull();

    act(() => setTextSelection('selected text', COLLAB_FILE));
    expect(screen.getByText('Selection')).toBeTruthy();
  });

  it('does not show a selection belonging to a different file when currentFilePath is set', () => {
    render(<SelectionChips currentFilePath={FILE} />);

    act(() => setTextSelection('selection from another doc', OTHER_FILE));
    expect(screen.queryByText('Selection')).toBeNull();
  });

  it('dismisses and restores an extension item without sending it while hidden', () => {
    act(() => {
      setEditorContextItems(FILE, [{ id: 'a', label: 'Rectangle A', description: 'A rectangle' }]);
    });
    render(<SelectionChips currentFilePath={FILE} />);

    fireEvent.click(screen.getByLabelText('Remove Rectangle A from context'));
    expect(screen.queryByText('Rectangle A')).toBeNull();
    expect(screen.getByText('1 hidden — restore')).toBeTruthy();
    expect(getActiveEditorContextItems(FILE)).toBeUndefined();

    fireEvent.click(screen.getByText('1 hidden — restore'));
    expect(screen.getByText('Rectangle A')).toBeTruthy();
    expect(getActiveEditorContextItems(FILE)?.[0].id).toBe('a');
  });

  it('scopes extension items to the active file', () => {
    act(() => {
      setEditorContextItems(FILE, [{ id: 'a', label: 'Current file', description: 'current' }]);
      setEditorContextItems(OTHER_FILE, [{ id: 'b', label: 'Other file', description: 'other' }]);
    });

    render(<SelectionChips currentFilePath={FILE} />);
    expect(screen.getByText('Current file')).toBeTruthy();
    expect(screen.queryByText('Other file')).toBeNull();
  });

  it('shows extension items with no currentFilePath via the most-recent entry (collab spreadsheet)', () => {
    // Regression: collab/agent panels pass no currentFilePath. A collaborative
    // spreadsheet publishes its selected-cell context keyed by the collab doc
    // path; the chip must still surface it via the store's most-recent fallback.
    act(() => {
      setEditorContextItems(COLLAB_FILE, [{ id: 'c1', label: 'Cells A1:B2', description: '4 cells' }]);
    });

    render(<SelectionChips />);
    expect(screen.getByText('Cells A1:B2')).toBeTruthy();
  });

  it('collapses large groups and can expand them', () => {
    act(() => {
      setEditorContextItems(
        FILE,
        Array.from({ length: 8 }, (_, index) => ({
          id: String(index),
          label: `Shape ${index + 1}`,
          description: `Shape ${index + 1}`,
          groupLabel: 'shapes',
        }))
      );
    });

    render(<SelectionChips currentFilePath={FILE} />);
    expect(screen.getByText('Shape 5')).toBeTruthy();
    expect(screen.queryByText('Shape 6')).toBeNull();

    fireEvent.click(screen.getByLabelText('Show 3 more shapes'));
    expect(screen.getByText('Shape 8')).toBeTruthy();
    expect(screen.getByLabelText('Show fewer shapes')).toBeTruthy();
  });
});
