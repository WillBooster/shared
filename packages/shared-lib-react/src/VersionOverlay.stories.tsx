import type { Meta, StoryFn } from '@storybook/react';

import { VersionOverlay } from './VersionOverlay.jsx';

const meta: Meta<typeof VersionOverlay> = {
  title: 'VersionOverlay',
  component: VersionOverlay,
};

const Template: StoryFn<typeof VersionOverlay> = (args) => <VersionOverlay {...args} />;

export const Default: StoryFn<typeof VersionOverlay> = Template.bind({});

export default meta;
