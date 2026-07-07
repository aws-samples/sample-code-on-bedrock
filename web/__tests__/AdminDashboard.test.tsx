import { render, screen } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { AdminDashboard } from '@/components/AdminDashboard';
import { AuthContext, AuthContextType } from '@/lib/auth-context';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
const mockApiFetch = vi.mocked(apiFetch);

function renderWithAuth(ui: React.ReactElement, auth: Partial<AuthContextType>) {
  const value: AuthContextType = {
    user: null,
    token: null,
    isAdmin: false,
    login: () => {},
    logout: () => {},
    ...auth,
  };
  return render(<AuthContext.Provider value={value}>{ui}</AuthContext.Provider>);
}

describe('AdminDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders dashboard data for admin', async () => {
    mockApiFetch.mockResolvedValueOnce({
      totalMonthCostUsd: 123.45,
      activeUsers: 5,
      blockedUsers: 2,
      byTier: [
        { tier: 'tier-power', totalCostUsd: 100, userCount: 2 },
        { tier: 'tier-standard', totalCostUsd: 23.45, userCount: 3 },
      ],
      topUsers: [
        { sub: 'abc-123', costUsd: 80 },
        { sub: 'def-456', costUsd: 20 },
      ],
    });

    renderWithAuth(<AdminDashboard token="test-token" />, {
      user: { sub: 'admin-1', email: 'admin@example.com', groups: ['admin'] },
      isAdmin: true,
    });

    expect(await screen.findByText('$123.45')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Blocked Users')).toBeInTheDocument();
    expect(screen.getByText('tier-power')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText(/abc-123/)).toBeInTheDocument();
  });

  test('does not render for non-admin', () => {
    renderWithAuth(<AdminDashboard token="test-token" />, {
      user: { sub: 'user-1', email: 'user@example.com', groups: ['tier-standard'] },
      isAdmin: false,
    });

    expect(screen.queryByText('Admin Dashboard')).not.toBeInTheDocument();
  });

  test('calls GET /admin/dashboard', async () => {
    mockApiFetch.mockResolvedValueOnce({
      totalMonthCostUsd: 0,
      activeUsers: 0,
      blockedUsers: 0,
      byTier: [],
      topUsers: [],
    });

    renderWithAuth(<AdminDashboard token="test-token" />, {
      user: { sub: 'admin-1', email: 'admin@example.com', groups: ['admin'] },
      isAdmin: true,
    });

    await screen.findByText('Admin Dashboard');
    expect(mockApiFetch).toHaveBeenCalledWith('/admin/dashboard', 'test-token');
  });
});
