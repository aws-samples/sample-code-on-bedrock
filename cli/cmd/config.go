package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// PersistentConfig is saved to ~/.codeonbedrock/config.json during login.
type PersistentConfig struct {
	APIBaseURL    string `json:"api_url"`
	CognitoDomain string `json:"cognito_domain"`
	ClientID      string `json:"client_id"`
}

func configFilePath(tokenDir string) string {
	if tokenDir == "" {
		home, _ := os.UserHomeDir()
		tokenDir = filepath.Join(home, ".codeonbedrock")
	}
	return filepath.Join(tokenDir, "config.json")
}

func loadPersistentConfig(tokenDir string) (*PersistentConfig, error) {
	data, err := os.ReadFile(configFilePath(tokenDir))
	if err != nil {
		return nil, err
	}
	var pc PersistentConfig
	if err := json.Unmarshal(data, &pc); err != nil {
		return nil, err
	}
	return &pc, nil
}

func savePersistentConfig(tokenDir string, pc *PersistentConfig) error {
	p := configFilePath(tokenDir)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(pc)
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0600)
}
