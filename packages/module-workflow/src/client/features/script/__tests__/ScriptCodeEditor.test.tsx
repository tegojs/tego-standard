import React from 'react';
import { act, render, screen } from '@tachybase/test/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScriptCodeEditor } from '../ScriptCodeEditor';

vi.mock('@tachybase/client', () => ({
  css: () => '',
}));

vi.mock('@tachybase/schema', () => ({
  connect: (component) => component,
  useForm: () => ({ values: { codeSource: 'local' } }),
}));

vi.mock('@tego/client', () => ({
  CodeEditor: () => <div data-testid="monaco-editor" />,
}));

vi.mock('antd', () => ({
  Alert: () => <div data-testid="editor-alert" />,
  Input: {
    TextArea: () => <textarea data-testid="fallback-editor" />,
  },
}));

vi.mock('../../../locale', () => ({
  tval: (value) => value,
}));

describe('ScriptCodeEditor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps hook order stable when Monaco falls back after rendering', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    render(<ScriptCodeEditor value="const value = 1;" onChange={vi.fn()} />);
    expect(screen.getByTestId('monaco-editor')).toBeInTheDocument();

    expect(() => {
      act(() => {
        window.dispatchEvent(
          new ErrorEvent('error', {
            message: 'Monaco editor failed to load',
            filename: '/vs/loader.js',
          }),
        );
      });
    }).not.toThrow();

    expect(screen.getByTestId('fallback-editor')).toBeInTheDocument();
  });
});
