package cmd

import (
	"os"
	"testing"
)

func TestLogoutDeletesTokenFile(t *testing.T) {
	dir := t.TempDir()
	saveTokens(dir, &Tokens{IDToken: "tok", RefreshToken: "ref"})

	// Verify file exists
	if _, err := os.Stat(tokenFilePath(dir)); err != nil {
		t.Fatal("token file should exist before logout")
	}

	if err := runLogout(dir); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(tokenFilePath(dir)); !os.IsNotExist(err) {
		t.Fatal("token file should be deleted after logout")
	}
}

func TestLogoutNoErrorWhenNoTokenFile(t *testing.T) {
	dir := t.TempDir()
	// Should not error when file doesn't exist
	if err := runLogout(dir); err != nil {
		t.Fatalf("logout should not error when no token file: %v", err)
	}
}
