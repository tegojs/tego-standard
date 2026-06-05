// Vitest shim for @tego/client — re-exports from individual packages
// instead of the barrel compiled bundle which pulls in heavy side effects.
//
// This avoids loading the full compiled @tego/client in test environment
// which causes hangs due to @tachybase/components and other heavy deps.
export { APIClient, getSubAppName } from '@tachybase/sdk';
export type { APIClientOptions, IResource } from '@tachybase/sdk';
export { getRequireJs } from '@tachybase/requirejs';
export type { RequireJS } from '@tachybase/requirejs';

export {
  CollectionsGraph,
  Registry,
  convertUTCToLocal,
  error,
  flatten,
  forEach,
  fuzzysearch,
  getDefaultFormat,
  getScrollParent,
  getValuesByPath,
  isArray,
  isPlainObject,
  isPortalInBody,
  isString,
  isURL,
  merge,
  moment2str,
  nextTick,
  parse,
  str2moment,
  toFixedByStep,
  toGmt,
  toLocal,
  uid,
  unflatten,
} from '@tachybase/utils/client';

export {
  type ArrayBaseMixins,
  ArrayBase,
  ArrayCollapse,
  ArrayItems,
  ArrayTable,
  Checkbox,
  CodeEditor,
  CodeMirror,
  DatePicker,
  Editable,
  Form,
  FormButtonGroup,
  FormCollapse,
  FormDrawer,
  FormItem,
  FormLayout,
  FormTab,
  Input,
  Lightbox,
  NumberPicker,
  Radio,
  Reset,
  Space,
  Submit,
  Switch,
  TreeSelect,
  dayjsable,
  formatDayjsValue,
  useFormLayout,
  usePrefixCls,
  type IArrayBaseAdditionProps,
} from '@tachybase/components';

export type { ReactFC } from '@tachybase/schema';
export { evaluate, evaluators, getOptions } from '@tachybase/evaluators/client';
export type { Evaluator } from '@tachybase/evaluators/client';
