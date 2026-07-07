package cmd

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(loginCmd)
}

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Authenticate via Cognito Hosted UI",
	RunE: func(cmd *cobra.Command, args []string) error {
		verifier, challenge := generatePKCE()

		codeCh := make(chan string, 1)
		srv, port := startCallbackServer(codeCh)
		defer srv.Close()

		redirectURI := fmt.Sprintf("http://localhost:%s/callback", port)
		authURL := fmt.Sprintf("%s/oauth2/authorize?response_type=code&client_id=%s&redirect_uri=%s&scope=%s&code_challenge=%s&code_challenge_method=S256",
			strings.TrimRight(cfg.CognitoDomain, "/"), cfg.ClientID, url.QueryEscape(redirectURI), url.QueryEscape("openid email profile"), challenge)

		fmt.Printf("Opening browser for login...\nIf it doesn't open, visit:\n%s\n", authURL)
		openBrowser(authURL)

		code := <-codeCh
		tokens, err := exchangeCode(code, verifier, cfg.CognitoDomain, cfg.ClientID, redirectURI)
		if err != nil {
			return fmt.Errorf("token exchange failed: %w", err)
		}

		if err := saveTokens(cfg.TokenDir, tokens); err != nil {
			return fmt.Errorf("failed to save tokens: %w", err)
		}

		if err := savePersistentConfig(cfg.TokenDir, &PersistentConfig{
			APIBaseURL:    cfg.APIBaseURL,
			CognitoDomain: cfg.CognitoDomain,
			ClientID:      cfg.ClientID,
		}); err != nil {
			return fmt.Errorf("failed to save config: %w", err)
		}

		home, _ := os.UserHomeDir()
		if err := writeAWSConfigProfile(filepath.Join(home, ".aws")); err != nil {
			return fmt.Errorf("failed to write AWS config: %w", err)
		}

		fmt.Println("Login successful! AWS profile 'codeonbedrock' configured.")
		return nil
	},
}

func generatePKCE() (verifier, challenge string) {
	b := make([]byte, 32)
	rand.Read(b)
	verifier = base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(h[:])
	return
}

func startCallbackServer(codeCh chan string) (*http.Server, string) {
	port := fmt.Sprintf("%d", cfg.CallbackPort)
	ln, _ := net.Listen("tcp", "localhost:"+port)

	mux := http.NewServeMux()
	srv := &http.Server{Handler: mux}

	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		codeCh <- code
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "Login successful! You can close this window.")
	})

	go srv.Serve(ln)
	return srv, port
}

func exchangeCode(code, verifier, cognitoDomain, clientID, redirectURI string) (*Tokens, error) {
	tokenURL := strings.TrimRight(cognitoDomain, "/") + "/oauth2/token"
	data := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {clientID},
		"redirect_uri":  {redirectURI},
		"code_verifier": {verifier},
	}

	resp, err := http.PostForm(tokenURL, data)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token exchange failed: %d", resp.StatusCode)
	}

	var result struct {
		IDToken      string `json:"id_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &Tokens{IDToken: result.IDToken, RefreshToken: result.RefreshToken}, nil
}

func writeAWSConfigProfile(awsDir string) error {
	configPath := filepath.Join(awsDir, "config")

	var content string
	if data, err := os.ReadFile(configPath); err == nil {
		content = string(data)
	}

	profileHeader := "[profile codeonbedrock]"
	if strings.Contains(content, profileHeader) {
		return nil // already present
	}

	entry := "\n" + profileHeader + "\ncredential_process = codeonbedrock creds\n"
	if content == "" {
		entry = profileHeader + "\ncredential_process = codeonbedrock creds\n"
	}

	if err := os.MkdirAll(awsDir, 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(configPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(entry)
	return err
}

func openBrowser(url string) {
	switch runtime.GOOS {
	case "darwin":
		exec.Command("open", url).Start()
	case "linux":
		exec.Command("xdg-open", url).Start()
	case "windows":
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	}
}
