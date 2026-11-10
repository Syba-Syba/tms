import { isRouteErrorResponse, useRouteError } from 'react-router';
import { LinkButton } from './link-button';
import { Wordmark } from './wordmark';
import { Button } from '@hlonie/toolbox/ui';

/**
 * Without this, a wrong address or a screen that failed to load showed React Router's own
 * "Hey developer" page to tenants.
 */
export function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  // After a rebuild the old screen files are gone, so an open tab cannot load the next one.
  const staleBuild =
    error instanceof TypeError &&
    /dynamically imported module|Importing a module script failed/i.test(error.message);

  if (!notFound && import.meta.env.DEV) console.error(error);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <span className="mb-8 block">
        <Wordmark />
      </span>
      <h1 className="mb-2 font-display text-display font-bold leading-tight tracking-[-0.01em] text-ink">
        {notFound
          ? 'Page not found'
          : staleBuild
            ? 'There is a newer version'
            : 'Something went wrong'}
      </h1>
      <p className="mb-6 text-lead text-ink-muted">
        {notFound
          ? 'That address does not lead anywhere. It may have been mistyped, or the page has moved.'
          : staleBuild
            ? 'The app was updated while you had it open. Reload to carry on.'
            : 'This screen could not be shown. Reloading usually fixes it.'}
      </p>
      <div className="flex gap-2">
        {notFound ? null : <Button onClick={() => window.location.reload()}>Reload</Button>}
        <LinkButton to="/" variant={notFound ? 'primary' : 'outline'}>
          Go home
        </LinkButton>
      </div>
    </main>
  );
}
