# @hlonie/toolbox

Your personal toolbox. One package, many entry points, no publishing required.

## Install into a project

Local workspace, no registry:

```bash
# from your app folder
npm install ../toolbox
# or link it once and reuse everywhere
cd toolbox && npm link
cd ../my-app && npm link @hlonie/toolbox
```

## Wire it up

```js
// tailwind.config.js
module.exports = {
  presets: [require('@hlonie/toolbox/tailwind-preset')],
  content: ['./src/**/*.{ts,tsx}', './node_modules/@hlonie/toolbox/dist/**/*.js'],
};
```

```tsx
// main.tsx
import '@hlonie/toolbox/tokens.css';
import { ThemeProvider, ToastProvider } from '@hlonie/toolbox/ui';
```

## Entry points

| Import | What you get |
| --- | --- |
| `@hlonie/toolbox` | tokens, `cn`, all UI, hooks, utils |
| `@hlonie/toolbox/ui` | Button, Input, Select, Checkbox, Switch, Card, Badge, Alert, Skeleton, Spinner, EmptyState, Modal, Tabs, Tooltip, Toast, Pagination, PageHeader, AppShell, DataTable, ThemeProvider |
| `@hlonie/toolbox/hooks` | useLocalStorage, useDebounce, useMediaQuery, useOnlineStatus, useClickOutside, useIntersection, usePrevious, useCopyToClipboard, useInterval, useToggle |
| `@hlonie/toolbox/utils` | ZAR money and VAT, SA ID parsing, phone normalisation, VIN validation, dates, strings, retry, timeout, concurrency pool, collections |
| `@hlonie/toolbox/forms` | react-hook-form fields wired to the UI, plus Zod schemas for ID, phone, VIN, password |
| `@hlonie/toolbox/data` | fetch client with auth refresh, retry, timeout, typed errors, TanStack Query defaults |
| `@hlonie/toolbox/charts` | TrendChart on Recharts, themed from tokens |
| `@hlonie/toolbox/offline` | Dexie store, draft versioning, sync queue, OPFS file helpers |
| `@hlonie/toolbox/icons` | stroke icons sized in `em` |
| `@hlonie/toolbox/testing` | renderWithProviders, jsdom setup, fixture builders |
| `@hlonie/toolbox/node` | logger with redaction, typed errors, env parsing, request middleware, pagination |

## Commands

```bash
npm run build      # tsup, ESM and .d.ts
npm run dev        # watch build
npm run typecheck
npm run test
npm run storybook  # component showroom on 6006
npm run lint
```

## Rules that keep this useful

1. No hex values in apps. Every colour comes from a token.
2. A component enters the toolbox on its third copy-paste, not its first idea.
3. Every component takes `className` and forwards its ref.
4. Keyboard focus stays visible. Reduced motion is respected.
5. Breaking a prop means bumping the version and fixing the apps.

## Next steps

- Add a `templates/` folder with a Vite starter that imports this package.
- Add Playwright and axe checks to CI once the first app exists.
- Split into a pnpm monorepo only when two packages need different release cycles.
