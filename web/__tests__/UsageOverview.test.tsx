import { render, screen } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { UsageOverview } from '@/components/UsageOverview';
import { AuthContext, AuthContextType } from '@/lib/auth-context';

// R-UI-4: Admin "Usage overview" view
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

describe('UsageOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders all-users usage for admin', async () => {
    mockApiFetch.mockResolvedValueOnce({
      users: [
        { sub: 'abc-123', email: 'alice@example.com', costUsd: 12.34, inputTokens: 10000, outputTokens: 5000 },
        { sub: 'def-456', email: 'bob@example.com', costUsd: 56.78, inputTokens: 40000, outputTokens: 20000 },
      ],
    });

    renderWithAuth(<UsageOverview token="test-token" />, {
      user: { sub: 'admin-1', email: 'admin@example.com', groups: ['admin'] },
      isAdmin: true,
    });

    expect(await screen.findByText('$12.34')).toBeInTheDocument();
    expect(screen.getByText('$56.78')).toBeInTheDocument();
    expect(screen.getByText('10,000')).toBeInTheDocument();
  });

  test('does not render for non-admin', () => {
    renderWithAuth(<UsageOverview token="test-token" />, {
      user: { sub: 'user-1', email: 'user@example.com', groups: ['tier-standard'] },
      isAdmin: false,
    });

    expect(screen.queryByText('Usage Overview')).not.toBeInTheDocument();
  });
});
