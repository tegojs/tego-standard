import { Field, observer, useField } from '@tachybase/schema';

export const UserNicknameField = observer(
  () => {
    const field = useField<Field>();
    const fieldValue = field?.value;

    if (fieldValue?.nickname) {
      return <span>{fieldValue.nickname}</span>;
    } else if (fieldValue?.username) {
      return <span>{fieldValue.username}</span>;
    } else if (fieldValue?.id !== undefined) {
      return <span>{fieldValue.id}</span>;
    }
    return <span>-</span>;
  },
  { displayName: 'UserNicknameField' },
);
