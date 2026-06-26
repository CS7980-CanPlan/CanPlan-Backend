import { Route, Routes } from 'react-router-dom';
import Header from './components/Header';
import StartPage from './pages/StartPage';

/**
 * Root application component. Defines the portal layout (persistent header)
 * and the route table. Additional pages (users, tasks, settings) can be added
 * to the <Routes> block as the portal grows.
 */
export default function App() {
  return (
    <>
      <Header />
      <main id="main-content">
        <Routes>
          <Route path="/" element={<StartPage />} />
        </Routes>
      </main>
    </>
  );
}
