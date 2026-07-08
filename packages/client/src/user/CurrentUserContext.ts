import { createContext, useContext } from 'react';

export const CurrentUserContext = createContext<any>(null);
CurrentUserContext.displayName = 'CurrentUserContext';

export const useCurrentUserContext = () => {
  return useContext(CurrentUserContext);
};
