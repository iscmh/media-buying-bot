import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from '@/components/layout/app-shell';
import { VillageScreen } from '@/features/village/village-screen';
import { DeployScreen } from '@/features/deploy/deploy-screen';
import { BattleLogScreen } from '@/features/battle-log/battle-log-screen';
import { QuestsScreen } from '@/features/quests/quests-screen';
import { ProfileScreen } from '@/features/stats/profile-screen';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <VillageScreen /> },
      { path: 'deploy', element: <DeployScreen /> },
      { path: 'battle-log', element: <BattleLogScreen /> },
      { path: 'quests', element: <QuestsScreen /> },
      { path: 'profile', element: <ProfileScreen /> },
    ],
  },
]);
