import { Outlet } from 'react-router-dom';
import { BottomNav } from './bottom-nav';
import { ToastContainer } from '@/components/ui/toast';

export function AppShell() {
  return (
    <div className="bg-empire-bg flex min-h-screen flex-col text-white">
      <ToastContainer />
      <main className="flex-1 overflow-y-auto pb-20">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
