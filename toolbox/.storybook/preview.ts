import type { Preview } from '@storybook/react';
import '../src/tokens/tokens.css';

const preview: Preview = {
  parameters: {
    controls: { expanded: true },
    backgrounds: { default: 'app', values: [{ name: 'app', value: '#f7f6f3' }] },
  },
};

export default preview;
