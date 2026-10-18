import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { Benchmarks } from './pages/Benchmarks';
import { Compare } from './pages/Compare';
import { Connections } from './pages/Connections';
import { GraphEditor } from './pages/GraphEditor';
import { Workspace, LiveRunWorkspace } from './pages/Workspace';
import { RunHistory } from './pages/RunHistory';

export function App() {
  const location = useLocation();
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Workspace key={location.key} />} />
        <Route path="/runs" element={<RunHistory />} />
        <Route path="/runs/:id" element={<LiveRunWorkspace key={location.pathname} />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/compare" element={<Compare />} />
        <Route path="/benchmarks" element={<Benchmarks />} />
        <Route path="/graphs" element={<GraphEditor />} />
        <Route path="/graphs/:id" element={<GraphEditor key={location.pathname} />} />
        <Route
          path="*"
          element={
            <div className="library-empty">
              <h1>This page isn't here.</h1>
              <Link className="primary-button" to="/">
                Return to your workspace
              </Link>
            </div>
          }
        />
      </Routes>
    </AppShell>
  );
}
