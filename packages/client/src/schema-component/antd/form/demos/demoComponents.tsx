import React, { createContext, useContext, useState } from 'react';
import { RecursionField, useField, useFieldSchema, useForm } from '@tachybase/schema';

export const FormItem = ({ children }) => {
  const field = useField();
  return (
    <div>
      {field?.title && <label>{field.title}</label>}
      {children}
    </div>
  );
};

const ActionContext = createContext<any>({});

export const ActionContextProvider = ({ value, children, ...props }) => {
  const parent = useContext(ActionContext);
  return <ActionContext.Provider value={{ ...parent, ...props, ...value }}>{children}</ActionContext.Provider>;
};

export const useActionContext = () => useContext(ActionContext);

export const useCloseAction = () => {
  const { setVisible } = useActionContext();
  const form = useForm();
  return {
    async run() {
      setVisible?.(false);
      await form.submit();
    },
  };
};

export const Action = (props) => {
  const field = useField();
  const fieldSchema = useFieldSchema();
  const [visible, setVisible] = useState(false);
  const action = props.useAction?.();
  const title = props.title ?? field.title;

  return (
    <ActionContextProvider visible={visible} setVisible={setVisible} fieldSchema={fieldSchema}>
      <button
        type="button"
        onClick={async () => {
          setVisible(true);
          await action?.run?.();
        }}
      >
        {title}
      </button>
      {props.children}
    </ActionContextProvider>
  );
};

Action.Drawer = (props) => {
  const { visible } = useActionContext();
  const field = useField();
  if (!visible) {
    return null;
  }
  return (
    <div role="dialog">
      <div>{field.title}</div>
      {props.children}
    </div>
  );
};

Action.Drawer.Footer = ({ children }) => <div>{children}</div>;
