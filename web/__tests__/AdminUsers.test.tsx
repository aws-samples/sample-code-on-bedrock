import { render, screen } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { AdminUsers } from '@/components/AdminUsers';
import { AuthContext, AuthContextType } from '@/lib/auth-context';

// R-UI-4: Admin "Users" view, only visible to admin group
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
const mockApiFetch = vi.mocked(apiFetch);

function renderWithAuth(ui: React.ReactElement, auth: Partial<AuthContextType>) {
  const value: AuthContextType = {
    user: null,
    isAdmin: false,
    login: () => {},
    logout: () => {},
    ...auth,
  };
  return render(<AuthContext.Provider value={value}>{ui}</AuthContext.Provider>);
}

describe('AdminUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders user list for admin', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('/admin/tiers')) return Promise.resolve({ tiers: [] });
      return Promise.resolve({
        users: [
          { sub: 'abc-123', email: 'alice@example.com', tier: 'tier-standard', createdAt: '2026-01-01', dailyUsd: 5, monthlyUsd: 50, blocked: false },
          { sub: 'def-456', email: 'bob@example.com', tier: 'tier-power', createdAt: '2026-02-01', dailyUsd: 10, monthlyUsd: 100, blocked: false },
        ],
      });
    });

    renderWithAuth(<AdminUsers token="test-token" />, {
      user: { sub: 'admin-1', email: 'admin@example.com', groups: ['admin'] },
      isAdmin: true,
    });

    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });

  test('does not render for non-admin', () => {
    renderWithAuth(<AdminUsers token="test-token" />, {
      user: { sub: 'user-1', email: 'user@example.com', groups: ['tier-standard'] },
      isAdmin: false,
    });

    expect(screen.queryByText('Users')).not.toBeInTheDocument();
  });

  test('calls GET /admin/users', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('/admin/tiers')) return Promise.resolve({ tiers: [] });
      return Promise.resolve({ users: [] });
    });

    renderWithAuth(<AdminUsers token="test-token" />, {
      user: { sub: 'admin-1', email: 'admin@example.com', groups: ['admin'] },
      isAdmin: true,
    });

    await screen.findByText('Users');
    expect(mockApiFetch).toHaveBeenCalledWith('/admin/users', 'test-token');
  });
});
