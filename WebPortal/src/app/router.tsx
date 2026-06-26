import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireSystemAdmin } from '../auth/RequireSystemAdmin';
import LoginPage from '../features/login/LoginPage';
import ForbiddenPage from '../features/forbidden/ForbiddenPage';
import AdminLayout from '../features/admin/AdminLayout';
import AdminHomePage from '../features/admin/AdminHomePage';
import UsersPage from '../features/admin/users/UsersPage';
import UserDetailPage from '../features/admin/users/UserDetailPage';
import TasksPage from '../features/admin/tasks/TasksPage';
import DangerZonePage from '../features/admin/DangerZonePage';

/** Route table. `/` is the login gate; `/admin/*` is guarded by RequireSystemAdmin. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LoginPage />} />
      <Route path="/forbidden" element={<ForbiddenPage />} />
      <Route
        path="/admin"
        element={
          <RequireSystemAdmin>
            <AdminLayout />
          </RequireSystemAdmin>
        }
      >
        <Route index element={<AdminHomePage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="users/:userId" element={<UserDetailPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="danger" element={<DangerZonePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
