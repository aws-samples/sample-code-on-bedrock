import { render, screen } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MyUsage } from '@/components/MyUsage';

// R-UI-3: "My usage" view showing current-day and current-month usage
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
const mockApiFetch = vi.mocked(apiFetch);

describe('MyUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders day and month usage totals', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('/me/usage/history')) return Promise.resolve({ days: [] });
      return Promise.resolve({
        day: { costUsd: 1.23, inputTokens: 1000, outputTokens: 500 },
        month: { costUsd: 45.67, inputTokens: 50000, outputTokens: 25000 },
      });
    });

    render(<MyUsage token="test-token" />);

    expect(await screen.findByText(/\$1\.23/)).toBeInTheDocument();
    expect(screen.getByText(/\$45\.67/)).toBeInTheDocument();
    expect(screen.getByText(/1,000/)).toBeInTheDocument();
    expect(screen.getByText(/50,000/)).toBeInTheDocument();
  });

  test('renders zero usage when no data', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('/me/usage/history')) return Promise.resolve({ days: [] });
      return Promise.resolve({
        day: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
        month: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      });
    });

    render(<MyUsage token="test-token" />);

    const zeros = await screen.findAllByText(/\$0\.00/);
    expect(zeros).toHaveLength(2);
  });

  test('calls GET /me/usage?breakdown=model', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('/me/usage/history')) return Promise.resolve({ days: [] });
      return Promise.resolve({
        day: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
        month: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      });
    });

    render(<MyUsage token="test-token" />);
    await screen.findAllByText(/\$0\.00/);

    expect(mockApiFetch).toHaveBeenCalledWith('/me/usage?breakdown=model', 'test-token');
  });
});
