import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useAPIClient, useRequest } from '@tachybase/client';

import PageSpy from '@huolala-tech/page-spy-browser';
import DataHarborPlugin from '@huolala-tech/page-spy-plugin-data-harbor';
import RRWebPlugin from '@huolala-tech/page-spy-plugin-rrweb';
import { createPortal } from 'react-dom';

import { useStyles } from './styles';

export interface PageSpyProps {
  visible: boolean;
  setVisible: React.Dispatch<React.SetStateAction<boolean>>;
  refresh?: any;
}

interface PageSpyConfigProps {
  api: string;
  project: string;
  title: string;
}

export const PageSpyContext = createContext<Partial<PageSpyProps>>({});
export const usePageSpy = () => {
  return useContext(PageSpyContext);
};

function cleanupPageSpy(container?: HTMLDivElement | null) {
  const spy = (window as any).$pageSpy;
  if (spy) {
    if (spy.root && container?.contains(spy.root)) {
      container.removeChild(spy.root);
    }
    spy.abort?.();
  }
  (window as any).$pageSpy = null;
}

function createPageSpy(container: HTMLDivElement, config: PageSpyConfigProps) {
  (window as any).$harbor = new DataHarborPlugin();
  (window as any).$rrweb = new RRWebPlugin();
  [(window as any).$harbor, (window as any).$rrweb].forEach((p) => {
    PageSpy.registerPlugin(p);
  });

  const pageSpy = new PageSpy({
    api: config.api || 'localhost:6752',
    clientOrigin: `http://${config.api}` || 'http://localhost:6752',
    project: config.project || 'Tachybase-debug',
    title: config.title || 'Tachybase',
  });

  const appendRoot = () => {
    if (pageSpy.root instanceof Node) container.appendChild(pageSpy.root);
    else setTimeout(appendRoot, 50);
  };
  appendRoot();
  (window as any).$pageSpy = pageSpy;
}

export const PageSpyProvider = ({ children }) => {
  const api = useAPIClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<boolean>(false);
  const { styles } = useStyles();
  const { data, refresh } = useRequest<PageSpyConfigProps>(() =>
    api
      .resource('pagespy')
      .get()
      .then((res) => res.data?.data),
  );

  useEffect(() => {
    if (visible && containerRef.current && data) {
      cleanupPageSpy(containerRef.current);
      createPageSpy(containerRef.current, data);
    } else if (!visible) {
      cleanupPageSpy(containerRef.current);
    }

    return () => cleanupPageSpy(containerRef.current);
  }, [visible, data]);

  return (
    <PageSpyContext.Provider value={{ visible, setVisible, refresh }}>
      {children}
      {visible ? createPortal(<div ref={containerRef} className={styles.container} />, document.body) : null}
    </PageSpyContext.Provider>
  );
};
