package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Tokens represents stored OAuth tokens.
type Tokens struct {
	IDToken      string `json:"id_token"`
	RefreshToken string `json:"refresh_token"`
}

func tokenFilePath(tokenDir string) string {
	if tokenDir == "" {
		home, _ := os.UserHomeDir()
		tokenDir = filepath.Join(home, ".codeonbedrock")
	}
	return filepath.Join(tokenDir, "tokens.json")
}

func loadTokens(tokenDir string) (*Tokens, error) {
	data, err := os.ReadFile(tokenFilePath(tokenDir))
	if err != nil {
		return nil, err
	}
	var t Tokens
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

func saveTokens(tokenDir string, t *Tokens) error {
	p := tokenFilePath(tokenDir)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(t)
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0600)
}
