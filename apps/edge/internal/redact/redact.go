// Package redact removes secrets and personal data from text before it is written to the local
// integration log or included (as a sanitized error) in a report to the Control Plane.
package redact

import (
	"regexp"
	"unicode/utf8"
)

var rules = []struct {
	re   *regexp.Regexp
	repl string
}{
	{regexp.MustCompile(`(?i)(https?://)[^/\s:@]+:[^/\s@]+@`), "${1}[REDACTED]@"},
	{regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`), "${1} [REDACTED]"},
	{regexp.MustCompile(`(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|client[_-]?secret)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+`), "${1}${2}[REDACTED]"},
	{regexp.MustCompile(`psacc_enr_[A-Za-z0-9_-]+`), "psacc_enr_[REDACTED]"},
	{regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`), "[EMAIL]"},
	{regexp.MustCompile(`\b[A-Fa-f0-9]{32,}\b`), "[HEX]"},
	{regexp.MustCompile(`\b[A-Za-z0-9+/_-]{40,}={0,2}`), "[BASE64]"},
}

// Text redacts s and limits it to max runes.
func Text(s string, max int) string {
	for _, r := range rules {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	if utf8.RuneCountInString(s) > max {
		runes := []rune(s)
		s = string(runes[:max-1]) + "…"
	}
	return s
}
