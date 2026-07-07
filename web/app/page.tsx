'use client';
import { useAuth } from '@/lib/auth-context';
import { Tabs, TabItem } from '@/components/Tabs';
import { MyUsage } from '@/components/MyUsage';
import { MyLimits } from '@/components/MyLimits';
import { AdminUsers } from '@/components/AdminUsers';
import { UsageOverview } from '@/components/UsageOverview';
import { AdminTiers } from '@/components/AdminTiers';
import { AdminDashboard } from '@/components/AdminDashboard';
import { AdminModelRates } from '@/components/AdminModelRates';
import { MyCredentials } from '@/components/MyCredentials';
import { AdminConfig } from '@/components/AdminConfig';

export default function Home() {
  const { user, token, isAdmin, login, logout } = useAuth();

  if (!user || !token) {
    return (
      <main className="container">
        <h1>Code on Bedrock</h1>
        <p><button className="btn-primary" onClick={login}>Sign in with Cognito</button></p>
      </main>
    );
  }

  const tabs: TabItem[] = [
    {
      id: 'usage',
      label: 'My Usage',
      content: (
        <>
          <MyUsage token={token} />
          <MyLimits token={token} />
        </>
      ),
    },
    {
      id: 'credentials',
      label: 'Credentials',
      content: <MyCredentials token={token} />,
    },
    {
      id: 'config',
      label: 'Configuration',
      content: <AdminConfig token={token} />,
    },
  ];

  if (isAdmin) {
    tabs.push(
      {
        id: 'overview',
        label: 'Overview',
        content: (
          <>
            <AdminDashboard token={token} />
            <UsageOverview token={token} />
          </>
        ),
      },
      { id: 'users', label: 'Users', content: <AdminUsers token={token} /> },
      { id: 'tiers', label: 'Tiers', content: <AdminTiers token={token} /> },
      { id: 'rates', label: 'Model Rates', content: <AdminModelRates token={token} /> },
    );
  }

  return (
    <main className="container">
      <div className="topbar">
        <h1>Code on Bedrock</h1>
        <p>
          {user.email}{' '}
          <button onClick={logout}>Sign out</button>
        </p>
      </div>
      <Tabs tabs={tabs} ariaLabel="Code on Bedrock sections" />
    </main>
  );
}
