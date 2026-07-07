package cmd

import "github.com/spf13/cobra"

var rootCmd = &cobra.Command{
	Use:   "codeonbedrock",
	Short: "CLI helper for Bedrock credential vending",
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		pc, err := loadPersistentConfig(cfg.TokenDir)
		if err != nil {
			return
		}
		if cfg.APIBaseURL == "" {
			cfg.APIBaseURL = pc.APIBaseURL
		}
		if cfg.CognitoDomain == "" {
			cfg.CognitoDomain = pc.CognitoDomain
		}
		if cfg.ClientID == "" {
			cfg.ClientID = pc.ClientID
		}
	},
}

// Config holds runtime settings loaded from env or flags.
type Config struct {
	APIBaseURL   string
	CognitoDomain string
	ClientID     string
	CallbackPort int
	TokenDir     string
}

var cfg Config

func init() {
	rootCmd.PersistentFlags().StringVar(&cfg.APIBaseURL, "api-url", "", "API base URL")
	rootCmd.PersistentFlags().StringVar(&cfg.CognitoDomain, "cognito-domain", "", "Cognito hosted UI domain URL")
	rootCmd.PersistentFlags().StringVar(&cfg.ClientID, "client-id", "", "Cognito app client ID")
	rootCmd.PersistentFlags().IntVar(&cfg.CallbackPort, "callback-port", 8787, "Local callback port")
	rootCmd.PersistentFlags().StringVar(&cfg.TokenDir, "token-dir", "", "Token storage directory (default ~/.codeonbedrock)")
}

func Execute() error {
	return rootCmd.Execute()
}
