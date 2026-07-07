'use client';
import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/api';

interface Config {
  api_url: string;
  cognito_domain: string;
  client_id: string;
}

export function AdminConfig({ token }: { token: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<Config>('/config', token)
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, [token]);

  if (error) return <p className="error">Failed to load config: {error}</p>;
  if (!config) return <p>Loading...</p>;

  const initCmd = `codeonbedrock init ${config.api_url}config`;

  return (
    <section>
      <h2>CLI Configuration</h2>
      <p>Share this command with developers to configure the CLI:</p>
      <pre><code>{initCmd}</code></pre>
      <h3>Parameters</h3>
      <table>
        <thead>
          <tr><th>Parameter</th><th>Value</th></tr>
        </thead>
        <tbody>
          <tr><td>API URL</td><td><code>{config.api_url}</code></td></tr>
          <tr><td>Cognito Domain</td><td><code>{config.cognito_domain}</code></td></tr>
          <tr><td>Client ID</td><td><code>{config.client_id}</code></td></tr>
        </tbody>
      </table>
    </section>
  );
}
