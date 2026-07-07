package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(statusCmd)
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show current usage, limits, and blocked status",
	RunE: func(cmd *cobra.Command, args []string) error {
		out, err := runStatus(cfg.TokenDir, cfg.APIBaseURL)
		if err != nil {
			return err
		}
		fmt.Print(out)
		return nil
	},
}

type usageData struct {
	Day   periodData `json:"day"`
	Month periodData `json:"month"`
}

type periodData struct {
	CostUsd      float64 `json:"costUsd"`
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`
}

type limitsData struct {
	DailyUsd   float64 `json:"dailyUsd"`
	MonthlyUsd float64 `json:"monthlyUsd"`
	Blocked    bool    `json:"blocked"`
}

func runStatus(tokenDir, apiURL string) (string, error) {
	tokens, err := loadTokens(tokenDir)
	if err != nil {
		return "", fmt.Errorf("not logged in: run 'codeonbedrock login' first")
	}

	usage, err := apiGet(apiURL, "/me/usage", tokens.IDToken)
	if err != nil {
		return "", fmt.Errorf("failed to get usage: %w", err)
	}
	limits, err := apiGet(apiURL, "/me/limits", tokens.IDToken)
	if err != nil {
		return "", fmt.Errorf("failed to get limits: %w", err)
	}

	var u usageData
	json.Unmarshal(usage, &u)
	var l limitsData
	json.Unmarshal(limits, &l)

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("%-20s %s\n", "Blocked:", fmt.Sprintf("%v", l.Blocked)))
	sb.WriteString(fmt.Sprintf("\n%-20s %-15s %-15s\n", "", "Today", "This Month"))
	sb.WriteString(fmt.Sprintf("%-20s %-15s %-15s\n", "Cost (USD):", fmt.Sprintf("%.2f", u.Day.CostUsd), fmt.Sprintf("%.2f", u.Month.CostUsd)))
	sb.WriteString(fmt.Sprintf("%-20s %-15d %-15d\n", "Input Tokens:", u.Day.InputTokens, u.Month.InputTokens))
	sb.WriteString(fmt.Sprintf("%-20s %-15d %-15d\n", "Output Tokens:", u.Day.OutputTokens, u.Month.OutputTokens))
	sb.WriteString(fmt.Sprintf("\n%-20s %.2f\n", "Daily Limit:", l.DailyUsd))
	sb.WriteString(fmt.Sprintf("%-20s %.2f\n", "Monthly Limit:", l.MonthlyUsd))

	// Remaining budget
	dailyRemaining := l.DailyUsd - u.Day.CostUsd
	monthlyRemaining := l.MonthlyUsd - u.Month.CostUsd
	if dailyRemaining < 0 {
		dailyRemaining = 0
	}
	if monthlyRemaining < 0 {
		monthlyRemaining = 0
	}
	sb.WriteString(fmt.Sprintf("\n%-20s %-15s %-15s\n", "Remaining:", fmt.Sprintf("$%.2f daily", dailyRemaining), fmt.Sprintf("$%.2f monthly", monthlyRemaining)))

	// Warning indicators at 80%
	if l.DailyUsd > 0 && u.Day.CostUsd >= l.DailyUsd*0.8 {
		sb.WriteString("⚠️  Daily budget above 80%\n")
	}
	if l.MonthlyUsd > 0 && u.Month.CostUsd >= l.MonthlyUsd*0.8 {
		sb.WriteString("⚠️  Monthly budget above 80%\n")
	}

	return sb.String(), nil
}

func apiGet(baseURL, path, idToken string) ([]byte, error) {
	req, _ := http.NewRequest("GET", strings.TrimRight(baseURL, "/")+path, nil)
	req.Header.Set("Authorization", "Bearer "+idToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API returned %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}
