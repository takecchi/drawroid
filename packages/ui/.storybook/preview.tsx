import type { Preview } from '@storybook/react-vite';

import './preview.css';
import { drawroidDark } from './theme';

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: { disable: true },
    docs: { theme: drawroidDark },
  },
  decorators: [
    (Story, context) => {
      const theme = typeof context.globals.theme === 'string' ? context.globals.theme : 'dark';
      document.documentElement.classList.toggle('dark', theme === 'dark');
      return <Story />;
    },
  ],
  globalTypes: {
    theme: {
      description: '明るい側・暗い側',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'dark', title: 'Dark', icon: 'moon' },
          { value: 'light', title: 'Light', icon: 'sun' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'dark',
  },
};

export default preview;
