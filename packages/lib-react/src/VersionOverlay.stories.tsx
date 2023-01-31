import { ComponentStory, ComponentMeta } from '@storybook/react';
import React from 'react';

import { VersionOverlay } from './VersionOverlay.jsx';

export default {
  title: 'VersionOverlay',
  component: VersionOverlay,
} as ComponentMeta<typeof VersionOverlay>;

const Template: ComponentStory<typeof VersionOverlay> = (args) => <VersionOverlay {...args} />;

export const Default = Template.bind({});
