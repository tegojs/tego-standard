import React, { FC, useContext, useEffect, useMemo, useRef } from 'react';
import { useFormBlockContext, useSchemaOptionsContext } from '@tachybase/client';
import { Field, useField, useFieldSchema, useForm } from '@tachybase/schema';
import {
  SchemaComponentsContext,
  SchemaExpressionScopeContext,
  SchemaMarkupContext,
} from '@tachybase/schema/lib/react';

import { useEditableSelectedForm } from './EditableSelectedFormContent';

export const EditableFormToolbar = () => {
  const fieldSchema = useFieldSchema();
  const form = useForm();
  const field = useField<Field>();
  const schemaMarkup = useContext(SchemaMarkupContext);
  const expressionScope = useContext(SchemaExpressionScopeContext);
  const schemaComponents = useContext(SchemaComponentsContext);
  const formBlockValue = useFormBlockContext();
  const schemaOptions = useSchemaOptionsContext();
  const { setEditableForm } = useEditableSelectedForm();

  useEffect(() => {
    setEditableForm({
      field,
      fieldSchema,
      schemaMarkup,
      expressionScope,
      schemaComponents,
      schemaOptions,
      form,
      formBlockValue,
    });
  }, []);

  return null;
};
