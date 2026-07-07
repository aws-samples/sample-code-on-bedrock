package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(initCmd)
}

var initCmd = &cobra.Command{
	Use:   "init [config-url]",
	Short: "Configure the CLI for first use",
	Long: `Configure the CLI by fetching config from a URL or entering values interactively.

Usage:
  codeonbedrock init https://<cloudfront>/config.json
  codeonbedrock init   (interactive mode)`,
	Args: cobra.MaximumNArgs(1),
	RunE: runInit,
}

// httpGet is a package-level variable for testability.
var httpGet = http.Get

func runInit(cmd *cobra.Command, args []string) error {
	var pc PersistentConfig

	if len(args) == 1 {
		// Fetch config from URL
		fetched, err := fetchConfig(args[0])
		if err != nil {
			return fmt.Errorf("failed to fetch config: %w", err)
		}
		pc = *fetched
	} else {
		// Interactive mode
		reader := bufio.NewReader(os.Stdin)
		fmt.Print("API URL: ")
		apiURL, _ := reader.ReadString('\n')
		pc.APIBaseURL = strings.TrimSpace(apiURL)

		fmt.Print("Cognito Domain: ")
		domain, _ := reader.ReadString('\n')
		pc.CognitoDomain = strings.TrimSpace(domain)

		fmt.Print("Client ID: ")
		clientID, _ := reader.ReadString('\n')
		pc.ClientID = strings.TrimSpace(clientID)
	}

	if err := savePersistentConfig(cfg.TokenDir, &pc); err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}

	fmt.Println("Configuration saved. Run 'codeonbedrock login' to authenticate.")
	return nil
}

func fetchConfig(url string) (*PersistentConfig, error) {
	resp, err := httpGet(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	var pc PersistentConfig
	if err := json.NewDecoder(resp.Body).Decode(&pc); err != nil {
		return nil, err
	}

	if pc.APIBaseURL == "" || pc.CognitoDomain == "" || pc.ClientID == "" {
		return nil, fmt.Errorf("config.json missing required fields (api_url, cognito_domain, client_id)")
	}
	return &pc, nil
}
