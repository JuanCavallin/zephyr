import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { Benchmarks } from './pages/Benchmarks';
import { BoardHome, BoardPage } from './pages/Board';
import { Compare } from './pages/Compare';
import { Integrations } from './pages/Integrations';
import { GraphEditor } from './pages/GraphEditor';
import { Learned } from './pages/Learned';
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
        <Route path="/board" element={<BoardHome />} />
        <Route path="/board/:id" element={<BoardPage key={location.pathname} />} />
        <Route path="/integrations/:kind?/:id?" element={<Integrations />} />
        <Route path="/connections" element={<Navigate to="/integrations" replace />} />
        <Route path="/compare" element={<Compare />} />
        <Route path="/benchmarks" element={<Benchmarks />} />
        <Route path="/learned" element={<Learned />} />
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
