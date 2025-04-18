import type { Meta, StoryFn } from '@storybook/react';

import { VersionOverlay } from './VersionOverlay.jsx';

const meta: Meta<typeof VersionOverlay> = {
  title: 'VersionOverlay',
  component: VersionOverlay,
};

const Template: StoryFn<typeof VersionOverlay> = (args: Record<string, never>) => <VersionOverlay {...args} />;

// eslint-disable-next-line
export const Default: StoryFn<typeof VersionOverlay> = Template.bind({});

export default meta;
