import type { Preview } from '@storybook/react-vite';

import './preview.css';

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: { disable: true },
  },
  decorators: [
    (Story, context) => {
      const theme = typeof context.globals.theme === 'string' ? context.globals.theme : 'light';
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
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'light',
  },
};

export default preview;
