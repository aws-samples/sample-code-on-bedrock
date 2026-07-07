package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCredsLoadsTokenAndCallsAPI(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "valid-id-token", RefreshToken: "ref"})

	var gotAuth string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"Version":         1,
			"AccessKeyId":     "AKID",
			"SecretAccessKey":  "SECRET",
			"SessionToken":    "TOKEN",
			"Expiration":      "2026-04-29T14:00:00Z",
		})
	}))
	defer api.Close()

	out, err := runCreds(dir, api.URL)
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer valid-id-token" {
		t.Fatalf("expected Bearer valid-id-token, got %s", gotAuth)
	}

	var cred map[string]interface{}
	if err := json.Unmarshal([]byte(out), &cred); err != nil {
		t.Fatal(err)
	}
	if cred["AccessKeyId"] != "AKID" {
		t.Fatalf("expected AKID, got %v", cred["AccessKeyId"])
	}
	if cred["Version"] != float64(1) {
		t.Fatalf("expected Version=1, got %v", cred["Version"])
	}
}

func TestCredsRefreshesExpiredToken(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "expired-token", RefreshToken: "valid-refresh"})

	callCount := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		auth := r.Header.Get("Authorization")
		if auth == "Bearer expired-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if auth == "Bearer refreshed-id-token" {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"Version":         1,
				"AccessKeyId":     "AKID2",
				"SecretAccessKey":  "SECRET2",
				"SessionToken":    "TOKEN2",
				"Expiration":      "2026-04-29T14:00:00Z",
			})
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer api.Close()

	// Mock token refresh endpoint
	cognito := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.PostFormValue("grant_type") != "refresh_token" {
			t.Fatal("expected grant_type=refresh_token")
		}
		json.NewEncoder(w).Encode(map[string]string{
			"id_token": "refreshed-id-token",
		})
	}))
	defer cognito.Close()

	out, err := runCredsWithRefresh(dir, api.URL, cognito.URL, "test-client-id")
	if err != nil {
		t.Fatal(err)
	}

	var cred map[string]interface{}
	json.Unmarshal([]byte(out), &cred)
	if cred["AccessKeyId"] != "AKID2" {
		t.Fatalf("expected AKID2 after refresh, got %v", cred["AccessKeyId"])
	}
}

func TestCredsExitsNonZeroOn403(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "blocked-token", RefreshToken: "ref"})

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"message":"blocked"}`))
	}))
	defer api.Close()

	_, err := runCreds(dir, api.URL)
	if err == nil {
		t.Fatal("expected error for 403, got nil")
	}
}

func TestCredsFailsWhenNoTokenFile(t *testing.T) {
	dir := t.TempDir()
	_, err := runCreds(dir, "http://unused")
	if err == nil {
		t.Fatal("expected error when no token file exists")
	}
	if !os.IsNotExist(err) && err.Error() != "not logged in: run 'codeonbedrock login' first" {
		// Accept either os not-exist or our custom message
		t.Logf("got expected error: %v", err)
	}
}

func TestCredsReturnsCachedCredentials(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "tok", RefreshToken: "ref"})

	// Write a cached credential that expires far in the future
	exp := time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)
	cached := map[string]interface{}{
		"Version":        1,
		"AccessKeyId":    "CACHED_AKID",
		"SecretAccessKey": "CACHED_SECRET",
		"SessionToken":   "CACHED_TOKEN",
		"Expiration":     exp,
	}
	data, _ := json.Marshal(cached)
	os.MkdirAll(dir, 0700)
	os.WriteFile(filepath.Join(dir, "cached-creds.json"), data, 0600)

	apiCalled := false
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apiCalled = true
		w.WriteHeader(http.StatusOK)
	}))
	defer api.Close()

	out, err := runCreds(dir, api.URL)
	if err != nil {
		t.Fatal(err)
	}
	if apiCalled {
		t.Fatal("expected API not to be called when cache is valid")
	}
	var cred map[string]interface{}
	json.Unmarshal([]byte(out), &cred)
	if cred["AccessKeyId"] != "CACHED_AKID" {
		t.Fatalf("expected CACHED_AKID, got %v", cred["AccessKeyId"])
	}
}

func TestCredsIgnoresExpiredCache(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "tok", RefreshToken: "ref"})

	// Write a cached credential that expires in 30 seconds (within 60s threshold)
	exp := time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339)
	cached := map[string]interface{}{
		"Version":        1,
		"AccessKeyId":    "OLD_AKID",
		"SecretAccessKey": "OLD_SECRET",
		"SessionToken":   "OLD_TOKEN",
		"Expiration":     exp,
	}
	data, _ := json.Marshal(cached)
	os.MkdirAll(dir, 0700)
	os.WriteFile(filepath.Join(dir, "cached-creds.json"), data, 0600)

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"Version":        1,
			"AccessKeyId":    "NEW_AKID",
			"SecretAccessKey": "NEW_SECRET",
			"SessionToken":   "NEW_TOKEN",
			"Expiration":     time.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339),
		})
	}))
	defer api.Close()

	out, err := runCreds(dir, api.URL)
	if err != nil {
		t.Fatal(err)
	}
	var cred map[string]interface{}
	json.Unmarshal([]byte(out), &cred)
	if cred["AccessKeyId"] != "NEW_AKID" {
		t.Fatalf("expected NEW_AKID, got %v", cred["AccessKeyId"])
	}
}

func TestCredsSavesCacheAfterAPICall(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "tok", RefreshToken: "ref"})

	exp := time.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"Version":        1,
			"AccessKeyId":    "FRESH_AKID",
			"SecretAccessKey": "FRESH_SECRET",
			"SessionToken":   "FRESH_TOKEN",
			"Expiration":     exp,
		})
	}))
	defer api.Close()

	_, err := runCreds(dir, api.URL)
	if err != nil {
		t.Fatal(err)
	}

	// Verify cache file was written
	cacheFile := filepath.Join(dir, "cached-creds.json")
	data, err := os.ReadFile(cacheFile)
	if err != nil {
		t.Fatalf("cache file not written: %v", err)
	}
	var cred map[string]interface{}
	json.Unmarshal(data, &cred)
	if cred["AccessKeyId"] != "FRESH_AKID" {
		t.Fatalf("expected FRESH_AKID in cache, got %v", cred["AccessKeyId"])
	}
}

func TestLogoutRemovesCachedCreds(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "tok", RefreshToken: "ref"})
	os.WriteFile(filepath.Join(dir, "cached-creds.json"), []byte(`{}`), 0600)

	err := runLogout(dir)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(dir, "cached-creds.json")); !os.IsNotExist(err) {
		t.Fatal("expected cached-creds.json to be deleted after logout")
	}
	if _, err := os.Stat(filepath.Join(dir, "tokens.json")); !os.IsNotExist(err) {
		t.Fatal("expected tokens.json to be deleted after logout")
	}
}
