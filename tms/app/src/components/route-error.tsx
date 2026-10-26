import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
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
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-[26px] font-extrabold tracking-tight">
        {notFound
          ? 'Page not found'
          : staleBuild
            ? 'There is a newer version'
            : 'Something went wrong'}
      </h1>
      <p className="mb-5 text-[14px] text-ink-muted">
        {notFound
          ? 'That address does not lead anywhere. It may have been mistyped, or the page has moved.'
          : staleBuild
            ? 'The app was updated while you had it open. Reload to carry on.'
            : 'This screen could not be shown. Reloading usually fixes it.'}
      </p>
      <div className="flex gap-2">
        {notFound ? null : <Button onClick={() => window.location.reload()}>Reload</Button>}
        <Link
          to="/"
          className="inline-flex h-11 items-center px-3 text-[15px] font-semibold text-brand-600"
        >
          Go home
        </Link>
      </div>
    </main>
  );
}
