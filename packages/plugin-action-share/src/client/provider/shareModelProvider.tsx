import { createContext, useContext, useState } from 'react';

export interface ShareValue {
  linkStatus: boolean;
  password: any;
  permanent: boolean;
  shareTime: Date;
  permission: string;
  generateLink: string;
  createdBy: any;
  updatedBy: any;
  tabs: tabsValue[];
}

export interface tabsValue {
  xUid: string;
  schemaName: string;
  title?: string;
}

export const ShareModalContext = createContext<{
  shareValue: ShareValue;
  setShareValue: any;
}>({
  shareValue: {
    linkStatus: true,
    password: null,
    permanent: false,
    shareTime: null,
    permission: 'view',
    generateLink: null,
    createdBy: null,
    updatedBy: null,
    tabs: [],
  },
  setShareValue: (props) => {},
});

export const useShareModal = () => {
  return useContext(ShareModalContext);
};
