package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(credsCmd)
}

var credsCmd = &cobra.Command{
	Use:   "creds",
	Short: "Vend AWS credentials via credential_process",
	RunE: func(cmd *cobra.Command, args []string) error {
		out, err := runCredsWithRefresh(cfg.TokenDir, cfg.APIBaseURL, cfg.CognitoDomain, cfg.ClientID)
		if err != nil {
			return err
		}
		fmt.Print(out)
		return nil
	},
}

func cachedCredsPath(tokenDir string) string {
	if tokenDir == "" {
		home, _ := os.UserHomeDir()
		tokenDir = filepath.Join(home, ".codeonbedrock")
	}
	return filepath.Join(tokenDir, "cached-creds.json")
}

func loadCachedCreds(tokenDir string) (string, bool) {
	data, err := os.ReadFile(cachedCredsPath(tokenDir))
	if err != nil {
		return "", false
	}
	var cred struct {
		Expiration string `json:"Expiration"`
	}
	if json.Unmarshal(data, &cred) != nil {
		return "", false
	}
	exp, err := time.Parse(time.RFC3339, cred.Expiration)
	if err != nil {
		return "", false
	}
	if time.Until(exp) <= 60*time.Second {
		return "", false
	}
	return string(data), true
}

func saveCachedCreds(tokenDir, creds string) {
	p := cachedCredsPath(tokenDir)
	os.MkdirAll(filepath.Dir(p), 0700)
	os.WriteFile(p, []byte(creds), 0600)
}

func runCreds(tokenDir, apiURL string) (string, error) {
	return runCredsWithRefresh(tokenDir, apiURL, "", "")
}

func runCredsWithRefresh(tokenDir, apiURL, cognitoDomain, clientID string) (string, error) {
	if cached, ok := loadCachedCreds(tokenDir); ok {
		return cached, nil
	}

	tokens, err := loadTokens(tokenDir)
	if err != nil {
		return "", fmt.Errorf("not logged in: run 'codeonbedrock login' first")
	}

	// Try with current token
	out, err := callCredentials(apiURL, tokens.IDToken)
	if err == nil {
		saveCachedCreds(tokenDir, out)
		return out, nil
	}

	// If 401 and we have refresh capability, try refresh
	if err.Error() == "unauthorized" && cognitoDomain != "" && clientID != "" && tokens.RefreshToken != "" {
		newToken, refreshErr := refreshIDToken(cognitoDomain, clientID, tokens.RefreshToken)
		if refreshErr != nil {
			return "", refreshErr
		}
		tokens.IDToken = newToken
		saveTokens(tokenDir, tokens)
		out, err = callCredentials(apiURL, tokens.IDToken)
		if err == nil {
			saveCachedCreds(tokenDir, out)
		}
		return out, err
	}

	return "", err
}

func callCredentials(apiURL, idToken string) (string, error) {
	req, _ := http.NewRequest("POST", strings.TrimRight(apiURL, "/")+"/credentials", nil)
	req.Header.Set("Authorization", "Bearer "+idToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusForbidden {
		var errBody struct {
			Message      string `json:"message"`
			ResetTime    string `json:"resetTime"`
			AdminContact string `json:"adminContact"`
		}
		if json.Unmarshal(body, &errBody) == nil && errBody.Message != "" {
			msg := fmt.Sprintf("blocked: %s", errBody.Message)
			if errBody.ResetTime != "" {
				msg += fmt.Sprintf("\n  Reset: %s", errBody.ResetTime)
			}
			if errBody.AdminContact != "" {
				msg += fmt.Sprintf("\n  %s", errBody.AdminContact)
			}
			return "", fmt.Errorf("%s", msg)
		}
		return "", fmt.Errorf("blocked: you have exceeded your budget")
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return "", fmt.Errorf("unauthorized")
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("API error: %d %s", resp.StatusCode, string(body))
	}

	// Re-encode to ensure valid JSON output
	var cred map[string]interface{}
	if err := json.Unmarshal(body, &cred); err != nil {
		return "", err
	}
	out, _ := json.Marshal(cred)
	return string(out), nil
}

func refreshIDToken(cognitoDomain, clientID, refreshToken string) (string, error) {
	tokenURL := strings.TrimRight(cognitoDomain, "/") + "/oauth2/token"
	data := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {clientID},
		"refresh_token": {refreshToken},
	}

	resp, err := http.PostForm(tokenURL, data)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token refresh failed: %d", resp.StatusCode)
	}

	var result struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	return result.IDToken, nil
}
