import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireSystemAdmin } from '../auth/RequireSystemAdmin';
import { RequireSupportPerson } from '../auth/RequireSupportPerson';
import LandingPage from '../features/landing/LandingPage';
import AdminLoginPage from '../features/login/AdminLoginPage';
import SupportLoginPage from '../features/support/SupportLoginPage';
import SupportHomePage from '../features/support/SupportHomePage';
import ForbiddenPage from '../features/forbidden/ForbiddenPage';
import AdminLayout from '../features/admin/AdminLayout';
import AdminHomePage from '../features/admin/AdminHomePage';
import UsersPage from '../features/admin/users/UsersPage';
import UserDetailPage from '../features/admin/users/UserDetailPage';
import TasksPage from '../features/admin/tasks/TasksPage';
import OrganizationsPage from '../features/admin/organizations/OrganizationsPage';
import DangerZonePage from '../features/admin/DangerZonePage';

/**
 * Route table.
 * - `/`          public portal landing with links to each sign-in.
 * - `/admin`     admin sign-in; `/admin/*` is the SystemAdmin-guarded console.
 * - `/support`   support-person sign-in; `/support/home` is SupportPerson-guarded.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/forbidden" element={<ForbiddenPage />} />

      {/* Admin portal: sign-in at /admin, guarded console under /admin/*. */}
      <Route path="/admin" element={<AdminLoginPage />} />
      <Route
        element={
          <RequireSystemAdmin>
            <AdminLayout />
          </RequireSystemAdmin>
        }
      >
        <Route path="/admin/home" element={<AdminHomePage />} />
        <Route path="/admin/users" element={<UsersPage />} />
        <Route path="/admin/users/:userId" element={<UserDetailPage />} />
        <Route path="/admin/tasks" element={<TasksPage />} />
        <Route path="/admin/organizations" element={<OrganizationsPage />} />
        <Route path="/admin/danger" element={<DangerZonePage />} />
      </Route>

      {/* Support portal: sign-in at /support, guarded home under /support/home. */}
      <Route path="/support" element={<SupportLoginPage />} />
      <Route
        path="/support/home"
        element={
          <RequireSupportPerson>
            <SupportHomePage />
          </RequireSupportPerson>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
