import { Outlet } from 'react-router-dom';
import { SupportShell } from './SupportShell';

/** Support route layout: persistent shell (top bar + tab) around the active section. */
export default function SupportLayout() {
  return (
    <SupportShell>
      <Outlet />
    </SupportShell>
  );
}
