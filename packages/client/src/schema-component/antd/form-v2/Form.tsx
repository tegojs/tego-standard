import React, { useEffect, useMemo } from 'react';
import {
  createForm,
  Field,
  FieldContext,
  FormContext,
  Form as FormilyForm,
  observer,
  onFormInputChange,
  RecursionField,
  uid,
  useField,
  useFieldSchema,
} from '@tachybase/schema';
import { FormLayout } from '@tego/client';

import { ConfigProvider, Spin } from 'antd';
import { createStyles } from 'antd-style';

import { withDynamicSchemaProps } from '../../../application/hoc/withDynamicSchemaProps';
import { useAttach } from '../../hooks/useAttach';
import { useComponent } from '../../hooks/useComponent';
import { useProps } from '../../hooks/useProps';
import { useActionContext } from '../action/hooks';

export interface FormProps {
  [key: string]: any;
}

const LazyFormLinkageRules = React.lazy(() =>
  import('./FormLinkageRules').then((module) => ({ default: module.FormLinkageRules })),
);

const useStyles = createStyles(({ css }) => {
  return {
    container: css`
      .ant-formily-item-feedback-layout-loose {
        margin-bottom: 12px;
      }
    `,
  };
});

const FormComponent: React.FC<FormProps> = (props) => {
  const { form, children, ...others } = props;
  const field = useField();
  const fieldSchema = useFieldSchema();
  // TODO: component 里 useField 会与当前 field 存在偏差
  const f = useAttach(form.createVoidField({ ...field.props, basePath: '' }));
  return (
    <FieldContext.Provider value={undefined}>
      <FormContext.Provider value={form}>
        <FormLayout layout={'vertical'} {...others}>
          <RecursionField basePath={f.address} schema={fieldSchema} onlyRenderProperties />
        </FormLayout>
      </FormContext.Provider>
    </FieldContext.Provider>
  );
};

const Def = (props: any) => props.children;

const FormDecorator: React.FC<FormProps> = (props) => {
  const { form, children, disabled, ...others } = props;
  const field = useField();
  const fieldSchema = useFieldSchema();
  // TODO: component 里 useField 会与当前 field 存在偏差
  const f = useAttach(form.createVoidField({ ...field.props, basePath: '' }));
  const Component = useComponent(fieldSchema['x-component'], Def);
  return (
    <FieldContext.Provider value={undefined}>
      <FormContext.Provider value={form}>
        <FormLayout layout={'vertical'} {...others}>
          <FieldContext.Provider value={f}>
            <Component {...field.componentProps}>
              <RecursionField basePath={f.address} schema={fieldSchema} onlyRenderProperties />
            </Component>
          </FieldContext.Provider>
        </FormLayout>
      </FormContext.Provider>
    </FieldContext.Provider>
  );
};

const getLinkageRules = (fieldSchema) => {
  let linkageRules = null;
  fieldSchema.mapProperties((schema) => {
    if (schema['x-linkage-rules']) {
      linkageRules = schema['x-linkage-rules'];
    }
  });
  return linkageRules;
};

interface WithFormProps {
  form: FormilyForm;
  disabled?: boolean;
}

const WithForm = (props: WithFormProps) => {
  const { form } = props;
  const fieldSchema = useFieldSchema();
  const { setFormValueChanged } = useActionContext();
  const rawLinkageRules = getLinkageRules(fieldSchema) || fieldSchema.parent?.['x-linkage-rules'];
  const linkageRules: any[] = useMemo(() => rawLinkageRules?.filter((rule) => !rule.disabled) || [], [rawLinkageRules]);

  useEffect(() => {
    const id = uid();

    form.addEffects(id, () => {
      onFormInputChange(() => {
        setFormValueChanged?.(true);
      });
    });

    if (props.disabled) {
      form.disabled = props.disabled;
    }

    return () => {
      form.removeEffects(id);
    };
  }, [form, props.disabled, setFormValueChanged]);

  const formElement =
    fieldSchema['x-decorator'] === 'FormV2' ? <FormDecorator {...props} /> : <FormComponent {...props} />;

  if (!linkageRules.length) {
    return formElement;
  }

  return (
    <React.Suspense fallback={formElement}>
      <LazyFormLinkageRules form={form} linkageRules={linkageRules}>
        {formElement}
      </LazyFormLinkageRules>
    </React.Suspense>
  );
};

const WithoutForm = (props) => {
  const fieldSchema = useFieldSchema();
  const { setFormValueChanged } = useActionContext();
  const form = useMemo(
    () =>
      createForm({
        disabled: props.disabled,
        initialValues: props.initialValues,
        values: props.initialValues,
        effects() {
          onFormInputChange((form) => {
            setFormValueChanged?.(true);
          });
        },
      }),
    [],
  );
  return fieldSchema['x-decorator'] === 'FormV2' ? (
    <FormDecorator form={form} {...props} />
  ) : (
    <FormComponent form={form} {...props} />
  );
};

export const Form: React.FC<FormProps> & {
  Designer?: any;
  FilterDesigner?: any;
  ReadPrettyDesigner?: any;
  Templates?: any;
} = withDynamicSchemaProps(
  observer((props) => {
    const field = useField<Field>();
    const { styles } = useStyles();

    // 新版 UISchema（1.0 之后）中已经废弃了 useProps，这里之所以继续保留是为了兼容旧版的 UISchema
    const { form, disabled, ...others } = useProps(props);

    const formDisabled = disabled || field.disabled;
    return (
      <ConfigProvider componentDisabled={formDisabled}>
        <form onSubmit={(e) => e.preventDefault()} className={styles.container}>
          <Spin spinning={field.loading || false}>
            {form ? (
              <WithForm form={form} {...others} disabled={formDisabled} />
            ) : (
              <WithoutForm {...others} disabled={formDisabled} />
            )}
          </Spin>
        </form>
      </ConfigProvider>
    );
  }),
  { displayName: 'Form' },
);
