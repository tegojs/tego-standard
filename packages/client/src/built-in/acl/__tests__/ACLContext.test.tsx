import React from 'react';
import { renderHook } from '@tachybase/test/client';

import { ACLActionParamsContext, useACLFieldWhitelist } from '../ACLContext';

describe('ACLContext', () => {
  it('reads whitelist from direct action params', () => {
    const wrapper = ({ children }) => (
      <ACLActionParamsContext.Provider value={{ fields: ['title'], appends: ['comments'] }}>
        {children}
      </ACLActionParamsContext.Provider>
    );

    const { result } = renderHook(() => useACLFieldWhitelist(), { wrapper });

    expect(result.current.whitelist).toEqual(['title', 'comments']);
  });

  it('reads whitelist from nested collection action params', () => {
    const wrapper = ({ children }) => (
      <ACLActionParamsContext.Provider value={{ params: { fields: ['title'], appends: ['comments'] } }}>
        {children}
      </ACLActionParamsContext.Provider>
    );

    const { result } = renderHook(() => useACLFieldWhitelist(), { wrapper });

    expect(result.current.whitelist).toEqual(['title', 'comments']);
  });
});
