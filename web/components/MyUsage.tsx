'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { UsageChart } from './UsageChart';

interface ModelUsage {
  modelId: string;
  period: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  invocations: number;
}

interface UsageData {
  day: { costUsd: number; inputTokens: number; outputTokens: number };
  month: { costUsd: number; inputTokens: number; outputTokens: number };
  models?: ModelUsage[];
}

interface HistoryDay {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function defaultTo() {
  return new Date().toISOString().slice(0, 10);
}

export function MyUsage({ token }: { token: string }) {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [history, setHistory] = useState<HistoryDay[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<UsageData>('/me/usage?breakdown=model', token).then(setData).catch((e) => setError(e.message));
  }, [token]);

  useEffect(() => {
    apiFetch<{ days: HistoryDay[] }>(`/me/usage/history?from=${from}&to=${to}`, token)
      .then((d) => { setHistory(d.days); setHistoryError(null); })
      .catch((e) => setHistoryError(e.message));
  }, [token, from, to]);

  if (error) return <p className="error" role="alert">Failed to load usage: {error}</p>;
  if (!data) return <p>Loading...</p>;

  const monthModels = (data.models ?? []).filter(m => m.period === 'month');

  return (
    <div className="card">
      <h2>My Usage</h2>
      <h3>Today</h3>
      <p>Cost: {`$${data.day.costUsd.toFixed(2)}`}</p>
      <p>Input tokens: {data.day.inputTokens.toLocaleString('en-US')}</p>
      <p>Output tokens: {data.day.outputTokens.toLocaleString('en-US')}</p>
      <h3>This Month</h3>
      <p>Cost: {`$${data.month.costUsd.toFixed(2)}`}</p>
      <p>Input tokens: {data.month.inputTokens.toLocaleString('en-US')}</p>
      <p>Output tokens: {data.month.outputTokens.toLocaleString('en-US')}</p>
      {monthModels.length > 0 && (
        <details open={showModels} onToggle={(e) => setShowModels((e.target as HTMLDetailsElement).open)}>
          <summary><h3 style={{ display: 'inline' }}>By Model</h3></summary>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Cost</th>
                <th>Input Tokens</th>
                <th>Output Tokens</th>
                <th>Invocations</th>
              </tr>
            </thead>
            <tbody>
              {monthModels.map(m => (
                <tr key={m.modelId}>
                  <td>{m.modelId}</td>
                  <td>{`$${m.costUsd.toFixed(4)}`}</td>
                  <td>{m.inputTokens.toLocaleString('en-US')}</td>
                  <td>{m.outputTokens.toLocaleString('en-US')}</td>
                  <td>{m.invocations.toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <h3>Usage History</h3>
      <div className="date-range">
        <label>From: <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To: <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {historyError && <p className="error" role="alert">Failed to load history: {historyError}</p>}
      <UsageChart data={history} />
      {history.length > 0 ? (
        <table>
          <thead>
            <tr><th>Date</th><th>Cost</th><th>Input Tokens</th><th>Output Tokens</th></tr>
          </thead>
          <tbody>
            {history.map(d => (
              <tr key={d.date}>
                <td>{d.date}</td>
                <td>{`$${d.costUsd.toFixed(2)}`}</td>
                <td>{d.inputTokens.toLocaleString('en-US')}</td>
                <td>{d.outputTokens.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        !historyError && <p>No history data for this range.</p>
      )}
    </div>
  );
}
