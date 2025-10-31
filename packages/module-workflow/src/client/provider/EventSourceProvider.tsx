import { createContext, useContext } from 'react';
import { useRequest } from '@tachybase/client';

export const EventSourceContext = createContext({ eventSourceList: [] });
export const EventSourceProvider = (props) => {
  const { data } = useRequest({
    resource: 'webhooks',
    action: 'list',
    params: {
      pageSize: 99999,
    },
  });
  return (
    <EventSourceContext.Provider value={{ eventSourceList: data?.['data'] }}>
      {props.children}
    </EventSourceContext.Provider>
  );
};

export const useEventSourceContext = () => {
  return useContext(EventSourceContext);
};
