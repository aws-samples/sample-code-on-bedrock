package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStatusCallsUsageAndLimits(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "valid-token", RefreshToken: "ref"})

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/me/usage":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"day": map[string]interface{}{
					"costUsd": 2.50, "inputTokens": 1000, "outputTokens": 500,
				},
				"month": map[string]interface{}{
					"costUsd": 25.00, "inputTokens": 10000, "outputTokens": 5000,
				},
			})
		case "/me/limits":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"dailyUsd": 5.00, "monthlyUsd": 50.00, "blocked": false,
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer api.Close()

	out, err := runStatus(dir, api.URL)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(out, "2.50") {
		t.Fatal("output should contain daily cost")
	}
	if !strings.Contains(out, "25.00") {
		t.Fatal("output should contain monthly cost")
	}
	if !strings.Contains(out, "5.00") {
		t.Fatal("output should contain daily limit")
	}
	if !strings.Contains(out, "50.00") {
		t.Fatal("output should contain monthly limit")
	}
	if !strings.Contains(out, "false") && !strings.Contains(strings.ToLower(out), "no") {
		t.Fatal("output should contain blocked status")
	}
	// Remaining budget
	if !strings.Contains(out, "$2.50 daily") {
		t.Fatalf("output should contain remaining daily budget, got:\n%s", out)
	}
	if !strings.Contains(out, "$25.00 monthly") {
		t.Fatalf("output should contain remaining monthly budget, got:\n%s", out)
	}
}

func TestStatusShowsBlockedUser(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "valid-token", RefreshToken: "ref"})

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/me/usage":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"day":   map[string]interface{}{"costUsd": 0, "inputTokens": 0, "outputTokens": 0},
				"month": map[string]interface{}{"costUsd": 55.00, "inputTokens": 20000, "outputTokens": 10000},
			})
		case "/me/limits":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"dailyUsd": 5.00, "monthlyUsd": 50.00, "blocked": true,
			})
		}
	}))
	defer api.Close()

	out, err := runStatus(dir, api.URL)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(out, "true") && !strings.Contains(strings.ToUpper(out), "YES") && !strings.Contains(strings.ToUpper(out), "BLOCKED") {
		t.Fatal("output should indicate user is blocked")
	}
}

func TestStatusShowsWarningAt80Percent(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "valid-token", RefreshToken: "ref"})

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/me/usage":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"day":   map[string]interface{}{"costUsd": 4.50, "inputTokens": 2000, "outputTokens": 1000},
				"month": map[string]interface{}{"costUsd": 42.00, "inputTokens": 20000, "outputTokens": 10000},
			})
		case "/me/limits":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"dailyUsd": 5.00, "monthlyUsd": 50.00, "blocked": false,
			})
		}
	}))
	defer api.Close()

	out, err := runStatus(dir, api.URL)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(out, "Daily budget above 80%") {
		t.Fatalf("output should contain daily warning indicator, got:\n%s", out)
	}
	if !strings.Contains(out, "Monthly budget above 80%") {
		t.Fatalf("output should contain monthly warning indicator, got:\n%s", out)
	}
}

func TestCredsDisplaysStructured403(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "blocked-token", RefreshToken: "ref"})

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{
			"message":      "User is blocked — monthly budget exceeded",
			"resetTime":    "Monthly budgets reset on the 1st at 00:00 UTC",
			"adminContact": "Contact your admin to request an unblock or budget increase",
		})
	}))
	defer api.Close()

	_, err := runCreds(dir, api.URL)
	if err == nil {
		t.Fatal("expected error for 403, got nil")
	}
	errMsg := err.Error()
	if !strings.Contains(errMsg, "monthly budget exceeded") {
		t.Fatalf("error should contain message, got: %s", errMsg)
	}
	if !strings.Contains(errMsg, "Reset:") {
		t.Fatalf("error should contain reset info, got: %s", errMsg)
	}
	if !strings.Contains(errMsg, "Contact your admin") {
		t.Fatalf("error should contain admin contact, got: %s", errMsg)
	}
}
