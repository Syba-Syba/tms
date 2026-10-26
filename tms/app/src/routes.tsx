import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { AppShell } from './components/app-shell';
import { RouteError } from './components/route-error';
import { currentUser } from './lib/session';

/** Each screen loads when its route is first visited, so the sign-in page does not pay for
    the inspection or termination code. The router suspends navigation until a chunk lands. */
const screen = (name: string, exportName: string) => async () => {
  const module = await import(`./screens/${name}.tsx`);
  return { Component: module[exportName] };
};

/** Nothing renders for nobody: without a session every path lands on the sign-in screen,
    which sends you back to where you were headed once you are someone. */
function RequireAuth() {
  const location = useLocation();
  if (!currentUser()) {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }
  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    // One boundary for every screen: a wrong address or a failed load gets a page a tenant
    // can act on. Unknown paths land here as a 404 rather than on a blank shell.
    errorElement: <RouteError />,
    children: [
      { path: '/login', lazy: screen('login', 'Login') },
      { path: '/register', lazy: screen('register', 'Register') },
      {
        element: <RequireAuth />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: '/', lazy: screen('home', 'Home') },
              {
                path: '/applications',
                lazy: screen('landlord-queue', 'LandlordQueue'),
              },
              { path: '/properties', lazy: screen('properties', 'Properties') },
              { path: '/documents', lazy: screen('documents', 'Documents') },
              { path: '/tickets', lazy: screen('tickets-list', 'TicketsList') },
              {
                path: '/tickets/:ticketId',
                lazy: screen('ticket-detail', 'TicketDetail'),
              },
              {
                path: '/leases/:leaseId',
                lazy: screen('lease-detail', 'LeaseDetail'),
              },
              {
                path: '/terminations/:terminationId',
                lazy: screen('termination', 'Termination'),
              },
              {
                path: '/settings/notifications',
                lazy: screen('notification-preferences', 'NotificationPreferences'),
              },
              {
                path: '/leases/:leaseId/rent',
                lazy: screen('tenant-rent', 'TenantRent'),
              },
              {
                path: '/leases/:leaseId/tickets/new',
                lazy: screen('ticket-new', 'TicketNew'),
              },
              {
                path: '/lease/:leaseId',
                lazy: screen('lease-review', 'LeaseReview'),
              },
              {
                path: '/inspections/:inspectionId',
                lazy: screen('inspection-rooms', 'InspectionRooms'),
              },
              {
                path: '/inspections/:inspectionId/room/:room',
                lazy: screen('inspection-room', 'InspectionRoom'),
              },
            ],
          },
          // The application flow is what a prospective tenant sees before they are a tenant, so
          // it sits outside the shell with its own navigation, but still behind sign-in: an
          // application needs an identity to belong to.
          { path: '/apply', lazy: screen('apply-start', 'ApplyStart') },
          {
            path: '/apply/:applicationId/documents',
            lazy: screen('apply-documents', 'ApplyDocuments'),
          },
        ],
      },
    ],
  },
]);
