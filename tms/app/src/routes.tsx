import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AppShell } from './components/app-shell';
import { currentUser } from './lib/session';
import { Home } from './screens/home';
import { ApplyStart } from './screens/apply-start';
import { ApplyDocuments } from './screens/apply-documents';
import { LeaseReview } from './screens/lease-review';
import { LandlordQueue } from './screens/landlord-queue';
import { InspectionRooms } from './screens/inspection-rooms';
import { InspectionRoom } from './screens/inspection-room';
import { TenantRent } from './screens/tenant-rent';
import { TicketNew } from './screens/ticket-new';
import { TicketsList } from './screens/tickets-list';
import { NotificationPreferences } from './screens/notification-preferences';
import { TicketDetail } from './screens/ticket-detail';
import { LeaseDetail } from './screens/lease-detail';
import { Termination } from './screens/termination';
import { Documents } from './screens/documents';
import { Properties } from './screens/properties';
import { Login } from './screens/login';
import { Register } from './screens/register';

/** Nothing renders for nobody: without a session every path lands on the sign-in screen,
    which sends you back to where you were headed once you are someone. */
function RequireAuth() {
  const location = useLocation();
  if (!currentUser()) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return <Outlet />;
}

export const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/register', element: <Register /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: '/', element: <Home /> },
          { path: '/applications', element: <LandlordQueue /> },
          { path: '/properties', element: <Properties /> },
          { path: '/documents', element: <Documents /> },
          { path: '/tickets', element: <TicketsList /> },
          { path: '/tickets/:ticketId', element: <TicketDetail /> },
          { path: '/leases/:leaseId', element: <LeaseDetail /> },
          { path: '/terminations/:terminationId', element: <Termination /> },
          { path: '/settings/notifications', element: <NotificationPreferences /> },
          { path: '/leases/:leaseId/rent', element: <TenantRent /> },
          { path: '/leases/:leaseId/tickets/new', element: <TicketNew /> },
          { path: '/lease/:leaseId', element: <LeaseReview /> },
          { path: '/inspections/:inspectionId', element: <InspectionRooms /> },
          { path: '/inspections/:inspectionId/room/:room', element: <InspectionRoom /> },
        ],
      },
      // The application flow is what a prospective tenant sees before they are a tenant, so
      // it sits outside the shell with its own navigation, but still behind sign-in: an
      // application needs an identity to belong to.
      { path: '/apply', element: <ApplyStart /> },
      { path: '/apply/:applicationId/documents', element: <ApplyDocuments /> },
    ],
  },
], {
  future: { v7_relativeSplatPath: true },
});
