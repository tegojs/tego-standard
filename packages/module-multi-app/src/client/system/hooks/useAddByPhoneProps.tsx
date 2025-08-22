import { useState } from 'react';
import { useAPIClient } from '@tachybase/client';
import { connect, useForm } from '@tachybase/schema';

import { Input, message } from 'antd';

import { usePluginUtils } from '../../locale';

export const AddByPhone = () => {
  const form = useForm();
  const api = useAPIClient();
  const { t } = usePluginUtils();
  const [loading, setLoading] = useState(false);

  const handleSearch = async (phoneNumber: string) => {
    if (!/^1[3-9]\d{9}$/.test(phoneNumber)) {
      message.warning(t('Not a valid cellphone number, please re-enter'));
      return;
    }

    setLoading(true);
    try {
      const { data } = await api.resource('users').list({
        filter: { phone: phoneNumber },
      });

      const userData = data?.data || [];
      if (!userData.length) {
        message.info(t('PhoneNumber not found'));
        return;
      }

      const partners = form.values?.partners || [];
      const newPartners = [...partners, ...userData.filter((u) => !partners.some((p) => p.id === u.id))];

      await form.setValuesIn('partners', newPartners);
      message.success(t('User already exist'));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Input.Search
      placeholder={t('Enter phone number please')}
      onSearch={handleSearch}
      loading={loading}
      enterButton={t('Add user')}
    />
  );
};
