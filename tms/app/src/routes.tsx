import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { AppShell } from './components/app-shell';
import { RouteError } from './components/route-error';
import { ConsentGate } from './components/consent-gate';
import { currentUser, isLandlord } from './lib/session';

/** Each screen loads when its route is first visited, so the sign-in page does not pay for
    the inspection or termination code. The router suspends navigation until a chunk lands. */
const screen = (name: string, exportName: string) => async () => {
  const module = await import(`./screens/${name}.tsx`);
  return { Component: module[exportName] };
};

/** Nothing renders for nobody: without a session every path lands on the sign-in screen,
    which sends you back to where you were headed once you are someone. */
/** Landlords open on their account; tenants have only their own settings. */
function SettingsIndex() {
  return <Navigate to={isLandlord() ? '/settings/account' : '/settings/notifications'} replace />;
}

function RequireAuth() {
  const location = useLocation();
  if (!currentUser()) {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }
  return (
    <ConsentGate>
      <Outlet />
    </ConsentGate>
  );
}

export const router = createBrowserRouter([
  {
    // One boundary for every screen: a wrong address or a failed load gets a page a tenant
    // can act on. Unknown paths land here as a 404 rather than on a blank shell.
    errorElement: <RouteError />,
    children: [
      { path: '/login', lazy: screen('login', 'Login') },
      { path: '/register', lazy: screen('register', 'Register') },
      { path: '/forgot-password', lazy: screen('forgot-password', 'ForgotPassword') },
      { path: '/reset-password', lazy: screen('reset-password', 'ResetPassword') },
      // An agent's invitation: public, because they have no sign-in until they finish it.
      { path: '/join', lazy: screen('join', 'Join') },
      // Public, so it can be read before signing up.
      { path: '/privacy', lazy: screen('privacy', 'Privacy') },
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
              { path: '/payments', lazy: screen('payments', 'Payments') },
              { path: '/reports', lazy: screen('reports', 'Reports') },
              { path: '/documents', lazy: screen('documents', 'Documents') },
              { path: '/tickets', lazy: screen('tickets-list', 'TicketsList') },
              { path: '/activity', lazy: screen('activity', 'Activity') },
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
              { path: '/settings', element: <SettingsIndex /> },
              { path: '/settings/account', lazy: screen('settings-account', 'SettingsAccount') },
              { path: '/settings/team', lazy: screen('settings-team', 'SettingsTeam') },
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
