import type { ComponentType } from 'react';

import { Select } from 'antd';

const InternalPanel = Select._InternalPanelDoNotUseOrYouWillBeFired as ComponentType<any>;

export default InternalPanel;
