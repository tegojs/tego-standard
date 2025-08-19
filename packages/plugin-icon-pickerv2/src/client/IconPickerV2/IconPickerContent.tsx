import { IconFilterInput, IconFilterList } from '@tachybase/client';

export const IconPickerContent = (props) => {
  const { value, onChange, setFilterKey, filterKey, setVisible } = props;
  return (
    <>
      <IconFilterInput changeFilterKey={setFilterKey} />
      <IconFilterList currentKey={value} filterKey={filterKey} onChange={onChange} changePop={setVisible} />
    </>
  );
};
