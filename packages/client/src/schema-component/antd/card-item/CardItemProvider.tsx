import { createContext, useContext } from 'react';

const CardItemContext = createContext({ cardItemUid: '', setSchemaUid: null });

export const CardItemProvider = (props) => {
  return <CardItemContext.Provider value={props.value}>{props.children}</CardItemContext.Provider>;
};

export const useCardItem = () => {
  return useContext(CardItemContext);
};
