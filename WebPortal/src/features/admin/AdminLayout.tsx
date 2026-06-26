import { Outlet } from 'react-router-dom';
import { AdminShell } from './components/AdminShell';

/** Admin route layout: persistent shell (top bar + tabs) around the active section. */
export default function AdminLayout() {
  return (
    <AdminShell>
      <Outlet />
    </AdminShell>
  );
}
