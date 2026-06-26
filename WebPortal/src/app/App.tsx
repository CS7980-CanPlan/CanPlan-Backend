import { Providers } from './providers';
import { AppRoutes } from './router';

/** Root component: app-wide providers wrapping the route table. */
export default function App() {
  return (
    <Providers>
      <AppRoutes />
    </Providers>
  );
}
