package cmd

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoginPKCEChallenge(t *testing.T) {
	verifier, challenge := generatePKCE()

	if len(verifier) < 43 || len(verifier) > 128 {
		t.Fatalf("verifier length %d out of range [43,128]", len(verifier))
	}

	h := sha256.Sum256([]byte(verifier))
	expected := base64.RawURLEncoding.EncodeToString(h[:])
	if challenge != expected {
		t.Fatalf("challenge mismatch: got %s, want %s", challenge, expected)
	}
}

func TestLoginLocalServer(t *testing.T) {
	codeCh := make(chan string, 1)
	srv, port := startCallbackServer(codeCh)
	defer srv.Close()

	resp, err := http.Get("http://localhost:" + port + "/callback?code=test-auth-code")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	code := <-codeCh
	if code != "test-auth-code" {
		t.Fatalf("expected 'test-auth-code', got %q", code)
	}
}

func TestLoginTokenExchange(t *testing.T) {
	var gotGrantType, gotVerifier string
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		gotGrantType = r.PostFormValue("grant_type")
		gotVerifier = r.PostFormValue("code_verifier")
		json.NewEncoder(w).Encode(map[string]string{
			"id_token":      "mock-id-token",
			"refresh_token": "mock-refresh-token",
		})
	}))
	defer mock.Close()

	tokens, err := exchangeCode("test-code", "test-verifier", mock.URL, "test-client-id", "http://localhost:8787/callback")
	if err != nil {
		t.Fatal(err)
	}
	if tokens.IDToken != "mock-id-token" {
		t.Fatalf("expected mock-id-token, got %s", tokens.IDToken)
	}
	if tokens.RefreshToken != "mock-refresh-token" {
		t.Fatalf("expected mock-refresh-token, got %s", tokens.RefreshToken)
	}
	if gotGrantType != "authorization_code" {
		t.Fatalf("expected grant_type=authorization_code, got %s", gotGrantType)
	}
	if gotVerifier != "test-verifier" {
		t.Fatalf("expected code_verifier=test-verifier, got %s", gotVerifier)
	}
}

func TestLoginStoresTokensWithPermissions(t *testing.T) {
	dir := t.TempDir()
	tok := &Tokens{IDToken: "id-tok", RefreshToken: "ref-tok"}
	if err := saveTokens(dir, tok); err != nil {
		t.Fatal(err)
	}

	loaded, err := loadTokens(dir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.IDToken != "id-tok" || loaded.RefreshToken != "ref-tok" {
		t.Fatalf("token mismatch: %+v", loaded)
	}

	info, err := os.Stat(tokenFilePath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("expected 0600 permissions, got %o", info.Mode().Perm())
	}
}

func TestLoginWritesAWSConfigProfile(t *testing.T) {
	dir := t.TempDir()
	if err := writeAWSConfigProfile(dir); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "config"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	if !strings.Contains(content, "[profile codeonbedrock]") {
		t.Fatal("missing [profile codeonbedrock] section")
	}
	if !strings.Contains(content, "credential_process = codeonbedrock creds") {
		t.Fatal("missing credential_process entry")
	}
}

// startCallbackServer helper — returns *http.Server and port string
func startCallbackServerHelper(t *testing.T) (*http.Server, string, chan string) {
	t.Helper()
	codeCh := make(chan string, 1)
	srv, port := startCallbackServer(codeCh)
	return srv, port, codeCh
}

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	_, port, _ := net.SplitHostPort(l.Addr().String())
	return port
}
