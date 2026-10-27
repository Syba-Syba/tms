export default {
  presets: [require('@hlonie/toolbox/tailwind-preset')],
  // npm workspaces install the toolbox at the repository root, not under this app, so the old
  // ./node_modules path matched nothing. Classes used only inside toolbox components (the
  // modal's centring, among others) were never generated, and every dialog rendered below
  // the page. Both paths are listed so a standalone install of the app still works.
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../toolbox/dist/**/*.js',
    './node_modules/@hlonie/toolbox/dist/**/*.js',
  ],
};
