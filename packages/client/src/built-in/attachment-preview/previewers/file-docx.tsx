import React, { useEffect, useRef } from 'react';

import { renderAsync } from 'docx-preview';

import { useAPIClient } from '../../../api-client';
import { useStyles } from './file-docx.style';

const ViewComponent = (props) => {
  const { file, prefixCls } = props;

  return (
    file.imageUrl && (
      <img
        src={`${file.imageUrl}${file.thumbnailRule || ''}`}
        style={{ width: '100%', height: '100%' }}
        alt={file.title}
        className={`${prefixCls}-list-item-image`}
      />
    )
  );
};

const CheckedComponent = (props) => {
  const { file } = props;
  const api = useAPIClient();
  const ref = useRef<HTMLDivElement>(null);
  const { styles } = useStyles();
  let fileUrl = file.url ?? '';
  if (fileUrl.startsWith('/storage') && window.location.origin) {
    fileUrl = window.location.origin + fileUrl;
  }
  useEffect(() => {
    api.request({ url: fileUrl, responseType: 'arraybuffer' }).then((res) => {
      renderAsync(res.data, ref.current!);
    });
  }, [file.url]);
  return <div className={styles.container} ref={ref} />;
};

export const fileDocx = {
  key: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  viewComponet: (props) => <ViewComponent {...props} />,
  checkedComponent: (props) => <CheckedComponent {...props} />,
};
