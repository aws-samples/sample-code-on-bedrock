package cmd

import (
	"errors"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(logoutCmd)
}

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Delete stored tokens",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := runLogout(cfg.TokenDir); err != nil {
			return err
		}
		fmt.Println("Logged out successfully.")
		return nil
	},
}

func runLogout(tokenDir string) error {
	err := os.Remove(tokenFilePath(tokenDir))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	err = os.Remove(cachedCredsPath(tokenDir))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
