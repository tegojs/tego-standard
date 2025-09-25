import { useEffect, useState } from 'react';
import { Icon, useRequest, useTranslation } from '@tachybase/client';

import { ExclamationCircleFilled } from '@ant-design/icons';
import { Input, message, Modal } from 'antd';
import dayjs from 'dayjs';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';

import { useSharePageModelStyle } from './style';

export const VerifyModal = (props) => {
  const { setIsVerify, data, modalVisible, setModalVisible } = props;
  const { t } = useTranslation();
  const { shareTime, createdBy, linkStatus } = data?.data || {};
  const { styles } = useSharePageModelStyle();
  const { id } = useParams();
  const [effective, setEffective] = useState(true);
  const time = shareTime ? dayjs(shareTime).format('YYYY-MM-DD') : t('Permanently valid');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const { run } = useRequest(
    {
      resource: 'sharePageConfig',
      action: 'verifyIn',
      method: 'post',
      params: {
        values: {
          password: password,
          id: id,
        },
      },
    },
    {
      manual: true,
      onSuccess(res) {
        if (res.data.valid) {
          setIsVerify(true);
          setModalVisible(false);
          sessionStorage.setItem('sharePassword', data.data.password);
          sessionStorage.setItem('sharePassword-id', data.data.id);
        } else {
          setError(true);
        }
      },
    },
  );
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (effective && shareTime && dayjs().isAfter(shareTime)) {
      setEffective(false);
      message.warning(
        t('The link has expired. If you need to retrieve it again, please contact the relevant personnel'),
      );
    } else if (!data?.data && effective) {
      setEffective(false);
      message.warning(
        t('The link does not exist. Please confirm if the link is correct or contact the relevant personnel'),
      );
    } else if (!linkStatus && effective) {
      setEffective(false);
      message.warning(
        t('This link is currently not open. If you have any questions, please contact the relevant personnel'),
      );
    }
  }, []);
  return (
    effective && (
      <Modal
        open={modalVisible}
        title={`${t('From')}(${createdBy?.nickname})${t('Sharing')}`}
        onCancel={() => {
          setModalVisible(false);
          const redirect = `?redirent=${pathname}${search}`;
          navigate(`/signin${redirect}`);
        }}
        className={styles.modal}
        onOk={() => {
          run();
        }}
      >
        <div>
          <div>
            {t('Please enter the sharing password')}
            <Input
              onChange={(value) => {
                setPassword(value.target.value);
                if (error) setError(false);
              }}
            />
            <div className="error" style={{ visibility: error ? 'visible' : 'hidden' }}>
              <ExclamationCircleFilled />
              {t('Password error, please re-enter')}
            </div>
          </div>
          <div className="shareTime">
            {t('Link timeliness')}:{time}
          </div>
        </div>
      </Modal>
    )
  );
};
