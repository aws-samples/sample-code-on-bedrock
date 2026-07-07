package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestInitFetchesConfigFromURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{
			"api_url":        "https://api.example.com",
			"cognito_domain": "https://auth.example.com",
			"client_id":      "test-client-id",
		})
	}))
	defer srv.Close()

	dir := t.TempDir()
	cfg.TokenDir = dir

	if err := runInit(nil, []string{srv.URL}); err != nil {
		t.Fatal(err)
	}

	pc, err := loadPersistentConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if pc.APIBaseURL != "https://api.example.com" {
		t.Fatalf("expected api_url=https://api.example.com, got %s", pc.APIBaseURL)
	}
	if pc.CognitoDomain != "https://auth.example.com" {
		t.Fatalf("expected cognito_domain=https://auth.example.com, got %s", pc.CognitoDomain)
	}
	if pc.ClientID != "test-client-id" {
		t.Fatalf("expected client_id=test-client-id, got %s", pc.ClientID)
	}
}

func TestInitRejectsIncompleteConfig(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{
			"api_url": "https://api.example.com",
		})
	}))
	defer srv.Close()

	dir := t.TempDir()
	cfg.TokenDir = dir

	err := runInit(nil, []string{srv.URL})
	if err == nil {
		t.Fatal("expected error for incomplete config")
	}
}

func TestInitRejectsHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	dir := t.TempDir()
	cfg.TokenDir = dir

	err := runInit(nil, []string{srv.URL})
	if err == nil {
		t.Fatal("expected error for HTTP 404")
	}
}

func TestInitInteractiveMode(t *testing.T) {
	dir := t.TempDir()
	cfg.TokenDir = dir

	// Simulate stdin with piped input
	r, w, _ := os.Pipe()
	w.WriteString("https://api.example.com\nhttps://auth.example.com\nmy-client-id\n")
	w.Close()

	oldStdin := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = oldStdin }()

	if err := runInit(nil, []string{}); err != nil {
		t.Fatal(err)
	}

	pc, err := loadPersistentConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if pc.APIBaseURL != "https://api.example.com" {
		t.Fatalf("expected api_url=https://api.example.com, got %s", pc.APIBaseURL)
	}
	if pc.CognitoDomain != "https://auth.example.com" {
		t.Fatalf("expected cognito_domain=https://auth.example.com, got %s", pc.CognitoDomain)
	}
	if pc.ClientID != "my-client-id" {
		t.Fatalf("expected client_id=my-client-id, got %s", pc.ClientID)
	}
}
